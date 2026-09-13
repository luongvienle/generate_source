import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { errorCodes } from '@knowledge-explorer/shared';
import {
  markUnpublishedChangesForCourse,
  parkChapterOrders,
  parkLessonOrders,
} from '@knowledge-explorer/database';
import { PrismaService } from '../prisma/prisma.service';

export interface StructureChapter {
  readonly chapterId: string;
  readonly lessonIds: readonly string[];
}

/**
 * FR-EDIT-04: reordering is a single request carrying the full new order, never
 * one request per item.
 *
 * The payload must describe the course's non-deleted rows exactly — no omissions,
 * no strangers. A partial payload would silently leave rows behind at whatever
 * order they happened to hold, which is how a tree ends up disagreeing with
 * itself; refusing whole is the safer failure.
 *
 * The rewrite parks rows in a negative range first because §8's ordering indexes
 * are unique INDEXes, checked per row, and cannot be deferred — see
 * packages/database/src/ordering.ts.
 */
@Injectable()
export class StructureService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async rewrite(courseId: string, chapters: readonly StructureChapter[]): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.chapter.findMany({
        where: { courseId, deletedAt: null },
        select: {
          id: true,
          lessons: { where: { deletedAt: null }, select: { id: true } },
        },
      });

      const expectedChapters = new Set(existing.map((chapter) => chapter.id));
      const expectedLessons = new Set(existing.flatMap((c) => c.lessons.map((l) => l.id)));

      const givenChapters = chapters.map((chapter) => chapter.chapterId);
      const givenLessons = chapters.flatMap((chapter) => chapter.lessonIds);

      const mismatch = (reason: string, details: Record<string, unknown>): never => {
        throw new UnprocessableEntityException({
          errorCode: errorCodes.STRUCTURE_MISMATCH,
          reason,
          ...details,
        });
      };

      if (new Set(givenChapters).size !== givenChapters.length) {
        mismatch('a chapter appears more than once', {});
      }
      if (new Set(givenLessons).size !== givenLessons.length) {
        mismatch('a lesson appears more than once', {});
      }

      const unknownChapters = givenChapters.filter((id) => !expectedChapters.has(id));
      const unknownLessons = givenLessons.filter((id) => !expectedLessons.has(id));
      if (unknownChapters.length > 0 || unknownLessons.length > 0) {
        mismatch('names rows that do not belong to this course', {
          unknownChapters,
          unknownLessons,
        });
      }

      const missingChapters = [...expectedChapters].filter((id) => !givenChapters.includes(id));
      const missingLessons = [...expectedLessons].filter((id) => !givenLessons.includes(id));
      if (missingChapters.length > 0 || missingLessons.length > 0) {
        mismatch('omits rows this course still has', { missingChapters, missingLessons });
      }

      await parkChapterOrders(tx, courseId);
      await parkLessonOrders(tx, [...expectedChapters]);

      for (const [chapterIndex, chapter] of chapters.entries()) {
        await tx.chapter.update({
          where: { id: chapter.chapterId },
          data: { chapterOrder: chapterIndex + 1 },
        });

        for (const [lessonIndex, lessonId] of chapter.lessonIds.entries()) {
          // chapterId is written too: moving a lesson between chapters is part of
          // the same single request, per FR-EDIT-04.
          await tx.lesson.update({
            where: { id: lessonId },
            data: { chapterId: chapter.chapterId, lessonOrder: lessonIndex + 1 },
          });
        }
      }

      // FR-PUB-03: ordering IS §4.3's snapshot, so a reorder is exactly the kind
      // of change a learner would see. Inside the transaction, so a rewrite that
      // rolls back does not leave the flag claiming an edit that never landed.
      await markUnpublishedChangesForCourse(tx, courseId);
    });
  }
}
