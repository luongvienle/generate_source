import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithSession } from './session-context';

export interface WriteTarget {
  readonly publicationStatus: string;
  /** assigned_admin_id of the row being written, from §8. */
  readonly assignedAdminId: string | null;
}

/**
 * Resolves the chapter or lesson a request targets, plus the publication status
 * of its course, so R-01 and R-02 both work from one lookup shape.
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
        assignedAdminId: chapter.assignedAdminId,
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
        assignedAdminId: lesson.assignedAdminId,
      };
    }

    return undefined;
  }
}
