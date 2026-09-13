import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  markUnpublishedChangesForChapter,
  markUnpublishedChangesForLesson,
} from '@knowledge-explorer/database';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentGuard } from '../auth/assignment.guard';
import { OwnerFieldGuard, OwnerOnlyFields } from '../auth/owner-field.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';

const createLessonSchema = z.strictObject({
  chapterId: z.uuid(),
  lessonOrder: z.int().positive(),
  title: z.string().min(1),
  learningObjective: z.string().min(1).nullish(),
  keyPoints: z.array(z.string().min(1)).optional(),
  estimatedMinutes: z.int().positive().nullish(),
});

const updateLessonSchema = z
  .strictObject({
    title: z.string().min(1).optional(),
    learningObjective: z.string().min(1).nullish(),
    keyPoints: z.array(z.string().min(1)).optional(),
    estimatedMinutes: z.int().positive().nullish(),
    assignedAdminId: z.uuid().nullish(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to change.',
  });

/**
 * Written out rather than inferred: keyPoints is a §8 JSONB column, and Prisma's
 * inferred type for it names a runtime module this workspace cannot reference
 * portably (TS2742).
 */
interface UpdatedLesson {
  id: string;
  title: string;
  learningObjective: string | null;
  keyPoints: unknown;
  estimatedMinutes: number | null;
  assignedAdminId: string | null;
}

/** §9.3 lesson CRUD and assignments. Both roles by §3, narrowed by R-01 and R-02. */
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard, OwnerFieldGuard, PublishedLockGuard, AssignmentGuard)
export class LessonsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * §9.3 GET /my-assignments.
   *
   * R-02 is strictly row-level by decision, so this lists lessons assigned to the
   * caller and says nothing about chapter assignment — see
   * specs/p1-curriculum/spec.md.
   */
  @Get('my-assignments')
  @RequirePermission('createAndEditChaptersAndLessons')
  async myAssignments(@Req() request: RequestWithSession) {
    const userId = request.sessionContext?.userId;
    return this.prisma.client.lesson.findMany({
      where: { assignedAdminId: userId, deletedAt: null },
      orderBy: [{ chapter: { chapterOrder: 'asc' } }, { lessonOrder: 'asc' }],
      select: {
        id: true,
        title: true,
        lessonOrder: true,
        contentStatus: true,
        chapter: {
          select: {
            id: true,
            title: true,
            chapterOrder: true,
            course: { select: { id: true, slug: true, title: true, publicationStatus: true } },
          },
        },
      },
    });
  }

  @Post('lessons')
  @RequirePermission('createAndEditChaptersAndLessons')
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const parsed = createLessonSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    const chapter = await this.prisma.client.chapter.findUnique({
      where: { id: parsed.data.chapterId },
      select: { id: true },
    });
    if (!chapter) throw new NotFoundException({ errorCode: 'CHAPTER_NOT_FOUND' });

    const created = await this.prisma.client.lesson.create({
      data: {
        chapterId: parsed.data.chapterId,
        lessonOrder: parsed.data.lessonOrder,
        title: parsed.data.title,
        learningObjective: parsed.data.learningObjective ?? null,
        keyPoints: parsed.data.keyPoints ?? [],
        estimatedMinutes: parsed.data.estimatedMinutes ?? null,
      },
      select: { id: true, lessonOrder: true, title: true, contentStatus: true },
    });
    // FR-PUB-03: a new lesson changes the table of contents learners see. It is
    // also born `empty`, so the checklist will block the republish until it is
    // authored — which is correct, and surprising enough to be worth saying.
    await markUnpublishedChangesForChapter(this.prisma.client, parsed.data.chapterId);
    return created;
  }

  @Patch('lessons/:lessonId')
  @RequirePermission('createAndEditChaptersAndLessons')
  @OwnerOnlyFields('assignedAdminId')
  async update(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
  ): Promise<UpdatedLesson> {
    const parsed = updateLessonSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    try {
      const updated = await this.prisma.client.lesson.update({
        where: { id: lessonId },
        data: parsed.data,
        select: {
          id: true,
          title: true,
          learningObjective: true,
          keyPoints: true,
          estimatedMinutes: true,
          assignedAdminId: true,
        },
      });
      // FR-PUB-03: the title and estimated minutes are both in §4.3's snapshot.
      await markUnpublishedChangesForLesson(this.prisma.client, lessonId);
      return updated;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
      }
      throw error;
    }
  }

  /** FR-EDIT-04: sets deleted_at; it does not remove the row. */
  @Delete('lessons/:lessonId')
  @RequirePermission('createAndEditChaptersAndLessons')
  async softDelete(@Param('lessonId') lessonId: string) {
    try {
      // FR-PUB-03 BEFORE the delete: markUnpublishedChangesForLesson matches on
      // the lesson through its chapter, and a soft delete does not remove the
      // row, but ordering it first keeps the helper's contract simple — it never
      // has to reason about deleted_at.
      await markUnpublishedChangesForLesson(this.prisma.client, lessonId);
      return await this.prisma.client.lesson.update({
        where: { id: lessonId },
        data: { deletedAt: new Date() },
        select: { id: true, deletedAt: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
      }
      throw error;
    }
  }
}
