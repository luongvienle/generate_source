import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { errorCodes } from '@knowledge-explorer/shared';
import { AssignmentGuard } from '../auth/assignment.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { LessonContentService, type Editor } from './lesson-content.service';

/** FR-AUTH-02: identity comes from the session, never from the request body. */
export const editorOf = (request: RequestWithSession): Editor => {
  const session = request.sessionContext;
  if (!session) throw new BadRequestException({ errorCode: errorCodes.UNAUTHENTICATED });
  return { userId: session.userId, userRole: session.userRole };
};

const saveContentSchema = z.strictObject({
  markdown: z.string(),
  /**
   * The `draftUpdatedAt` the editor loaded. Null on a first save. A mismatch
   * means another admin saved in between, and the write is refused rather than
   * silently overwriting their work.
   */
  expectedDraftUpdatedAt: z.iso.datetime().nullable().optional(),
});

/**
 * §9.3 PUT /lessons/:lessonId/content, plus the GET the editor needs to load a
 * draft — §9.3 lists only the write, and an editor cannot open an empty box.
 *
 * GUARDS ARE SPLIT BY METHOD, deliberately. PublishedLockGuard and
 * AssignmentGuard resolve their target from route params and refuse regardless
 * of HTTP method; both are named and documented for writes (R-01: "every write
 * under /api/admin/*", R-02: "an admin may write only where assigned"). Putting
 * the GET behind them would stop an admin READING a lesson in a published
 * course, which is exactly the case the editor must render read-only with an
 * explanation. So the controller declares only session and role, and the PUT
 * adds the two rule guards itself — Nest aggregates controller and method
 * guards, so the write keeps the full P0 chain.
 */
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
export class LessonContentController {
  constructor(@Inject(LessonContentService) private readonly content: LessonContentService) {}

  @Get('lessons/:lessonId/content')
  @RequirePermission('writeLessonDraftContent')
  async read(@Param('lessonId') lessonId: string, @Req() request: RequestWithSession) {
    return this.content.read(lessonId, editorOf(request));
  }

  @Put('lessons/:lessonId/content')
  @RequirePermission('writeLessonDraftContent')
  @UseGuards(PublishedLockGuard, AssignmentGuard)
  async save(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
    @Req() request: RequestWithSession,
  ) {
    const parsed = saveContentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    const expectedDraftUpdatedAt = parsed.data.expectedDraftUpdatedAt
      ? new Date(parsed.data.expectedDraftUpdatedAt)
      : null;

    const outcome = await this.content.save(
      lessonId,
      parsed.data.markdown,
      expectedDraftUpdatedAt,
      editorOf(request),
    );

    // FR-EDIT-01: every error with its position, and nothing written.
    if (outcome.kind === 'invalid') {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.LESSON_CONTENT_INVALID,
        errors: outcome.errors,
      });
    }

    // The current server-side content travels with the 409 so the editor can
    // show what it is up against without a second round trip.
    if (outcome.kind === 'conflict') {
      throw new ConflictException({
        errorCode: errorCodes.LESSON_CONTENT_CONFLICT,
        current: outcome.view,
      });
    }

    return outcome.view;
  }
}
