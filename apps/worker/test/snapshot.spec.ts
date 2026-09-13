import { describe, expect, it } from 'vitest';
import { structurePayloadSchema } from '@knowledge-explorer/shared';
import { buildStructurePayload, type SnapshotChapterRow } from '../src/jobs/snapshot';

/**
 * §4.3's snapshot is P7's contract and is expensive to change — altering it
 * later means republishing every course — so its shape, ordering and exclusions
 * are asserted here rather than discovered in the learner app.
 */

const courseId = '3f1a0c8e-1f0e-4c3a-9a3b-2c6f5d4e7b81';
const chapterA = '5c2b1d9f-2a1b-4d5e-8f7a-3b6c9d0e1f22';
const chapterB = '6d3c2e0a-3b2c-4e6f-9a8b-4c7d0e1f2a33';
const lesson1 = '7e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c13';
const lesson2 = '8f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d24';

const lesson = (id: string, order: number, over: Partial<SnapshotChapterRow['lessons'][number]> = {}) => ({
  id,
  lessonOrder: order,
  title: `Lesson ${order}`,
  estimatedMinutes: 10,
  isFreePreview: false,
  audio: { totalDurationSeconds: 184 },
  figureCount: 2,
  ...over,
});

describe('buildStructurePayload', () => {
  it('produces a payload that parses against the shared schema', () => {
    const payload = buildStructurePayload({
      courseId,
      publishedVersionNumber: 1,
      chapters: [
        { id: chapterA, chapterOrder: 1, title: 'Hiragana', description: 'Kana', lessons: [lesson(lesson1, 1)] },
      ],
    });

    expect(structurePayloadSchema.parse(payload)).toEqual(payload);
  });

  it('orders chapters and lessons by their stored order, not input order', () => {
    const payload = buildStructurePayload({
      courseId,
      publishedVersionNumber: 3,
      chapters: [
        { id: chapterB, chapterOrder: 2, title: 'Second', description: null, lessons: [lesson(lesson2, 2), lesson(lesson1, 1)] },
        { id: chapterA, chapterOrder: 1, title: 'First', description: null, lessons: [] },
      ],
    });

    expect(payload.chapters.map((c) => c.title)).toEqual(['First', 'Second']);
    expect(payload.chapters[1]!.lessons.map((l) => l.order)).toEqual([1, 2]);
  });

  it('counts only the lessons it was given, so soft-deleted rows never reach it', () => {
    const payload = buildStructurePayload({
      courseId,
      publishedVersionNumber: 1,
      chapters: [
        { id: chapterA, chapterOrder: 1, title: 'One', description: null, lessons: [lesson(lesson1, 1)] },
        { id: chapterB, chapterOrder: 2, title: 'Two', description: null, lessons: [lesson(lesson2, 1)] },
      ],
    });

    expect(payload.totalLessonCount).toBe(2);
  });

  it('copies the audio duration in seconds, exactly as stored', () => {
    const payload = buildStructurePayload({
      courseId,
      publishedVersionNumber: 1,
      chapters: [
        {
          id: chapterA,
          chapterOrder: 1,
          title: 'One',
          description: null,
          lessons: [lesson(lesson1, 1, { audio: { totalDurationSeconds: 184 } })],
        },
      ],
    });

    const only = payload.chapters[0]!.lessons[0]!;
    expect(only.hasAudio).toBe(true);
    expect(only.audioDurationSeconds).toBe(184);
  });

  it('reports a lesson with no audio rather than inventing a duration', () => {
    const payload = buildStructurePayload({
      courseId,
      publishedVersionNumber: 1,
      chapters: [
        {
          id: chapterA,
          chapterOrder: 1,
          title: 'One',
          description: null,
          lessons: [lesson(lesson1, 1, { audio: null })],
        },
      ],
    });

    const only = payload.chapters[0]!.lessons[0]!;
    expect(only.hasAudio).toBe(false);
    expect(only.audioDurationSeconds).toBeNull();
  });

  it('carries the free-preview flag and figure count the catalog renders', () => {
    const payload = buildStructurePayload({
      courseId,
      publishedVersionNumber: 1,
      chapters: [
        {
          id: chapterA,
          chapterOrder: 1,
          title: 'One',
          description: null,
          lessons: [lesson(lesson1, 1, { isFreePreview: true, figureCount: 5 })],
        },
      ],
    });

    const only = payload.chapters[0]!.lessons[0]!;
    expect(only.isFreePreview).toBe(true);
    expect(only.figureCount).toBe(5);
  });

  it('holds no course metadata, which stays on `courses`', () => {
    const payload = buildStructurePayload({
      courseId,
      publishedVersionNumber: 1,
      chapters: [],
    });

    expect(Object.keys(payload).sort()).toEqual([
      'chapters',
      'courseId',
      'publishedVersionNumber',
      'totalLessonCount',
    ]);
  });
});
