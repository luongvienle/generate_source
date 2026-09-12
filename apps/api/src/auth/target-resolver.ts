import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithSession } from './session-context';

export interface WriteTarget {
  readonly publicationStatus: string;
  /**
   * assigned_admin_id of every row the write touches, from §8.
   *
   * A list rather than a single value because P1 adds course-scoped writes —
   * PATCH /courses/:courseId/structure rewrites the ordering of every chapter
   * and lesson at once, so R-02 has to consider all of them, not one.
   */
  readonly assignedAdminIds: ReadonlyArray<string | null>;
}

/**
 * Resolves the rows a request targets, plus the publication status of their
 * course, so R-01 and R-02 both work from one lookup shape.
 *
 * Returns undefined when the route carries no recognised target; the guards
 * then stand aside and let the handler produce its own 404.
 */
@Injectable()
export class WriteTargetResolver {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(request: RequestWithSession): Promise<WriteTarget | undefined> {
    const chapterId = request.params['chapterId'];
    if (chapterId) {
      const chapter = await this.prisma.client.chapter.findUnique({
        where: { id: chapterId },
        include: { course: { select: { publicationStatus: true } } },
      });
      if (!chapter) return undefined;
      return {
        publicationStatus: chapter.course.publicationStatus,
        assignedAdminIds: [chapter.assignedAdminId],
      };
    }

    const lessonId = request.params['lessonId'];
    if (lessonId) {
      const lesson = await this.prisma.client.lesson.findUnique({
        where: { id: lessonId },
        include: { chapter: { include: { course: { select: { publicationStatus: true } } } } },
      });
      if (!lesson) return undefined;
      return {
        publicationStatus: lesson.chapter.course.publicationStatus,
        assignedAdminIds: [lesson.assignedAdminId],
      };
    }

    /**
     * PATCH /admin/images/:imageId carries no chapter, lesson or course param,
     * so without this branch the resolver returns undefined, both rule guards
     * stand aside, and the write is unguarded. R-01 and R-02 reach it through
     * the image's own lesson.
     */
    const imageId = request.params['imageId'];
    if (imageId) {
      const image = await this.prisma.client.lessonImage.findUnique({
        where: { id: imageId },
        select: {
          lesson: {
            select: {
              assignedAdminId: true,
              chapter: { select: { course: { select: { publicationStatus: true } } } },
            },
          },
        },
      });
      if (!image) return undefined;
      return {
        publicationStatus: image.lesson.chapter.course.publicationStatus,
        assignedAdminIds: [image.lesson.assignedAdminId],
      };
    }

    const courseId = request.params['courseId'];
    if (courseId) {
      const course = await this.prisma.client.course.findUnique({
        where: { id: courseId },
        select: {
          publicationStatus: true,
          chapters: {
            where: { deletedAt: null },
            select: {
              assignedAdminId: true,
              lessons: { where: { deletedAt: null }, select: { assignedAdminId: true } },
            },
          },
        },
      });
      if (!course) return undefined;
      return {
        publicationStatus: course.publicationStatus,
        assignedAdminIds: course.chapters.flatMap((chapter) => [
          chapter.assignedAdminId,
          ...chapter.lessons.map((lesson) => lesson.assignedAdminId),
        ]),
      };
    }

    return undefined;
  }
}
