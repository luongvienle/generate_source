import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { hasAccessToLesson } from '@knowledge-explorer/commerce';
import { errorCodes } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { LearnerSessionGuard } from '../auth/learner-session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { ProgressService, type MyCourseView, type ProgressView } from './progress.service';

/**
 * §9.4's two learner-only endpoints: `/me/courses` and the progress write.
 *
 * UNLIKE the catalog and the reader, these DO declare a permission. §3's
 * `buyAccessReadListenTrackProgress` belongs to `learner` alone — `admin_owner`
 * and `admin` are both false — so a signed-in owner gets 403 FORBIDDEN_ROLE
 * here. That is the locked matrix, not an oversight: progress belongs to
 * someone learning the course, and staff verifying the live experience read it
 * through the public endpoints like any visitor.
 *
 * The guard is `LearnerSessionGuard`, not `SessionGuard`: it resolves the
 * LEARNER cookie. admin-web's cookie is a different name and is ignored here,
 * so identity never depends on which cookie a browser serialises first.
 */
const progressSchema = z.strictObject({
  completed: z.boolean(),
  // §8 stores this as SMALLINT; the range is the column's, not a guess.
  scrollPercentage: z.int().min(0).max(100),
  audioPositionMs: z.int().min(0),
});

@Controller()
@UseGuards(LearnerSessionGuard, RolesGuard)
export class PublicMeController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProgressService) private readonly progress: ProgressService,
  ) {}

  @Get('me/courses')
  @RequirePermission('buyAccessReadListenTrackProgress')
  myCourses(@Req() request: RequestWithSession): Promise<readonly MyCourseView[]> {
    return this.progress.myCourses(this.userId(request));
  }

  /**
   * The learner's own progress for one lesson, so the reader can restore the
   * completion control and resume position on first paint.
   *
   * Not entitlement-gated: it returns only what this learner already wrote, and
   * refusing it after expiry would hide their own history from them. §7.4 keeps
   * progress readable precisely so an expired learner can see what they would
   * be coming back to.
   */
  @Get('lessons/:lessonId/progress')
  @RequirePermission('buyAccessReadListenTrackProgress')
  readProgress(
    @Param('lessonId') lessonId: string,
    @Req() request: RequestWithSession,
  ): Promise<ProgressView> {
    return this.progress.read(this.userId(request), lessonId);
  }

  @Put('lessons/:lessonId/progress')
  @RequirePermission('buyAccessReadListenTrackProgress')
  async writeProgress(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
    @Req() request: RequestWithSession,
  ): Promise<ProgressView> {
    const parsed = progressSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    const userId = this.userId(request);

    /**
     * Entitlement-gated as well as role-gated: progress cannot be written for a
     * lesson the caller may not read. Without this, an expired learner could
     * keep marking lessons complete in a course they can no longer open — and
     * §7.3's resolver would be bypassed by a write path, which is precisely the
     * second access check E-01 warns about.
     */
    if (!(await hasAccessToLesson(this.prisma.client, userId, lessonId))) {
      throw new ForbiddenException({ errorCode: errorCodes.LESSON_NOT_ENTITLED });
    }

    return this.progress.write(userId, lessonId, parsed.data);
  }

  private userId(request: RequestWithSession): string {
    const userId = request.sessionContext?.userId;
    // The guard populates this before the handler runs; a missing context here
    // would be a wiring fault rather than an anonymous caller.
    if (!userId) throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    return userId;
  }
}
