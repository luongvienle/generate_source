import { UnrecoverableError, type Job } from 'bullmq';
import type { PrismaClient } from '@knowledge-explorer/database';
import { loadPublishChecklistInput } from '@knowledge-explorer/database';
import {
  errorCodes,
  revalidateLearnerPages,
  type PublishCourseJobData,
} from '@knowledge-explorer/shared';
import { evaluatePublishChecklist } from '@knowledge-explorer/content';
import { resolveCourseVoice } from '@knowledge-explorer/ai';
import { buildStructurePayload, type SnapshotChapterRow } from './snapshot';

/**
 * FR-PUB-02: copy the draft track into the published track and rebuild §4.3's
 * snapshot.
 *
 * THE CHECKLIST RUNS AGAIN HERE, AND THIS IS THE AUTHORITATIVE RUN. The API
 * checked it before enqueueing so the owner gets an immediate 422, but a lesson
 * edited between that 202 and this run must not reach learners unchecked. The
 * re-check happens OUTSIDE any transaction, along with every other read, so the
 * transaction below contains writes only — a forty-lesson copy sharing a
 * transaction with two hundred read queries is how an interactive-transaction
 * timeout is earned.
 *
 * THE WRITE IS ALL OR NOTHING, like P4's and P5's runs. A partially published
 * course is the one outcome §4.3 forbids: learners must never see half-edited
 * content, and progress must never break.
 *
 * WHAT THROWS AND WHAT DOES NOT, following P4 and P5:
 *   - a checklist that no longer passes throws UnrecoverableError, because the
 *     same prompt-free re-read will not start passing three seconds later;
 *   - a transport or database error propagates as an ordinary Error, so NFR-03's
 *     three attempts with exponential backoff apply.
 *
 * THE LOCK IS RESTORED ONLY ON A TERMINAL PATH. `publication_status` is the
 * in-flight lock and R-01 honours it, so clearing it between retries would
 * unlock the course while a retry was still pending and let an admin edit rows
 * the next attempt is about to copy. It is restored on an unrecoverable failure
 * and on the last attempt, which is exactly P5's `markFailed` rule.
 */

/**
 * Prisma's interactive transactions default to a 5 s ceiling. A course of a few
 * hundred lessons is a few hundred small updates plus one upsert; 30 s is room
 * for that without being an invitation to put reads back inside.
 */
const PUBLISH_TRANSACTION_TIMEOUT_MS = 30_000;
const PUBLISH_TRANSACTION_MAX_WAIT_MS = 10_000;

interface StoredBlock {
  readonly blockType: string;
}

const figureCountOf = (draftBlockList: unknown): number => {
  const blocks = (draftBlockList as { blocks?: readonly StoredBlock[] } | null)?.blocks;
  return Array.isArray(blocks) ? blocks.filter((block) => block.blockType === 'figure').length : 0;
};

export function createPublishProcessor(prisma: PrismaClient): (job: Job) => Promise<unknown> {
  return async (job: Job) => {
    const data = job.data as PublishCourseJobData;
    const { courseId, createdByUserId, previousStatus } = data;

    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    /**
     * Releases the `publishing` lock back to where the course came from.
     *
     * NEVER THROWS. It runs on the failure path, and the course may be exactly
     * what went missing — restoring a deleted course throws P2025, which would
     * replace the real reason on the generation_jobs row with a Prisma stack and
     * leave whoever reads it no idea what happened.
     */
    const restoreLock = async (): Promise<void> => {
      try {
        await prisma.course.update({
          where: { id: courseId },
          data: { publicationStatus: previousStatus, updatedAt: new Date() },
        });
      } catch {
        // Nothing to restore, or nothing that can be. The original error wins.
      }
    };

    try {
      const course = await prisma.course.findUnique({
        where: { id: courseId },
        // slug and the category's slug feed NFR-01's revalidation hook below.
        select: {
          id: true,
          slug: true,
          voiceIdentifier: true,
          voiceProviderName: true,
          category: { select: { slug: true } },
        },
      });
      if (!course) {
        throw new UnrecoverableError(`publish: course ${courseId} no longer exists`);
      }

      const { voiceIdentifier } = resolveCourseVoice(course);
      const input = await loadPublishChecklistInput(prisma, courseId, voiceIdentifier);
      if (!input) {
        throw new UnrecoverableError(`publish: course ${courseId} no longer exists`);
      }

      const checklist = evaluatePublishChecklist(input);
      if (!checklist.passed) {
        const failed = checklist.items.filter((item) => !item.passed);
        throw new UnrecoverableError(
          `${errorCodes.PUBLISH_CHECKLIST_FAILED}: ${failed
            .map((item) => `${item.id} — ${item.reason}`)
            .join('; ')}`,
        );
      }

      // §4.3: soft-deleted rows stay in the PREVIOUS snapshot and are excluded
      // from this one, which needs no code beyond these two filters.
      const chapters = await prisma.chapter.findMany({
        where: { courseId, deletedAt: null },
        orderBy: { chapterOrder: 'asc' },
        select: {
          id: true,
          chapterOrder: true,
          title: true,
          description: true,
          lessons: {
            where: { deletedAt: null },
            orderBy: { lessonOrder: 'asc' },
            select: {
              id: true,
              lessonOrder: true,
              title: true,
              estimatedMinutes: true,
              isFreePreview: true,
              content: { select: { draftContentMarkdown: true, draftBlockList: true } },
              audios: {
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: { totalDurationSeconds: true },
              },
            },
          },
        },
      });

      const previous = await prisma.publishedCourseStructure.findUnique({
        where: { courseId },
        select: { publishedVersionNumber: true },
      });
      /**
       * FR-PUB-02 increments on every successful publish, including one that
       * changes nothing. "Idempotent" is read as: re-running after a crash
       * converges on the same published CONTENT, writes no duplicate rows and
       * corrupts nothing. The number counts publish events, which is what makes
       * it an audit trail of when the owner published.
       */
      const publishedVersionNumber = (previous?.publishedVersionNumber ?? 0) + 1;

      const snapshotChapters: SnapshotChapterRow[] = chapters.map((chapter) => ({
        id: chapter.id,
        chapterOrder: chapter.chapterOrder,
        title: chapter.title,
        description: chapter.description,
        lessons: chapter.lessons.map((lesson) => ({
          id: lesson.id,
          lessonOrder: lesson.lessonOrder,
          title: lesson.title,
          estimatedMinutes: lesson.estimatedMinutes,
          isFreePreview: lesson.isFreePreview,
          audio: lesson.audios[0] ?? null,
          figureCount: figureCountOf(lesson.content?.draftBlockList ?? null),
        })),
      }));

      const payload = buildStructurePayload({
        courseId,
        publishedVersionNumber,
        chapters: snapshotChapters,
      });
      const lessons = chapters.flatMap((chapter) => chapter.lessons);
      const publishedAt = new Date();

      await prisma.$transaction(
        async (tx) => {
          for (const lesson of lessons) {
            await tx.lessonContent.update({
              where: { lessonId: lesson.id },
              data: {
                publishedContentMarkdown: lesson.content?.draftContentMarkdown ?? null,
                publishedBlockList: (lesson.content?.draftBlockList ?? null) as never,
                publishedAt,
              },
            });
          }

          /**
           * §4.2's lesson machine reaches `published` here, and only here. The
           * draft-save path already writes `drafting`, so the next edit reverts
           * it with no extra code; `ready` stays unreachable, which P6 records
           * as a decision rather than an oversight.
           */
          await tx.lesson.updateMany({
            where: { id: { in: lessons.map((lesson) => lesson.id) } },
            data: { contentStatus: 'published' },
          });

          await tx.publishedCourseStructure.upsert({
            where: { courseId },
            create: {
              courseId,
              structurePayload: payload as never,
              totalLessonCount: payload.totalLessonCount,
              publishedVersionNumber,
              publishedByUserId: createdByUserId,
              publishedAt,
            },
            update: {
              structurePayload: payload as never,
              totalLessonCount: payload.totalLessonCount,
              publishedVersionNumber,
              publishedByUserId: createdByUserId,
              publishedAt,
            },
          });

          await tx.course.update({
            where: { id: courseId },
            data: {
              publicationStatus: 'published',
              publishedAt,
              hasUnpublishedChanges: false,
              updatedAt: publishedAt,
            },
          });
        },
        {
          timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
          maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
        },
      );

      /**
       * NFR-01: the seam P6 left open. Fired AFTER the transaction commits, so
       * the pages learner-web rebuilds read the course as published.
       *
       * Deliberately not awaited into the job's success: the return value is
       * ignored and `revalidateLearnerPages` swallows every failure, because
       * the publish is already durable. A cache that is briefly stale is a
       * delay; a publish reported as failed after it committed is a lie, and
       * would be retried into a second publish.
       */
      await revalidateLearnerPages({
        courseSlug: course.slug,
        categorySlug: course.category.slug,
      });

      return {
        courseId,
        publishedVersionNumber,
        totalLessonCount: payload.totalLessonCount,
      };
    } catch (error) {
      if (error instanceof UnrecoverableError || isFinalAttempt) {
        await restoreLock();
      }
      throw error;
    }
  };
}
