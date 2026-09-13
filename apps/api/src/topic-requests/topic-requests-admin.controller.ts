import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { errorCodes, requestStatusSchema } from '@knowledge-explorer/shared';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import {
  DEFAULT_QUEUE_PAGE_SIZE,
  MAX_QUEUE_PAGE_SIZE,
  TopicRequestsAdminService,
  type QueueRowView,
  type QueueView,
} from './topic-requests-admin.service';

/**
 * §9.2's `GET /topic-requests` and `PATCH /topic-requests/:requestId`.
 *
 * Owner only: §3's `reviewTopicRequests` is true for `admin_owner` and false for
 * both `admin` and `learner`. The endpoint declares the ACTION, never the role,
 * so the matrix in packages/shared/src/roles.ts stays the only place that
 * decision is recorded.
 *
 * `SessionGuard`, not `LearnerSessionGuard` — this is admin-web's surface and
 * reads admin-web's cookie.
 */
const queueQuerySchema = z.strictObject({
  status: z.union([requestStatusSchema, z.literal('all')]).default('pending'),
  sort: z.enum(['upvotes', 'newest']).default('upvotes'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_QUEUE_PAGE_SIZE)
    .default(DEFAULT_QUEUE_PAGE_SIZE),
  /** Filters the course picker, not the request list. */
  courseSearch: z.string().trim().min(1).max(200).optional(),
});

/**
 * One body for all four outcomes.
 *
 * `strictObject` makes "forbidden" free — an unknown key is a 400 before any
 * handler runs. What it cannot express is which combinations of KNOWN keys go
 * together, and each of those needs its own error code so the screen can say
 * what is wrong. Those rules live in the service, checked before any write.
 */
const reviewSchema = z.strictObject({
  requestStatus: requestStatusSchema,
  reviewerNote: z.string().trim().min(3).max(1000).optional(),
  linkedCourseId: z.uuid().optional(),
  duplicateOfRequestId: z.uuid().optional(),
});

@Controller('admin/topic-requests')
@UseGuards(SessionGuard, RolesGuard)
export class TopicRequestsAdminController {
  constructor(
    @Inject(TopicRequestsAdminService) private readonly queue: TopicRequestsAdminService,
  ) {}

  @Get()
  @RequirePermission('reviewTopicRequests')
  list(@Query() query: unknown): Promise<QueueView> {
    const parsed = queueQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });

    return this.queue.queue(parsed.data);
  }

  @Patch(':requestId')
  @RequirePermission('reviewTopicRequests')
  review(
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Req() request: RequestWithSession,
  ): Promise<QueueRowView> {
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    const reviewerId = request.sessionContext?.userId;
    // The guard populates this before the handler runs; a missing context here
    // would be a wiring fault rather than an anonymous caller.
    if (!reviewerId) throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });

    return this.queue.review(requestId, reviewerId, parsed.data);
  }
}
