import type { ContentStatus, PublicationStatus } from '@knowledge-explorer/shared';
import type { ImportChapter, ImportLesson, ImportPayload } from './import-schema';
import { deriveCourseSlug } from './slug';

/**
 * The import diff engine: pure, and deliberately so.
 *
 * FR-IMP-02's dry run reports this plan; the commit worker applies it, having
 * re-run this same function inside its transaction. Because both callers share
 * one pure function, a preview that disagrees with what commit does is
 * impossible by construction rather than by discipline — see
 * specs/p1-curriculum/plan.md. Nothing here touches Prisma, a transaction or a
 * clock.
 *
 * ## How a payload row is matched to an existing row
 *
 * §9.1 carries no stable identifier for a chapter or a lesson, only a title and
 * an order, so the match must be inferred. specs/p1-curriculum/spec.md requires
 * BOTH of these to hold on re-import:
 *
 *   - a renamed chapter is an update, ids unchanged;
 *   - a reordered lesson is an update, ids unchanged.
 *
 * Matching on title alone breaks the first; matching on order alone breaks the
 * second. So matching runs in two passes: title first, then order for whatever
 * is left over. A renamed chapter keeps its slot by order; a reordered lesson
 * keeps its identity by title.
 */

export interface ExistingLesson {
  readonly id: string;
  readonly lessonOrder: number;
  readonly title: string;
  readonly learningObjective: string | null;
  readonly keyPoints: readonly string[];
  readonly estimatedMinutes: number | null;
  readonly contentStatus: ContentStatus;
  /** lesson_contents.draft_content_markdown is present and non-empty. */
  readonly hasDraftContent: boolean;
}

export interface ExistingChapter {
  readonly id: string;
  readonly chapterOrder: number;
  readonly title: string;
  readonly description: string | null;
  /** Non-deleted lessons only; soft-deleted rows are invisible to the diff. */
  readonly lessons: readonly ExistingLesson[];
}

export interface ExistingCourse {
  readonly id: string;
  readonly slug: string;
  readonly levelOrder: number;
  readonly publicationStatus: PublicationStatus;
  /** Non-deleted chapters only. */
  readonly chapters: readonly ExistingChapter[];
}

export interface ExistingCategory {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

/** The snapshot the diff reads. Loaded by the dry run, and again by the commit. */
export interface ExistingTree {
  /** The category carrying the payload's slug, if one exists. */
  readonly category?: ExistingCategory;
  /** The course carrying the derived slug, if one exists. */
  readonly course?: ExistingCourse;
  /**
   * Other courses in that category and the levelOrder each occupies, so §8's
   * UNIQUE (category_id, level_order) is reported as a conflict rather than a
   * constraint violation from the worker.
   */
  readonly levelOrdersInCategory?: ReadonlyArray<{
    readonly courseId: string;
    readonly slug: string;
    readonly levelOrder: number;
  }>;
}

/**
 * `unchanged` exists so FR-IMP-02's preview counts what is actually *to be*
 * updated. A re-import of an identical payload should read as "nothing to do",
 * not "42 updates". §9.1's category already carries the same distinction.
 */
export type EntryAction = 'create' | 'update' | 'unchanged' | 'delete';

export interface ChapterPlanEntry {
  readonly action: EntryAction;
  /** Stable within the plan: the existing chapter id, or `new:<chapterOrder>`. */
  readonly key: string;
  readonly id?: string;
  readonly chapterOrder: number;
  readonly title: string;
  readonly description: string | null;
}

export interface LessonPlanEntry {
  readonly action: EntryAction;
  /** The `key` of the chapter this lesson belongs to. */
  readonly chapterKey: string;
  readonly id?: string;
  readonly chapterOrder: number;
  readonly lessonOrder: number;
  readonly title: string;
  readonly learningObjective: string | null;
  readonly keyPoints: readonly string[];
  readonly estimatedMinutes: number | null;
}

export type ConflictKind =
  | 'lesson_has_draft_content'
  | 'chapter_has_conflicted_lessons'
  | 'level_order_taken';

export interface ImportConflict {
  readonly kind: ConflictKind;
  readonly lessonId?: string;
  readonly chapterId?: string;
  readonly title: string;
  readonly reason: string;
}

export interface ImportPlan {
  readonly category: {
    readonly action: 'create' | 'update' | 'unchanged';
    readonly id?: string;
    readonly slug: string;
    readonly displayName: string;
  };
  readonly course: {
    readonly action: 'create' | 'update';
    readonly id?: string;
    readonly slug: string;
    readonly isPublished: boolean;
  };
  readonly chapters: readonly ChapterPlanEntry[];
  readonly lessons: readonly LessonPlanEntry[];
  readonly conflicts: readonly ImportConflict[];
  readonly counts: {
    readonly chaptersCreated: number;
    readonly chaptersUpdated: number;
    readonly chaptersUnchanged: number;
    readonly chaptersDeleted: number;
    readonly lessonsCreated: number;
    readonly lessonsUpdated: number;
    readonly lessonsUnchanged: number;
    readonly lessonsDeleted: number;
    readonly conflicts: number;
  };
}

/** Titles match case-insensitively on trimmed text; a retitled case is not a new row. */
const titleKey = (title: string): string => title.trim().toLowerCase();

/**
 * Pairs payload entries to existing rows: by title first, then by order for
 * whatever remains. See the module comment for why both passes are required.
 */
function pair<P, E>(
  payloadEntries: readonly P[],
  existingRows: readonly E[],
  payloadTitle: (entry: P) => string,
  payloadOrder: (entry: P) => number,
  existingTitle: (row: E) => string,
  existingOrder: (row: E) => number,
): { matches: Map<P, E>; unmatchedExisting: E[] } {
  const matches = new Map<P, E>();
  const claimed = new Set<E>();

  const byTitle = new Map<string, E[]>();
  for (const row of existingRows) {
    const key = titleKey(existingTitle(row));
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(row);
    else byTitle.set(key, [row]);
  }

  for (const entry of payloadEntries) {
    const bucket = byTitle.get(titleKey(payloadTitle(entry)));
    const row = bucket?.find((candidate) => !claimed.has(candidate));
    if (row) {
      matches.set(entry, row);
      claimed.add(row);
    }
  }

  const byOrder = new Map<number, E>();
  for (const row of existingRows) {
    if (!claimed.has(row)) byOrder.set(existingOrder(row), row);
  }

  for (const entry of payloadEntries) {
    if (matches.has(entry)) continue;
    const row = byOrder.get(payloadOrder(entry));
    if (row && !claimed.has(row)) {
      matches.set(entry, row);
      claimed.add(row);
    }
  }

  return {
    matches,
    unmatchedExisting: existingRows.filter((row) => !claimed.has(row)),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function chapterChanged(row: ExistingChapter, entry: ImportChapter): boolean {
  return (
    row.title !== entry.title ||
    row.chapterOrder !== entry.chapterOrder ||
    row.description !== (entry.description ?? null)
  );
}

function lessonChanged(row: ExistingLesson, entry: ImportLesson): boolean {
  return (
    row.title !== entry.title ||
    row.lessonOrder !== entry.lessonOrder ||
    row.learningObjective !== (entry.learningObjective ?? null) ||
    row.estimatedMinutes !== (entry.estimatedMinutes ?? null) ||
    !sameList(row.keyPoints, entry.keyPoints)
  );
}

/** A lesson may be soft-deleted only when it carries no work. */
function isRemovable(lesson: ExistingLesson): boolean {
  return lesson.contentStatus === 'empty' && !lesson.hasDraftContent;
}

function lessonEntry(
  action: EntryAction,
  chapterKey: string,
  chapterOrder: number,
  lesson: ImportLesson,
  id?: string,
): LessonPlanEntry {
  return {
    action,
    chapterKey,
    ...(id === undefined ? {} : { id }),
    chapterOrder,
    lessonOrder: lesson.lessonOrder,
    title: lesson.title,
    learningObjective: lesson.learningObjective ?? null,
    keyPoints: lesson.keyPoints,
    estimatedMinutes: lesson.estimatedMinutes ?? null,
  };
}

export function buildImportPlan(existing: ExistingTree, payload: ImportPayload): ImportPlan {
  const slug = deriveCourseSlug(payload.category.slug, payload.course.levelLabel);

  const chapters: ChapterPlanEntry[] = [];
  const lessons: LessonPlanEntry[] = [];
  const conflicts: ImportConflict[] = [];

  // §8: UNIQUE (category_id, level_order). Another course already in the slot is
  // a conflict, not a constraint violation surfacing from the worker.
  for (const occupant of existing.levelOrdersInCategory ?? []) {
    if (occupant.levelOrder !== payload.course.levelOrder) continue;
    if (existing.course && occupant.courseId === existing.course.id) continue;
    conflicts.push({
      kind: 'level_order_taken',
      title: payload.course.title,
      reason:
        `levelOrder ${payload.course.levelOrder} in category "${payload.category.slug}" ` +
        `is already held by course "${occupant.slug}"`,
    });
  }

  const existingChapters = existing.course?.chapters ?? [];
  const chapterPairing = pair(
    payload.chapters,
    existingChapters,
    (chapter) => chapter.title,
    (chapter) => chapter.chapterOrder,
    (row) => row.title,
    (row) => row.chapterOrder,
  );

  for (const chapter of payload.chapters) {
    const matched = chapterPairing.matches.get(chapter);
    const key = matched ? matched.id : `new:${chapter.chapterOrder}`;

    chapters.push({
      action: !matched ? 'create' : chapterChanged(matched, chapter) ? 'update' : 'unchanged',
      key,
      ...(matched ? { id: matched.id } : {}),
      chapterOrder: chapter.chapterOrder,
      title: chapter.title,
      description: chapter.description ?? null,
    });

    const lessonPairing = pair(
      chapter.lessons,
      matched?.lessons ?? [],
      (lesson) => lesson.title,
      (lesson) => lesson.lessonOrder,
      (row) => row.title,
      (row) => row.lessonOrder,
    );

    for (const lesson of chapter.lessons) {
      const matchedLesson = lessonPairing.matches.get(lesson);
      lessons.push(
        lessonEntry(
          !matchedLesson
            ? 'create'
            : lessonChanged(matchedLesson, lesson)
              ? 'update'
              : 'unchanged',
          key,
          chapter.chapterOrder,
          lesson,
          matchedLesson?.id,
        ),
      );
    }

    // Lessons the payload dropped from a chapter it kept.
    for (const orphan of lessonPairing.unmatchedExisting) {
      if (!isRemovable(orphan)) {
        conflicts.push({
          kind: 'lesson_has_draft_content',
          lessonId: orphan.id,
          chapterId: matched?.id,
          title: orphan.title,
          reason:
            'absent from the payload but carries draft content, so it is left in ' +
            'place; delete it explicitly if it should go',
        });
        continue;
      }
      lessons.push({
        action: 'delete',
        chapterKey: key,
        id: orphan.id,
        chapterOrder: chapter.chapterOrder,
        lessonOrder: orphan.lessonOrder,
        title: orphan.title,
        learningObjective: null,
        keyPoints: [],
        estimatedMinutes: null,
      });
    }
  }

  // Chapters the payload dropped entirely.
  for (const orphan of chapterPairing.unmatchedExisting) {
    const blocking = orphan.lessons.filter((lesson) => !isRemovable(lesson));

    if (blocking.length > 0) {
      conflicts.push({
        kind: 'chapter_has_conflicted_lessons',
        chapterId: orphan.id,
        title: orphan.title,
        reason:
          `absent from the payload but ${blocking.length} of its lessons carry ` +
          'draft content, so neither the chapter nor those lessons are deleted',
      });
      for (const lesson of blocking) {
        conflicts.push({
          kind: 'lesson_has_draft_content',
          lessonId: lesson.id,
          chapterId: orphan.id,
          title: lesson.title,
          reason: 'carries draft content in a chapter the payload dropped',
        });
      }
      continue;
    }

    const key = orphan.id;
    chapters.push({
      action: 'delete',
      key,
      id: orphan.id,
      chapterOrder: orphan.chapterOrder,
      title: orphan.title,
      description: null,
    });
    for (const lesson of orphan.lessons) {
      lessons.push({
        action: 'delete',
        chapterKey: key,
        id: lesson.id,
        chapterOrder: orphan.chapterOrder,
        lessonOrder: lesson.lessonOrder,
        title: lesson.title,
        learningObjective: null,
        keyPoints: [],
        estimatedMinutes: null,
      });
    }
  }

  const countBy = (entries: ReadonlyArray<{ action: EntryAction }>, action: EntryAction): number =>
    entries.filter((entry) => entry.action === action).length;

  const categoryAction: 'create' | 'update' | 'unchanged' = !existing.category
    ? 'create'
    : existing.category.displayName === payload.category.displayName
      ? 'unchanged'
      : 'update';

  return {
    category: {
      action: categoryAction,
      ...(existing.category ? { id: existing.category.id } : {}),
      slug: payload.category.slug,
      displayName: payload.category.displayName,
    },
    course: {
      action: existing.course ? 'update' : 'create',
      ...(existing.course ? { id: existing.course.id } : {}),
      slug,
      isPublished: existing.course?.publicationStatus === 'published',
    },
    chapters,
    lessons,
    conflicts,
    counts: {
      chaptersCreated: countBy(chapters, 'create'),
      chaptersUpdated: countBy(chapters, 'update'),
      chaptersUnchanged: countBy(chapters, 'unchanged'),
      chaptersDeleted: countBy(chapters, 'delete'),
      lessonsCreated: countBy(lessons, 'create'),
      lessonsUpdated: countBy(lessons, 'update'),
      lessonsUnchanged: countBy(lessons, 'unchanged'),
      lessonsDeleted: countBy(lessons, 'delete'),
      conflicts: conflicts.length,
    },
  };
}
