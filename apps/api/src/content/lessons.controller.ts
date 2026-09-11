import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentGuard } from '../auth/assignment.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';

const renameSchema = z.object({ title: z.string().min(1) });

/** Minimal write route for R-01/R-02 coverage. Lesson CRUD proper is P1. */
@Controller('admin/lessons')
@UseGuards(SessionGuard, RolesGuard, PublishedLockGuard, AssignmentGuard)
export class LessonsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Patch(':lessonId')
  @RequirePermission('createAndEditChaptersAndLessons')
  async rename(@Param('lessonId') lessonId: string, @Body() body: unknown) {
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    try {
      return await this.prisma.client.lesson.update({
        where: { id: lessonId },
        data: { title: parsed.data.title },
        select: { id: true, title: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
      }
      throw error;
    }
  }
}
