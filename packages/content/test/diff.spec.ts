import { describe, expect, it } from 'vitest';
import {
  buildImportPlan,
  type ExistingChapter,
  type ExistingLesson,
  type ExistingTree,
} from '../src/diff';
import { SCHEMA_VERSION, type ImportPayload } from '../src/import-schema';

/**
 * The diff engine is pure, so the whole conflict and removal matrix is exercised
 * here rather than over HTTP. specs/p1-curriculum/spec.md lists these cases.
 */

type PayloadLesson = ImportPayload['chapters'][number]['lessons'][number];
type PayloadChapter = ImportPayload['chapters'][number];

const pLesson = (over: Partial<PayloadLesson> = {}): PayloadLesson => ({
  lessonOrder: 1,
  title: 'The A-row',
  keyPoints: [],
  ...over,
});

const pChapter = (over: Partial<PayloadChapter> = {}): PayloadChapter => ({
  chapterOrder: 1,
  title: 'Hiragana',
  lessons: [pLesson()],
  ...over,
});

const payload = (chapters: PayloadChapter[], levelOrder = 1): ImportPayload => ({
  schemaVersion: SCHEMA_VERSION,
  category: { slug: 'japanese', displayName: 'Japanese' },
  course: {
    levelLabel: 'N5',
    levelOrder,
    title: 'Japanese N5',
    prerequisites: [],
    learningObjectives: [],
    languageCode: 'vi',
  },
  chapters,
});

const eLesson = (over: Partial<ExistingLesson> = {}): ExistingLesson => ({
  id: 'lesson-1',
  lessonOrder: 1,
  title: 'The A-row',
  learningObjective: null,
  keyPoints: [],
  estimatedMinutes: null,
  contentStatus: 'empty',
  hasDraftContent: false,
  ...over,
});

const eChapter = (over: Partial<ExistingChapter> = {}): ExistingChapter => ({
  id: 'chapter-1',
  chapterOrder: 1,
  title: 'Hiragana',
  description: null,
  lessons: [eLesson()],
  ...over,
});

const tree = (chapters: ExistingChapter[], over: Partial<ExistingTree> = {}): ExistingTree => ({
  category: { id: 'category-1', slug: 'japanese', displayName: 'Japanese' },
  course: {
    id: 'course-1',
    slug: 'japanese-n5',
    levelOrder: 1,
    publicationStatus: 'draft',
    chapters,
  },
  ...over,
});

describe('first import', () => {
  const plan = buildImportPlan({}, payload([pChapter()]));

  it('creates the category, the course, and every row', () => {
    expect(plan.category.action).toBe('create');
    expect(plan.course.action).toBe('create');
    expect(plan.chapters.every((c) => c.action === 'create')).toBe(true);
    expect(plan.lessons.every((l) => l.action === 'create')).toBe(true);
  });

  it('derives the course slug from (categorySlug, levelLabel)', () => {
    expect(plan.course.slug).toBe('japanese-n5');
    expect(plan.course.isPublished).toBe(false);
  });

  it('counts what it will do', () => {
    expect(plan.counts).toMatchObject({
      chaptersCreated: 1,
      chaptersUpdated: 0,
      chaptersDeleted: 0,
      lessonsCreated: 1,
      lessonsUpdated: 0,
      lessonsDeleted: 0,
      conflicts: 0,
    });
  });

  it('gives new chapters a key its lessons can reference before any id exists', () => {
    expect(plan.lessons[0]!.chapterKey).toBe(plan.chapters[0]!.key);
    expect(plan.chapters[0]!.id).toBeUndefined();
  });
});

describe('re-import of an identical payload', () => {
  const plan = buildImportPlan(tree([eChapter()]), payload([pChapter()]));

  it('reports nothing to create and nothing to update', () => {
    expect(plan.counts.chaptersCreated).toBe(0);
    expect(plan.counts.chaptersUpdated).toBe(0);
    expect(plan.counts.lessonsCreated).toBe(0);
    expect(plan.counts.lessonsUpdated).toBe(0);
  });

  it('marks the rows unchanged and keeps the category unchanged too', () => {
    expect(plan.chapters[0]!.action).toBe('unchanged');
    expect(plan.lessons[0]!.action).toBe('unchanged');
    expect(plan.category.action).toBe('unchanged');
    expect(plan.course.action).toBe('update');
  });
});

describe('re-import with edits', () => {
  it('treats a renamed chapter as an update, keeping its id', () => {
    const plan = buildImportPlan(
      tree([eChapter()]),
      payload([pChapter({ title: 'Hiragana basics' })]),
    );

    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0]).toMatchObject({
      action: 'update',
      id: 'chapter-1',
      title: 'Hiragana basics',
    });
    expect(plan.counts.chaptersCreated).toBe(0);
    expect(plan.counts.chaptersDeleted).toBe(0);
  });

  it('treats a reordered lesson as an update, keeping its id', () => {
    const existing = eChapter({
      lessons: [
        eLesson({ id: 'lesson-a', lessonOrder: 1, title: 'The A-row' }),
        eLesson({ id: 'lesson-b', lessonOrder: 2, title: 'The KA-row' }),
      ],
    });
    const plan = buildImportPlan(
      tree([existing]),
      payload([
        pChapter({
          lessons: [
            pLesson({ lessonOrder: 1, title: 'The KA-row' }),
            pLesson({ lessonOrder: 2, title: 'The A-row' }),
          ],
        }),
      ]),
    );

    expect(plan.counts.lessonsCreated).toBe(0);
    expect(plan.counts.lessonsDeleted).toBe(0);
    expect(plan.lessons.map((l) => [l.id, l.lessonOrder])).toEqual([
      ['lesson-b', 1],
      ['lesson-a', 2],
    ]);
  });

  it('renames the category when displayName changed', () => {
    const plan = buildImportPlan(tree([eChapter()]), {
      ...payload([pChapter()]),
      category: { slug: 'japanese', displayName: 'Japanese language' },
    });
    expect(plan.category.action).toBe('update');
    expect(plan.category.id).toBe('category-1');
  });
});

describe('levelOrder collisions (§8 UNIQUE (category_id, level_order))', () => {
  it('conflicts when another course already holds the slot', () => {
    const plan = buildImportPlan(
      tree([eChapter()], {
        levelOrdersInCategory: [{ courseId: 'course-other', slug: 'japanese-n4', levelOrder: 1 }],
      }),
      payload([pChapter()], 1),
    );

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.kind).toBe('level_order_taken');
    expect(plan.conflicts[0]!.reason).toContain('japanese-n4');
  });

  it('does not conflict with the course being re-imported', () => {
    const plan = buildImportPlan(
      tree([eChapter()], {
        levelOrdersInCategory: [{ courseId: 'course-1', slug: 'japanese-n5', levelOrder: 1 }],
      }),
      payload([pChapter()], 1),
    );

    expect(plan.conflicts).toHaveLength(0);
  });
});

describe('removals and conflicts', () => {
  const twoLessons = (over: Partial<ExistingLesson> = {}) =>
    eChapter({
      lessons: [
        eLesson({ id: 'lesson-a', lessonOrder: 1, title: 'The A-row' }),
        eLesson({ id: 'lesson-b', lessonOrder: 2, title: 'The KA-row', ...over }),
      ],
    });

  it('soft-deletes a dropped lesson that is empty and has no draft content', () => {
    const plan = buildImportPlan(
      tree([twoLessons()]),
      payload([pChapter({ lessons: [pLesson({ lessonOrder: 1, title: 'The A-row' })] })]),
    );

    expect(plan.counts.lessonsDeleted).toBe(1);
    expect(plan.counts.conflicts).toBe(0);
    expect(plan.lessons.find((l) => l.action === 'delete')!.id).toBe('lesson-b');
  });

  it('never deletes a dropped lesson that carries draft content — it conflicts instead', () => {
    const plan = buildImportPlan(
      tree([twoLessons({ contentStatus: 'drafting', hasDraftContent: true })]),
      payload([pChapter({ lessons: [pLesson({ lessonOrder: 1, title: 'The A-row' })] })]),
    );

    expect(plan.counts.lessonsDeleted).toBe(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      kind: 'lesson_has_draft_content',
      lessonId: 'lesson-b',
    });
  });

  it('deletes a dropped chapter when every lesson under it is removable', () => {
    const plan = buildImportPlan(
      tree([
        eChapter(),
        eChapter({
          id: 'chapter-2',
          chapterOrder: 2,
          title: 'Katakana',
          lessons: [eLesson({ id: 'lesson-k', lessonOrder: 1, title: 'The A-row (katakana)' })],
        }),
      ]),
      payload([pChapter()]),
    );

    expect(plan.counts.chaptersDeleted).toBe(1);
    expect(plan.counts.lessonsDeleted).toBe(1);
    expect(plan.counts.conflicts).toBe(0);
    expect(plan.chapters.find((c) => c.action === 'delete')!.id).toBe('chapter-2');
  });

  it('keeps a dropped chapter whose lessons carry draft content, and reports both', () => {
    const plan = buildImportPlan(
      tree([
        eChapter(),
        eChapter({
          id: 'chapter-2',
          chapterOrder: 2,
          title: 'Katakana',
          lessons: [
            eLesson({
              id: 'lesson-k',
              lessonOrder: 1,
              title: 'The A-row (katakana)',
              contentStatus: 'drafting',
              hasDraftContent: true,
            }),
          ],
        }),
      ]),
      payload([pChapter()]),
    );

    expect(plan.counts.chaptersDeleted).toBe(0);
    expect(plan.counts.lessonsDeleted).toBe(0);
    expect(plan.conflicts.map((c) => c.kind)).toEqual([
      'chapter_has_conflicted_lessons',
      'lesson_has_draft_content',
    ]);
  });

  it('handles a chapter holding one removable and one conflicted lesson', () => {
    const plan = buildImportPlan(
      tree([
        eChapter({
          lessons: [
            eLesson({ id: 'lesson-a', lessonOrder: 1, title: 'The A-row' }),
            eLesson({ id: 'lesson-b', lessonOrder: 2, title: 'The KA-row' }),
            eLesson({
              id: 'lesson-c',
              lessonOrder: 3,
              title: 'The SA-row',
              contentStatus: 'drafting',
              hasDraftContent: true,
            }),
          ],
        }),
      ]),
      payload([pChapter({ lessons: [pLesson({ lessonOrder: 1, title: 'The A-row' })] })]),
    );

    expect(plan.counts.lessonsDeleted).toBe(1);
    expect(plan.lessons.find((l) => l.action === 'delete')!.id).toBe('lesson-b');
    expect(plan.conflicts.map((c) => c.lessonId)).toEqual(['lesson-c']);
  });

  it('never lists a conflicted row in the delete lists', () => {
    const plan = buildImportPlan(
      tree([
        eChapter({
          lessons: [
            eLesson({ id: 'lesson-a', lessonOrder: 1, title: 'The A-row' }),
            eLesson({
              id: 'lesson-c',
              lessonOrder: 2,
              title: 'The SA-row',
              contentStatus: 'ready',
              hasDraftContent: true,
            }),
          ],
        }),
        eChapter({
          id: 'chapter-3',
          chapterOrder: 3,
          title: 'Kanji',
          lessons: [
            eLesson({
              id: 'lesson-d',
              lessonOrder: 1,
              title: 'Numbers',
              contentStatus: 'drafting',
              hasDraftContent: true,
            }),
          ],
        }),
      ]),
      payload([pChapter({ lessons: [pLesson({ lessonOrder: 1, title: 'The A-row' })] })]),
    );

    const conflictedIds = new Set(
      plan.conflicts.flatMap((c) => [c.lessonId, c.chapterId].filter(Boolean)),
    );
    const deletedIds = [
      ...plan.lessons.filter((l) => l.action === 'delete').map((l) => l.id),
      ...plan.chapters.filter((c) => c.action === 'delete').map((c) => c.id),
    ];

    expect(conflictedIds.size).toBeGreaterThan(0);
    for (const id of deletedIds) expect(conflictedIds.has(id)).toBe(false);
  });
});

describe('a published course', () => {
  it('reports isPublished so the caller can set has_unpublished_changes', () => {
    const plan = buildImportPlan(
      tree([eChapter()], {
        course: {
          id: 'course-1',
          slug: 'japanese-n5',
          levelOrder: 1,
          publicationStatus: 'published',
          chapters: [eChapter()],
        },
      }),
      payload([pChapter({ title: 'Hiragana basics' })]),
    );

    expect(plan.course.isPublished).toBe(true);
  });
});
