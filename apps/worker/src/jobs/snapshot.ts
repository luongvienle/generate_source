import type { StructurePayload } from '@knowledge-explorer/shared';

/**
 * §4.3's table-of-contents snapshot, built from already-loaded rows.
 *
 * WHERE THIS LIVES. specs/p6-publishing/plan.md put it in apps/api. It is here
 * instead because only the publish job ever writes a snapshot — the API reads
 * `published_course_structures` for a version number and nothing more — so an
 * export in apps/api would have no caller. The SHAPE is not local: it is
 * `structurePayloadSchema` in packages/shared, which P7 parses with, and this
 * function's output is validated against it before it is stored.
 *
 * Pure, and takes plain rows rather than a client, so its ordering and exclusion
 * rules are unit-testable without a database.
 */

export interface SnapshotLessonRow {
  readonly id: string;
  readonly lessonOrder: number;
  readonly title: string;
  readonly estimatedMinutes: number | null;
  readonly isFreePreview: boolean;
  /** The lesson's audio row, if one exists. Null means the lesson has no audio. */
  readonly audio: { readonly totalDurationSeconds: number | null } | null;
  readonly figureCount: number;
}

export interface SnapshotChapterRow {
  readonly id: string;
  readonly chapterOrder: number;
  readonly title: string;
  readonly description: string | null;
  readonly lessons: readonly SnapshotLessonRow[];
}

export interface SnapshotInput {
  readonly courseId: string;
  readonly publishedVersionNumber: number;
  /** Non-deleted chapters only; §4.3 keeps deleted rows in the PREVIOUS snapshot. */
  readonly chapters: readonly SnapshotChapterRow[];
}

export function buildStructurePayload(input: SnapshotInput): StructurePayload {
  const chapters = [...input.chapters]
    .sort((a, b) => a.chapterOrder - b.chapterOrder)
    .map((chapter) => ({
      chapterId: chapter.id,
      order: chapter.chapterOrder,
      title: chapter.title,
      description: chapter.description,
      lessons: [...chapter.lessons]
        .sort((a, b) => a.lessonOrder - b.lessonOrder)
        .map((lesson) => ({
          lessonId: lesson.id,
          order: lesson.lessonOrder,
          title: lesson.title,
          estimatedMinutes: lesson.estimatedMinutes,
          isFreePreview: lesson.isFreePreview,
          hasAudio: lesson.audio !== null,
          /**
           * Seconds, copied from `lesson_audios.total_duration_seconds` and
           * never converted — the stored column is seconds, and a millisecond
           * field here would give the snapshot and its source two units that can
           * disagree. Per-segment millisecond offsets stay in `audio_segments`,
           * where P7's highlight sync reads them.
           */
          audioDurationSeconds: lesson.audio?.totalDurationSeconds ?? null,
          figureCount: lesson.figureCount,
        })),
    }));

  return {
    courseId: input.courseId,
    publishedVersionNumber: input.publishedVersionNumber,
    chapters,
    totalLessonCount: chapters.reduce((total, chapter) => total + chapter.lessons.length, 0),
  };
}
