import { BadRequestException, Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { resolveOptionalUserId } from '../auth/optional-session';
import type { RequestWithSession } from '../auth/session-context';
import {
  DEFAULT_BOARD_PAGE_SIZE,
  MAX_BOARD_PAGE_SIZE,
  TopicRequestsService,
  type BoardView,
} from './topic-requests.service';

/**
 * FR-REQ-01's board, anonymous.
 *
 * NO `@UseGuards` AND NO `@RequirePermission`, DELIBERATELY. §9.4 lists no GET
 * for topic requests at all, which leaves a learner unable to discover a request
 * to upvote and half of FR-REQ-01 unimplementable; specs/p9-topic-requests/
 * spec.md adds this endpoint and makes it anonymous for the same reason the
 * catalog is — a visitor seeing what other people asked for is the board's
 * argument for signing up.
 *
 * Adding a guard here breaks that. Adding `@RequirePermission` without one does
 * nothing at all. The absence is asserted by name in
 * apps/api/test/topic-requests.e2e-spec.ts so a later reader does not "fix" it,
 * exactly as PublicCatalogController's is.
 *
 * The learner-authenticated half lives in TopicRequestsLearnerController, split
 * by auth model rather than by resource, because a class-level guard is how
 * every guarded controller in this app declares itself.
 */
const boardQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_BOARD_PAGE_SIZE)
    .default(DEFAULT_BOARD_PAGE_SIZE),
  /**
   * The closed group's TOTAL is always returned; its items only when asked for.
   * The board renders that section collapsed behind `?closed=1`, so the default
   * response does not carry a list nobody expanded.
   */
  includeClosed: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

@Controller()
export class PublicTopicRequestsController {
  constructor(
    @Inject(TopicRequestsService) private readonly requests: TopicRequestsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get('topic-requests')
  async board(@Query() query: unknown, @Req() request: RequestWithSession): Promise<BoardView> {
    const parsed = boardQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });

    // Identity is resolved here rather than by a guard: being signed out is an
    // ordinary state on this endpoint, and `resolveOptionalSession` never throws.
    const viewerId = await resolveOptionalUserId(this.prisma, request);
    return this.requests.board(parsed.data, viewerId);
  }
}
