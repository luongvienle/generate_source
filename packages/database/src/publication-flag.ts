import type { PrismaClient } from './client';

/**
 * FR-PUB-03: editing anything in a published course flags it as having
 * unpublished changes, which is what shows the owner a "publish changes" action.
 *
 * ONE STATEMENT, NO READ. The `publicationStatus` filter lives in the WHERE
 * clause, so a draft course is a no-op without a round-trip to discover that,
 * and there is no window between reading the status and writing the flag.
 *
 * Only `published` counts. A course in `draft`, `in_review` or `unpublished` has
 * nothing published to differ from, and `publishing` is mid-run — R-01 refuses
 * non-owner writes during it and the run itself clears the flag on success.
 *
 * Here rather than in either app because both write it: apps/api on every admin
 * edit, and apps/worker when a re-import or an audio run lands on a published
 * course. Before P6 there were two hand-rolled copies of this update and seven
 * write paths that forgot it entirely.
 *
 * Every function takes a client OR a transaction client, so a caller already
 * inside `$transaction` keeps the flag in the same atomic unit as its edit.
 */

/** Accepts both `PrismaClient` and the client a `$transaction` callback receives. */
export type CourseWriter = Pick<PrismaClient, 'course'>;

export async function markUnpublishedChangesForCourse(
  client: CourseWriter,
  courseId: string,
): Promise<void> {
  await client.course.updateMany({
    where: { id: courseId, publicationStatus: 'published' },
    data: { hasUnpublishedChanges: true, updatedAt: new Date() },
  });
}

export async function markUnpublishedChangesForChapter(
  client: CourseWriter,
  chapterId: string,
): Promise<void> {
  await client.course.updateMany({
    where: { publicationStatus: 'published', chapters: { some: { id: chapterId } } },
    data: { hasUnpublishedChanges: true, updatedAt: new Date() },
  });
}

export async function markUnpublishedChangesForLesson(
  client: CourseWriter,
  lessonId: string,
): Promise<void> {
  await client.course.updateMany({
    where: {
      publicationStatus: 'published',
      chapters: { some: { lessons: { some: { id: lessonId } } } },
    },
    data: { hasUnpublishedChanges: true, updatedAt: new Date() },
  });
}
