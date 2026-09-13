import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { pricingTypes } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentGuard } from '../auth/assignment.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { StructureService } from './structure.service';
import { AudioService } from './audio.service';

const pricingTypeSchema = z.strictObject({ pricingType: z.enum(pricingTypes) });

/**
 * FR-AUDIO-03: a course has one configured voice in v1.
 *
 * `null` clears it back to the install default (TTS_DEFAULT_VOICE), which is why
 * the field is nullable rather than absent — "use the default" and "leave it
 * alone" are different requests and a PATCH must be able to express both.
 */
const voiceSchema = z.strictObject({
  voiceIdentifier: z.string().min(1).nullable(),
  voiceProviderName: z.string().min(1).nullable().optional(),
});

const structureSchema = z.strictObject({
  chapters: z
    .array(
      z.strictObject({
        chapterId: z.uuid(),
        lessonIds: z.array(z.uuid()),
      }),
    )
    .min(1),
});

@Controller('admin/courses')
@UseGuards(SessionGuard, RolesGuard, PublishedLockGuard, AssignmentGuard)
export class CoursesController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StructureService) private readonly structure: StructureService,
    @Inject(AudioService) private readonly audio: AudioService,
  ) {}

  /**
   * Reads the draft tree. Not in §9.3, which defines no admin read of a course —
   * §9.4's GET /courses/:slug is public and serves the published snapshot only.
   * The curriculum tree screen cannot exist without this.
   */
  @Get(':courseId/structure')
  @RequirePermission('createAndEditChaptersAndLessons')
  async getStructure(@Param('courseId') courseId: string) {
    const course = await this.prisma.client.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        slug: true,
        title: true,
        publicationStatus: true,
        hasUnpublishedChanges: true,
        chapters: {
          where: { deletedAt: null },
          orderBy: { chapterOrder: 'asc' },
          select: {
            id: true,
            chapterOrder: true,
            title: true,
            description: true,
            assignedAdminId: true,
            lessons: {
              where: { deletedAt: null },
              orderBy: { lessonOrder: 'asc' },
              select: {
                id: true,
                lessonOrder: true,
                title: true,
                contentStatus: true,
                assignedAdminId: true,
              },
            },
          },
        },
      },
    });
    if (!course) throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });
    return course;
  }

  /** §9.2. Owner-only by §3. */
  @Patch(':courseId/pricing-type')
  @RequirePermission('createCategoriesAndCourses')
  async setPricingType(@Param('courseId') courseId: string, @Body() body: unknown) {
    const parsed = pricingTypeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    try {
      return await this.prisma.client.course.update({
        where: { id: courseId },
        data: { pricingType: parsed.data.pricingType, updatedAt: new Date() },
        select: { id: true, pricingType: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });
      }
      throw error;
    }
  }

  /**
   * FR-AUDIO-03. Owner-only by §3, matching pricing-type above: §3 declares no
   * "configure voice" action and P5 does not invent one, so this reuses the
   * action §3 already assigns to course configuration.
   */
  @Patch(':courseId/voice')
  @RequirePermission('createCategoriesAndCourses')
  async setVoice(@Param('courseId') courseId: string, @Body() body: unknown) {
    const parsed = voiceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    return this.audio.setVoice(courseId, parsed.data);
  }

  /**
   * FR-EDIT-04: the whole new order in one request.
   *
   * Not in §9.3's route table, which assigns reorder to PATCH /chapters/:id —
   * a shape that cannot express the full sibling order, nor a lesson moving
   * between chapters. See specs/p1-curriculum/spec.md.
   */
  @Patch(':courseId/structure')
  @RequirePermission('createAndEditChaptersAndLessons')
  async setStructure(@Param('courseId') courseId: string, @Body() body: unknown) {
    const parsed = structureSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        errorCode: 'INVALID_BODY',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const course = await this.prisma.client.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });

    await this.structure.rewrite(courseId, parsed.data.chapters);

    return this.prisma.client.chapter.findMany({
      where: { courseId, deletedAt: null },
      orderBy: { chapterOrder: 'asc' },
      select: {
        id: true,
        chapterOrder: true,
        title: true,
        lessons: {
          where: { deletedAt: null },
          orderBy: { lessonOrder: 'asc' },
          select: { id: true, lessonOrder: true, title: true },
        },
      },
    });
  }
}
