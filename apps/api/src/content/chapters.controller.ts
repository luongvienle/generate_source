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

/**
 * Minimal write route, present so R-01 and R-02 are enforced and tested on a
 * real endpoint. Full chapter CRUD, reordering and soft delete belong to P1
 * (FR-EDIT-04) and are deliberately absent.
 *
 * Guard order is load-bearing: SessionGuard resolves identity, RolesGuard
 * applies §3, then R-01 and R-02 apply their row-level conditions.
 */
@Controller('admin/chapters')
@UseGuards(SessionGuard, RolesGuard, PublishedLockGuard, AssignmentGuard)
export class ChaptersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Patch(':chapterId')
  @RequirePermission('createAndEditChaptersAndLessons')
  async rename(@Param('chapterId') chapterId: string, @Body() body: unknown) {
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    try {
      return await this.prisma.client.chapter.update({
        where: { id: chapterId },
        data: { title: parsed.data.title },
        select: { id: true, title: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'CHAPTER_NOT_FOUND' });
      }
      throw error;
    }
  }
}
