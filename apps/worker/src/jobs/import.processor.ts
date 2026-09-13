import type { Job } from 'bullmq';
import {
  buildImportPlan,
  type ImportPayload,
  type ImportPlan,
} from '@knowledge-explorer/content';
import {
  markUnpublishedChangesForCourse,
  parkChapterOrders,
  parkLessonOrders,
  type PrismaClient,
} from '@knowledge-explorer/database';
import { loadExistingTree } from './existing-tree';

export interface ImportJobData {
  readonly payload: ImportPayload;
  readonly generationJobId: string;
  readonly importedByUserId: string | null;
}

/**
 * Deliberately the same shape the dry run reports, plus what only applying can
 * know. One shape means the preview and the applied result render through the
 * same component instead of two that can disagree.
 */
export interface ImportResult {
  readonly category: ImportPlan['category'];
  readonly course: ImportPlan['course'];
  readonly counts: ImportPlan['counts'];
  readonly conflicts: ImportPlan['conflicts'];
  readonly courseId: string;
  readonly hasUnpublishedChanges: boolean;
}

/**
 * Applies a §9.1 outline. FR-IMP-01, FR-IMP-02.
 *
 * Everything happens in ONE transaction, so a failed attempt leaves the
 * curriculum tree exactly as it was and NFR-03's retry is a clean re-run.
 *
 * The plan is rebuilt here rather than carried over from the dry run: the gate
 * is client-side, the database may have changed since the preview, and
 * buildImportPlan is cheap. That the two agree is guaranteed by both calling the
 * same pure function, not by passing its output around.
 *
 * Order of work inside the transaction is load-bearing. Existing rows are parked
 * in a negative range before anything is written into the positive one, because
 * §8's ordering indexes are checked per row and cannot be deferred — see
 * packages/database/src/ordering.ts.
 */
export function createImportProcessor(prisma: PrismaClient) {
  return async (job: Job): Promise<ImportResult> => {
    const { payload, importedByUserId } = job.data as ImportJobData;

    return prisma.$transaction(async (tx) => {
      const existing = await loadExistingTree(tx, payload);
      const plan = buildImportPlan(existing, payload);

      const levelOrderTaken = plan.conflicts.some((c) => c.kind === 'level_order_taken');
      if (levelOrderTaken && plan.course.action === 'create') {
        // §8's UNIQUE (category_id, level_order) makes this impossible to apply.
        // Reporting it as a conflict and carrying on would mean inventing a
        // different levelOrder, which silently misfiles the course.
        throw new Error(
          `levelOrder ${payload.course.levelOrder} is already held by another course in ` +
            `category "${payload.category.slug}"; change it or move the other course first`,
        );
      }

      const category = await tx.category.findUniqueOrThrow({
        where: { slug: payload.category.slug },
        select: { id: true },
      });

      const courseFields = {
        title: payload.course.title,
        levelLabel: payload.course.levelLabel,
        overviewSummary: payload.course.overviewSummary ?? null,
        prerequisites: payload.course.prerequisites,
        learningObjectives: payload.course.learningObjectives,
        estimatedTotalMinutes: payload.course.estimatedTotalMinutes ?? null,
        languageCode: payload.course.languageCode,
        updatedAt: new Date(),
      };

      const course = await tx.course.upsert({
        where: { slug: plan.course.slug },
        create: {
          ...courseFields,
          slug: plan.course.slug,
          categoryId: category.id,
          levelOrder: payload.course.levelOrder,
          importedByUserId,
        },
        // When another course holds the slot, keep the existing levelOrder rather
        // than failing the whole import over one field.
        update: levelOrderTaken ? courseFields : { ...courseFields, levelOrder: payload.course.levelOrder },
        select: { id: true, publicationStatus: true },
      });

      // Soft-delete before parking, for two reasons: it frees the order slots the
      // survivors may want, and it leaves the deleted rows holding the order they
      // had rather than a parked negative that means nothing to a later reader.
      const deletedAt = new Date();
      for (const entry of plan.chapters) {
        if (entry.action === 'delete') {
          await tx.chapter.update({ where: { id: entry.id! }, data: { deletedAt } });
        }
      }
      for (const entry of plan.lessons) {
        if (entry.action === 'delete') {
          await tx.lesson.update({ where: { id: entry.id! }, data: { deletedAt } });
        }
      }

      await parkChapterOrders(tx, course.id);

      const chapterIdByKey = new Map<string, string>();

      for (const entry of plan.chapters) {
        if (entry.action === 'delete') continue;
        if (entry.action === 'create') {
          const created = await tx.chapter.create({
            data: {
              courseId: course.id,
              chapterOrder: entry.chapterOrder,
              title: entry.title,
              description: entry.description,
            },
            select: { id: true },
          });
          chapterIdByKey.set(entry.key, created.id);
          continue;
        }
        // update and unchanged both need the order written back out of the
        // parked negative range.
        await tx.chapter.update({
          where: { id: entry.id! },
          data: {
            chapterOrder: entry.chapterOrder,
            title: entry.title,
            description: entry.description,
          },
        });
        chapterIdByKey.set(entry.key, entry.id!);
      }

      await parkLessonOrders(tx, [...chapterIdByKey.values()]);

      for (const entry of plan.lessons) {
        if (entry.action === 'delete') continue;

        const chapterId = chapterIdByKey.get(entry.chapterKey);
        if (!chapterId) continue;

        if (entry.action === 'create') {
          // FR-IMP-01: the skeleton only. contentStatus defaults to 'empty' and
          // no lesson_contents row is created.
          await tx.lesson.create({
            data: {
              chapterId,
              lessonOrder: entry.lessonOrder,
              title: entry.title,
              learningObjective: entry.learningObjective,
              keyPoints: [...entry.keyPoints],
              estimatedMinutes: entry.estimatedMinutes,
            },
          });
          continue;
        }

        await tx.lesson.update({
          where: { id: entry.id! },
          data: {
            chapterId,
            lessonOrder: entry.lessonOrder,
            title: entry.title,
            learningObjective: entry.learningObjective,
            keyPoints: [...entry.keyPoints],
            estimatedMinutes: entry.estimatedMinutes,
          },
        });
      }

      // §4.3: learners keep seeing the last published snapshot until a republish,
      // so a re-import of a published course only flags that the two now differ.
      // The `published` test lives in the helper's WHERE clause since P6; this
      // local copy stays only because the return value reports it.
      const hasUnpublishedChanges = course.publicationStatus === 'published';
      await markUnpublishedChangesForCourse(tx, course.id);

      return {
        category: plan.category,
        course: plan.course,
        counts: plan.counts,
        conflicts: plan.conflicts,
        courseId: course.id,
        hasUnpublishedChanges,
      };
    });
  };
}
