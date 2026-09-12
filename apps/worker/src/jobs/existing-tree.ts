import type { PrismaClient } from '@knowledge-explorer/database';
import {
  deriveCourseSlug,
  type ExistingTree,
  type ImportPayload,
} from '@knowledge-explorer/content';
import type { ContentStatus, PublicationStatus } from '@knowledge-explorer/shared';

/**
 * Loads the snapshot the diff engine reads.
 *
 * Both processors call this — the dry run to preview, the commit inside its
 * transaction to apply — so the shape the diff sees is identical either way.
 * Soft-deleted rows are excluded: §8 makes ordering unique only WHERE
 * deleted_at IS NULL, so a deleted row occupies no slot and must not match a
 * payload entry.
 *
 * Accepts a transaction client as readily as the root client, so the commit can
 * read its snapshot inside the same transaction that applies the plan.
 */
export type PrismaLike = Pick<PrismaClient, 'category' | 'course'>;

export async function loadExistingTree(
  prisma: PrismaLike,
  payload: ImportPayload,
): Promise<ExistingTree> {
  const slug = deriveCourseSlug(payload.category.slug, payload.course.levelLabel);

  const category = await prisma.category.findUnique({
    where: { slug: payload.category.slug },
    select: { id: true, slug: true, displayName: true },
  });

  const course = await prisma.course.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      levelOrder: true,
      publicationStatus: true,
      chapters: {
        where: { deletedAt: null },
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
              learningObjective: true,
              keyPoints: true,
              estimatedMinutes: true,
              contentStatus: true,
              content: { select: { draftContentMarkdown: true } },
            },
          },
        },
      },
    },
  });

  const levelOrdersInCategory = category
    ? await prisma.course.findMany({
        where: { categoryId: category.id },
        select: { id: true, slug: true, levelOrder: true },
      })
    : [];

  return {
    ...(category ? { category } : {}),
    ...(course
      ? {
          course: {
            id: course.id,
            slug: course.slug,
            levelOrder: course.levelOrder,
            publicationStatus: course.publicationStatus as PublicationStatus,
            chapters: course.chapters.map((chapter) => ({
              id: chapter.id,
              chapterOrder: chapter.chapterOrder,
              title: chapter.title,
              description: chapter.description,
              lessons: chapter.lessons.map((lesson) => ({
                id: lesson.id,
                lessonOrder: lesson.lessonOrder,
                title: lesson.title,
                learningObjective: lesson.learningObjective,
                keyPoints: Array.isArray(lesson.keyPoints) ? (lesson.keyPoints as string[]) : [],
                estimatedMinutes: lesson.estimatedMinutes,
                contentStatus: lesson.contentStatus as ContentStatus,
                hasDraftContent: (lesson.content?.draftContentMarkdown ?? '').length > 0,
              })),
            })),
          },
        }
      : {}),
    levelOrdersInCategory: levelOrdersInCategory.map((row) => ({
      courseId: row.id,
      slug: row.slug,
      levelOrder: row.levelOrder,
    })),
  };
}
