import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { blockListChecksum, type Block } from '@knowledge-explorer/content';
import {
  errorCodes,
  snapshotChapterSchema,
  structurePayloadSchema,
  type SnapshotLesson,
} from '@knowledge-explorer/shared';
import { OBJECT_STORAGE, PRESIGN_EXPIRY_SECONDS, type ObjectStorage } from '@knowledge-explorer/storage';
import { PrismaService } from '../prisma/prisma.service';
import { readBlockList } from '../content/lesson-content.service';

/**
 * §9.4's `GET /lessons/:lessonId`: the published track, and only the published
 * track.
 *
 * NOTHING HERE SELECTS A DRAFT COLUMN. §4.3's guarantee — "learners must never
 * see half-edited content" — is a property of which columns this file names, so
 * `draft_content_markdown`, `draft_block_list` and `draft_content_checksum`
 * appear nowhere in it. The one apparent exception is the audio gate below,
 * which reads a checksum WRITTEN from the draft track but compares it against
 * the published block list; see `resolveAudio`.
 */

/** What the reader renders. Mirrors `FigureImages`, keyed by blockId. */
export interface FigureImageView {
  readonly url: string;
  readonly captionText: string;
  readonly alternativeText: string;
}

export interface ReaderSegmentView {
  readonly blockId: string;
  readonly segmentOrder: number;
  readonly startMillisecond: number;
  readonly endMillisecond: number;
}

export interface ReaderAudioView {
  /** The `lesson_audios.id` the player mints a signed URL against. */
  readonly mediaId: string;
  readonly totalDurationSeconds: number | null;
  readonly segments: readonly ReaderSegmentView[];
}

export interface ReaderNeighbour {
  readonly lessonId: string;
  readonly title: string;
}

export interface LessonReadView {
  readonly lessonId: string;
  readonly title: string;
  readonly courseSlug: string;
  readonly courseTitle: string;
  readonly chapterTitle: string;
  readonly blocks: readonly Block[];
  readonly figureImages: Readonly<Record<string, FigureImageView>>;
  readonly audio: ReaderAudioView | null;
  readonly previous: ReaderNeighbour | null;
  readonly next: ReaderNeighbour | null;
  readonly isFreePreview: boolean;
}

/** The course facts a paywall needs, and nothing a paywall does not. */
export interface PaywallView {
  readonly courseSlug: string;
  readonly courseTitle: string;
}

@Injectable()
export class ReaderService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * The course a lesson belongs to, for the 403 body.
   *
   * Loaded before the entitlement check rather than after, because a refusal
   * that cannot name the course is a paywall with no call to action.
   */
  async paywallFor(lessonId: string): Promise<PaywallView> {
    const lesson = await this.prisma.client.lesson.findUnique({
      where: { id: lessonId },
      select: { chapter: { select: { course: { select: { slug: true, title: true } } } } },
    });
    if (!lesson) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
    return { courseSlug: lesson.chapter.course.slug, courseTitle: lesson.chapter.course.title };
  }

  async read(lessonId: string): Promise<LessonReadView> {
    const lesson = await this.prisma.client.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        title: true,
        isFreePreview: true,
        deletedAt: true,
        content: { select: { publishedBlockList: true } },
        chapter: {
          select: {
            title: true,
            deletedAt: true,
            course: { select: { id: true, slug: true, title: true, publicationStatus: true } },
          },
        },
      },
    });

    // A lesson whose course is not published has no published track to serve,
    // and a soft-deleted one was removed even though §4.3 keeps it listed in the
    // last snapshot. Both are 404 rather than 403: neither is an entitlement
    // question, and neither should confirm the row exists.
    if (!lesson || lesson.deletedAt || lesson.chapter.deletedAt) {
      throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
    }
    if (lesson.chapter.course.publicationStatus !== 'published') {
      throw new NotFoundException({ errorCode: errorCodes.COURSE_NOT_PUBLISHED });
    }

    const publishedBlockList = readBlockList(lesson.content?.publishedBlockList);
    const blocks = publishedBlockList.blocks;

    const [figureImages, audio, neighbours] = await Promise.all([
      this.resolveFigureImages(lesson.id, blocks),
      this.resolveAudio(lesson.id, publishedBlockList),
      this.resolveNeighbours(lesson.chapter.course.id, lesson.id),
    ]);

    return {
      lessonId: lesson.id,
      title: lesson.title,
      courseSlug: lesson.chapter.course.slug,
      courseTitle: lesson.chapter.course.title,
      chapterTitle: lesson.chapter.title,
      blocks,
      figureImages,
      audio,
      previous: neighbours.previous,
      next: neighbours.next,
      isFreePreview: lesson.isFreePreview,
    };
  }

  /**
   * FR-IMG-03's selected image per figure block, presigned.
   *
   * `lesson_images.image_file_url` stores an OBJECT KEY, not a URL — rendering
   * it into an `<img src>` produces a broken figure. Presigning goes through
   * `ObjectStorage.presignGet`, which signs against `S3_PUBLIC_ENDPOINT`
   * (CLAUDE.md invariant 5); signing against the internal endpoint fails in a
   * browser with an opaque `SignatureDoesNotMatch` and no other symptom.
   *
   * Scoped to blocks in the PUBLISHED list, so an image attached to a figure
   * that only exists in the draft never reaches a learner.
   */
  private async resolveFigureImages(
    lessonId: string,
    blocks: readonly Block[],
  ): Promise<Record<string, FigureImageView>> {
    const figureBlockIds = blocks
      .filter((block) => block.blockType === 'figure')
      .map((block) => block.blockId);
    if (figureBlockIds.length === 0) return {};

    const rows = await this.prisma.client.lessonImage.findMany({
      where: { lessonId, isSelected: true, blockReferenceId: { in: figureBlockIds } },
      select: {
        blockReferenceId: true,
        imageFileUrl: true,
        captionText: true,
        alternativeText: true,
      },
    });

    const entries = await Promise.all(
      rows.map(
        async (row) =>
          [
            row.blockReferenceId,
            {
              url: await this.storage.presignGet(row.imageFileUrl, PRESIGN_EXPIRY_SECONDS),
              captionText: row.captionText,
              alternativeText: row.alternativeText,
            },
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  /**
   * FR-AUDIO-02's timings — served only when the §6.5 chain resolves to the
   * PUBLISHED text.
   *
   * §8 gives `narration_scripts` and `lesson_audios` no published copy: a
   * publish copies the lesson body and the block list and nothing else. So an
   * admin who edits narration or regenerates audio after a publish changes what
   * a learner hears immediately, unversioned — and if the body changed too, the
   * live segments reference blockIds that are not in `published_block_list`,
   * which breaks highlight sync silently.
   *
   * The two comparisons below are the only available proof that this audio
   * voices these words:
   *
   *   1. `source_content_checksum === blockListChecksum(published_block_list)`.
   *      The script's checksum was written from `draft_content_checksum`
   *      (narration.processor.ts), which is `blockListChecksum(draftBlockList)`
   *      (lesson-content.service.ts), and publishing copies the draft block list
   *      verbatim — so this holds exactly when the script was generated from the
   *      text now published.
   *   2. `source_script_checksum === script_checksum` — §6.5's script→audio
   *      link, the same comparison `computeAudioStatus` makes.
   *
   * NEITHER IS A NEW RULE. Both compose values that already exist; §6.5 is
   * explicit that staleness is computed on read and never stored.
   *
   * Consequence, accepted in specs/p7-learner/spec.md: the player disappears
   * from a lesson while an admin is mid-edit and returns on the next publish.
   * The lesson still reads.
   */
  private async resolveAudio(
    lessonId: string,
    publishedBlockList: ReturnType<typeof readBlockList>,
  ): Promise<ReaderAudioView | null> {
    if (publishedBlockList.blocks.length === 0) return null;

    const script = await this.prisma.client.narrationScript.findUnique({
      where: { lessonId },
      select: { scriptChecksum: true, sourceContentChecksum: true },
    });
    if (!script) return null;
    if (script.sourceContentChecksum !== blockListChecksum(publishedBlockList)) return null;

    const audio = await this.prisma.client.lessonAudio.findFirst({
      where: { lessonId, audioStatus: 'ready' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        totalDurationSeconds: true,
        sourceScriptChecksum: true,
        segments: {
          orderBy: { segmentOrder: 'asc' },
          select: {
            blockReferenceId: true,
            segmentOrder: true,
            startMillisecond: true,
            endMillisecond: true,
          },
        },
      },
    });
    if (!audio || audio.sourceScriptChecksum !== script.scriptChecksum) return null;

    return {
      mediaId: audio.id,
      totalDurationSeconds: audio.totalDurationSeconds,
      segments: audio.segments.map((segment) => ({
        blockId: segment.blockReferenceId,
        segmentOrder: segment.segmentOrder,
        startMillisecond: segment.startMillisecond,
        endMillisecond: segment.endMillisecond,
      })),
    };
  }

  /**
   * FR-LRN-01's previous/next, read from the snapshot rather than from
   * `chapters` and `lessons`.
   *
   * §9.4 says the table of contents comes from the snapshot, and navigation has
   * to agree with it — a "next" that points at a lesson the contents does not
   * list is a dead end. This also means a lesson soft-deleted since the last
   * publish still appears, which §4.3 requires.
   */
  private async resolveNeighbours(
    courseId: string,
    lessonId: string,
  ): Promise<{ previous: ReaderNeighbour | null; next: ReaderNeighbour | null }> {
    const structure = await this.prisma.client.publishedCourseStructure.findUnique({
      where: { courseId },
      select: { structurePayload: true },
    });
    if (!structure) return { previous: null, next: null };

    const parsed = structurePayloadSchema.safeParse(structure.structurePayload);
    if (!parsed.success) return { previous: null, next: null };

    const flat: SnapshotLesson[] = parsed.data.chapters.flatMap((chapter) => chapter.lessons);
    const index = flat.findIndex((lesson) => lesson.lessonId === lessonId);
    if (index === -1) return { previous: null, next: null };

    const toNeighbour = (lesson: SnapshotLesson | undefined): ReaderNeighbour | null =>
      lesson ? { lessonId: lesson.lessonId, title: lesson.title } : null;

    return { previous: toNeighbour(flat[index - 1]), next: toNeighbour(flat[index + 1]) };
  }
}

/** Re-exported so the catalog service parses snapshots through the same schema. */
export { snapshotChapterSchema };
