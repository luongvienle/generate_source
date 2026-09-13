import { Controller, ForbiddenException, Get, Inject, Param, Req } from '@nestjs/common';
import { hasAccessToLesson } from '@knowledge-explorer/commerce';
import { errorCodes } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { resolveOptionalUserId } from '../auth/optional-session';
import type { RequestWithSession } from '../auth/session-context';
import { ReaderService, type LessonReadView } from './reader.service';

/**
 * §9.4's `GET /lessons/:lessonId`.
 *
 * THIS CONTROLLER DECLARES NO GUARD AND NO PERMISSION, AND THAT IS DELIBERATE.
 * Every other controller in this app sits behind `SessionGuard, RolesGuard` and
 * an `@RequirePermission`, and `UndeclaredPolicyFixtureController` exists to
 * keep that deny-by-default rule under permanent test. §9.4 describes a
 * different surface: public, read-only endpoints that must serve anonymous
 * traffic, because §7.3 permits anonymous reading of free courses and free
 * previews — `hasAccessToCourse` returns true for a free course without
 * consulting `userId` at all.
 *
 * The access decision has not been dropped, it has moved: §7.3's resolver in
 * `packages/commerce` gates every response below, and E-01's regression test
 * (`apps/api/test/entitlement-gates.e2e-spec.ts`) is what holds it there.
 *
 * Role never enters these endpoints. An owner browsing the learner app is a
 * visitor whose grants are empty and who therefore meets the paywall like
 * anyone else; previewing unpublished work is admin-web's job.
 */
@Controller()
export class PublicLessonsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReaderService) private readonly reader: ReaderService,
  ) {}

  @Get('lessons/:lessonId')
  async read(
    @Param('lessonId') lessonId: string,
    @Req() request: RequestWithSession,
  ): Promise<LessonReadView> {
    const userId = await resolveOptionalUserId(this.prisma, request);

    if (!(await hasAccessToLesson(this.prisma.client, userId, lessonId))) {
      // The refusal carries the course, so a paywall renders without a second
      // request — and carries no block, no markdown and no segment, so the
      // content a learner has not paid for never crosses the wire.
      throw new ForbiddenException({
        errorCode: errorCodes.LESSON_NOT_ENTITLED,
        ...(await this.reader.paywallFor(lessonId)),
      });
    }

    return this.reader.read(lessonId);
  }
}
