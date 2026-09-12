import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentGuard } from '../auth/assignment.guard';
import { OwnerFieldGuard, OwnerOnlyFields } from '../auth/owner-field.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';

const createChapterSchema = z.strictObject({
  courseId: z.uuid(),
  chapterOrder: z.int().positive(),
  title: z.string().min(1),
  description: z.string().min(1).nullish(),
});

const updateChapterSchema = z
  .strictObject({
    title: z.string().min(1).optional(),
    description: z.string().min(1).nullish(),
    assignedAdminId: z.uuid().nullish(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to change.',
  });

/**
 * §9.3 chapter CRUD. Both roles by §3, narrowed by R-01 and R-02.
 *
 * Reordering is NOT here: FR-EDIT-04 requires the full sibling order in one
 * request, which lives on PATCH /courses/:courseId/structure.
 */
@Controller('admin/chapters')
@UseGuards(SessionGuard, RolesGuard, OwnerFieldGuard, PublishedLockGuard, AssignmentGuard)
export class ChaptersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post()
  @RequirePermission('createAndEditChaptersAndLessons')
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const parsed = createChapterSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    const course = await this.prisma.client.course.findUnique({
      where: { id: parsed.data.courseId },
      select: { id: true },
    });
    if (!course) throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });

    return this.prisma.client.chapter.create({
      data: {
        courseId: parsed.data.courseId,
        chapterOrder: parsed.data.chapterOrder,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
      },
      select: { id: true, chapterOrder: true, title: true, description: true },
    });
  }

  @Patch(':chapterId')
  @RequirePermission('createAndEditChaptersAndLessons')
  @OwnerOnlyFields('assignedAdminId')
  async update(@Param('chapterId') chapterId: string, @Body() body: unknown) {
    const parsed = updateChapterSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    try {
      return await this.prisma.client.chapter.update({
        where: { id: chapterId },
        data: parsed.data,
        select: { id: true, title: true, description: true, assignedAdminId: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'CHAPTER_NOT_FOUND' });
      }
      throw error;
    }
  }

  /** FR-EDIT-04: sets deleted_at; it does not remove the row. */
  @Delete(':chapterId')
  @RequirePermission('createAndEditChaptersAndLessons')
  async softDelete(@Param('chapterId') chapterId: string) {
    try {
      const deletedAt = new Date();
      const chapter = await this.prisma.client.chapter.update({
        where: { id: chapterId },
        data: { deletedAt },
        select: { id: true, deletedAt: true },
      });
      // A chapter's lessons go with it; §8 makes both soft-deletable and neither
      // cascades on a soft delete.
      await this.prisma.client.lesson.updateMany({
        where: { chapterId, deletedAt: null },
        data: { deletedAt },
      });
      return chapter;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'CHAPTER_NOT_FOUND' });
      }
      throw error;
    }
  }
}
