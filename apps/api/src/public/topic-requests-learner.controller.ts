import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { errorCodes } from '@knowledge-explorer/shared';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { LearnerSessionGuard } from '../auth/learner-session.guard';
import type { RequestWithSession } from '../auth/session-context';
import {
  TopicRequestsService,
  type MyRequestsView,
  type TopicRequestView,
  type VoteResult,
} from './topic-requests.service';

/**
 * FR-REQ-01's learner writes: submit, vote and withdraw.
 *
 * `submitAndUpvoteTopicRequests` belongs to `learner` alone in §3 — both
 * `admin_owner` and `admin` are false — so a signed-in owner gets 403
 * FORBIDDEN_ROLE here, and in practice 401 first, because `LearnerSessionGuard`
 * reads learner-web's cookie name and admin-web's is a different one. Both
 * refusals are asserted rather than worked around; that is the locked matrix.
 *
 * The board's GET is NOT here. It is anonymous, and a class-level guard would
 * cover it — see PublicTopicRequestsController.
 */
const submitSchema = z.strictObject({
  // Bounds are the controller's, not the column's: §8 types both as TEXT.
  requestedTopicTitle: z.string().trim().min(3).max(120),
  requestDescription: z.string().trim().max(1000).optional(),
});

@Controller()
@UseGuards(LearnerSessionGuard, RolesGuard)
export class TopicRequestsLearnerController {
  constructor(@Inject(TopicRequestsService) private readonly requests: TopicRequestsService) {}

  @Post('topic-requests')
  @RequirePermission('submitAndUpvoteTopicRequests')
  submit(@Body() body: unknown, @Req() request: RequestWithSession): Promise<TopicRequestView> {
    const parsed = submitSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    return this.requests.submit(this.userId(request), {
      requestedTopicTitle: parsed.data.requestedTopicTitle,
      // An empty description is stored as NULL rather than '', so "no
      // description" has one representation in the column.
      requestDescription: parsed.data.requestDescription || null,
    });
  }

  /**
   * FR-REQ-01: one vote per user per request, toggled.
   *
   * No body: the endpoint's meaning is "flip my vote", and the current state
   * comes back in the response. A body carrying the desired state would let two
   * tabs disagree about what "on" means.
   */
  @Post('topic-requests/:requestId/vote')
  @RequirePermission('submitAndUpvoteTopicRequests')
  vote(
    @Param('requestId') requestId: string,
    @Req() request: RequestWithSession,
  ): Promise<VoteResult> {
    return this.requests.vote(requestId, this.userId(request));
  }

  /**
   * FR-REQ-01: withdraw a request while it is still pending.
   *
   * Not in §9.4's table. It is a consequence of the per-user pending cap: a
   * learner holding the maximum with no way to withdraw is stuck until the owner
   * reviews the queue, with no recourse for a misfire.
   */
  @Delete('topic-requests/:requestId')
  @HttpCode(204)
  @RequirePermission('submitAndUpvoteTopicRequests')
  withdraw(
    @Param('requestId') requestId: string,
    @Req() request: RequestWithSession,
  ): Promise<void> {
    return this.requests.withdraw(requestId, this.userId(request));
  }

  /**
   * The caller's own requests. Not in §9.4's table either — it exists because
   * the board carries no attribution, which leaves a learner no way to find
   * their own rows or reach the withdraw endpoint above.
   */
  @Get('me/topic-requests')
  @RequirePermission('submitAndUpvoteTopicRequests')
  mine(@Req() request: RequestWithSession): Promise<MyRequestsView> {
    return this.requests.mine(this.userId(request));
  }

  private userId(request: RequestWithSession): string {
    const userId = request.sessionContext?.userId;
    // The guard populates this before the handler runs; a missing context here
    // would be a wiring fault rather than an anonymous caller.
    if (!userId) throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    return userId;
  }
}
