import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { errorCodes, type RequestStatus } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * FR-REQ-01's learner half: the public board, submission, voting and withdrawal.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP. No query here selects a user relation,
 * and no view below carries a user id, an email or a display name. §8 records
 * `requested_by_user_id` and the owner's queue serializes it; the board never
 * does. `users.display_name` is null for every magic-link learner today, but the
 * reason for the rule is that the column will hold an email the day somebody
 * backfills it — and this payload is rendered for anonymous visitors.
 *
 * `viewerHasVoted` and `viewerIsRequester` are NOT exceptions to that rule. Both
 * describe the CALLER, are derived from the caller's own session, and are false
 * for everyone when anonymous. They tell a signed-in learner whether their own
 * vote button is filled and why it is disabled on one row; they reveal nothing
 * about anybody else.
 *
 * The owner's queue lives in apps/api/src/topic-requests/, deliberately apart.
 */

/** §9.4 pagination, matching the catalog's bounds rather than inventing new ones. */
export const DEFAULT_BOARD_PAGE_SIZE = 20;
export const MAX_BOARD_PAGE_SIZE = 50;

/**
 * How many unreviewed requests one learner may hold.
 *
 * An abuse brake, not an invariant: two simultaneous submissions at the boundary
 * may both land, and a sixth row is not a correctness failure. Deliberately not
 * defended with a lock — see specs/p9-topic-requests/spec.md.
 */
export const pendingCap = (): number => {
  const raw = Number(process.env['TOPIC_REQUEST_PENDING_CAP'] ?? '5');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
};

const PENDING = 'pending';
const ACCEPTED = 'accepted';
const DUPLICATED = 'duplicated';

/**
 * A concurrent toggle took the write first.
 *
 * P2002 is the vote row's primary key refusing a second insert; P2025 is a
 * delete finding nothing left to delete. Both mean another request for the same
 * (request, user) pair committed while this transaction was open — not a fault.
 * Matched on the code rather than by importing Prisma's error class, which would
 * pull a generated-client type into the HTTP layer for one comparison.
 */
const isRaceCollision = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002' || code === 'P2025';
};

export interface TopicRequestView {
  readonly id: string;
  readonly requestedTopicTitle: string;
  readonly requestDescription: string | null;
  readonly requestStatus: RequestStatus;
  readonly upvoteCount: number;
  readonly createdAt: string;
  readonly reviewerNote: string | null;
  readonly linkedCourse: { readonly slug: string; readonly title: string } | null;
  readonly viewerHasVoted: boolean;
  readonly viewerIsRequester: boolean;
}

export interface BoardGroup {
  readonly items: readonly TopicRequestView[];
  readonly total: number;
}

export interface BoardView {
  /** `pending`, most-wanted first. The only group that paginates. */
  readonly open: BoardGroup & { readonly page: number; readonly pageSize: number };
  /** `accepted`. The board's best argument for signing up. */
  readonly built: BoardGroup;
  /** `rejected` and `duplicated`. `items` is empty unless `includeClosed`. */
  readonly closed: BoardGroup;
}

export interface MyRequestView extends TopicRequestView {
  /** Withdrawal is pending-only, so the page does not have to restate the rule. */
  readonly canWithdraw: boolean;
}

export interface MyRequestsView {
  readonly items: readonly MyRequestView[];
  readonly pendingCount: number;
  readonly pendingCap: number;
}

export interface VoteResult {
  readonly upvoteCount: number;
  readonly viewerHasVoted: boolean;
}

export interface BoardQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly includeClosed: boolean;
}

/** The row shape every serializer below reads. Kept in one place so a later
 *  `include` cannot quietly widen what reaches the board. */
const ROW_SELECT = {
  id: true,
  requestedByUserId: true,
  requestedTopicTitle: true,
  requestDescription: true,
  requestStatus: true,
  upvoteCount: true,
  reviewerNote: true,
  createdAt: true,
  linkedCourse: { select: { slug: true, title: true, publicationStatus: true } },
} as const;

interface Row {
  id: string;
  requestedByUserId: string;
  requestedTopicTitle: string;
  requestDescription: string | null;
  requestStatus: string;
  upvoteCount: number;
  reviewerNote: string | null;
  createdAt: Date;
  linkedCourse: { slug: string; title: string; publicationStatus: string } | null;
}

@Injectable()
export class TopicRequestsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * FR-REQ-01's board, in three groups. `viewerId` is null for an anonymous visitor.
   *
   * Only `open` paginates — it is the group that grows, and the one a learner
   * scrolls to find something to vote for. `built` and `closed` are capped at
   * MAX_BOARD_PAGE_SIZE with no page parameter: a named bound, not an oversight.
   *
   * `closed` returns its total always and its items only on request, so the
   * collapsed header can show a count without shipping a list nobody expanded.
   */
  async board(query: BoardQuery, viewerId: string | null): Promise<BoardView> {
    const CLOSED = { requestStatus: { in: ['rejected', DUPLICATED] } };

    const [openRows, openTotal, builtRows, builtTotal, closedRows, closedTotal] =
      await Promise.all([
        this.prisma.client.topicRequest.findMany({
          where: { requestStatus: PENDING },
          select: ROW_SELECT,
          orderBy: [{ upvoteCount: 'desc' }, { createdAt: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.client.topicRequest.count({ where: { requestStatus: PENDING } }),
        this.prisma.client.topicRequest.findMany({
          where: { requestStatus: ACCEPTED },
          select: ROW_SELECT,
          orderBy: { createdAt: 'desc' },
          take: MAX_BOARD_PAGE_SIZE,
        }),
        this.prisma.client.topicRequest.count({ where: { requestStatus: ACCEPTED } }),
        query.includeClosed
          ? this.prisma.client.topicRequest.findMany({
              where: CLOSED,
              select: ROW_SELECT,
              orderBy: { createdAt: 'desc' },
              take: MAX_BOARD_PAGE_SIZE,
            })
          : Promise.resolve([]),
        this.prisma.client.topicRequest.count({ where: CLOSED }),
      ]);

    const all = [...openRows, ...builtRows, ...closedRows];
    const voted = await this.votedIds(
      all.map((row) => row.id),
      viewerId,
    );
    const view = (row: unknown) => this.toView(row as Row, viewerId, voted);

    return {
      open: {
        items: openRows.map(view),
        total: openTotal,
        page: query.page,
        pageSize: query.pageSize,
      },
      built: { items: builtRows.map(view), total: builtTotal },
      closed: { items: closedRows.map(view), total: closedTotal },
    };
  }

  /**
   * FR-REQ-01: submit.
   *
   * The cap is read and the row written in one transaction. A new request starts
   * at zero upvotes, not one — a learner may not vote for their own, so seeding
   * a self-vote would put a floor under every row.
   */
  async submit(
    userId: string,
    input: { requestedTopicTitle: string; requestDescription: string | null },
  ): Promise<TopicRequestView> {
    const cap = pendingCap();

    const row = await this.prisma.client.$transaction(async (tx) => {
      const pending = await tx.topicRequest.count({
        where: { requestedByUserId: userId, requestStatus: PENDING },
      });
      if (pending >= cap) {
        throw new ConflictException({
          errorCode: errorCodes.TOPIC_REQUEST_LIMIT_REACHED,
          pendingCount: pending,
          pendingCap: cap,
        });
      }

      return tx.topicRequest.create({
        data: {
          requestedByUserId: userId,
          requestedTopicTitle: input.requestedTopicTitle,
          requestDescription: input.requestDescription,
        },
        select: ROW_SELECT,
      });
    });

    return this.toView(row as Row, userId, new Set());
  }

  /**
   * FR-REQ-01: toggle an upvote.
   *
   * THE COUNTER IS A CACHE OF THE PRIMARY KEY, AND THIS TRANSACTION IS WHY IT
   * STAYS TRUE. `(topic_request_id, user_id)` is what actually makes "one vote
   * per user per request" hold; `upvote_count` merely records how many such rows
   * exist, because §8 put the column there. So the vote row and the counter move
   * together inside one transaction, and the counter moves by `increment` /
   * `decrement` rather than a read-modify-write — two concurrent toggles that
   * both read the same integer would otherwise both write the same result and
   * lose a vote.
   *
   * Under a race, the loser collides on the primary key and its whole
   * transaction rolls back, taking its increment with it. That surfaces here as
   * a known Prisma error rather than a 500: the toggle is not retried, because
   * retrying a toggle is a coin flip on whether the caller ends up voted or not
   * — instead the current, true state is read back and returned.
   */
  async vote(requestId: string, userId: string): Promise<VoteResult> {
    const request = await this.prisma.client.topicRequest.findUnique({
      where: { id: requestId },
      select: { requestStatus: true, requestedByUserId: true },
    });
    if (!request) {
      throw new NotFoundException({ errorCode: errorCodes.TOPIC_REQUEST_NOT_FOUND });
    }
    if (request.requestStatus !== PENDING) {
      // Once the owner has ruled, the count is the record of the demand that
      // produced the decision and must stop moving.
      throw new ConflictException({ errorCode: errorCodes.TOPIC_REQUEST_NOT_PENDING });
    }
    if (request.requestedByUserId === userId) {
      throw new ConflictException({ errorCode: errorCodes.TOPIC_REQUEST_OWN });
    }

    const key = { topicRequestId_userId: { topicRequestId: requestId, userId } };

    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const existing = await tx.topicRequestVote.findUnique({
          where: key,
          select: { topicRequestId: true },
        });

        if (existing) {
          await tx.topicRequestVote.delete({ where: key });
          const row = await tx.topicRequest.update({
            where: { id: requestId },
            data: { upvoteCount: { decrement: 1 } },
            select: { upvoteCount: true },
          });
          return { upvoteCount: row.upvoteCount, viewerHasVoted: false };
        }

        await tx.topicRequestVote.create({ data: { topicRequestId: requestId, userId } });
        const row = await tx.topicRequest.update({
          where: { id: requestId },
          data: { upvoteCount: { increment: 1 } },
          select: { upvoteCount: true },
        });
        return { upvoteCount: row.upvoteCount, viewerHasVoted: true };
      });
    } catch (error) {
      if (!isRaceCollision(error)) throw error;
      return this.voteState(requestId, userId);
    }
  }

  /**
   * FR-REQ-01: withdraw.
   *
   * Own AND pending only. A row belonging to somebody else is reported as
   * absent rather than forbidden — a 403 would confirm the id is real and
   * someone else's, which is information the caller has no claim to.
   *
   * The votes go with it: `topic_request_votes.topic_request_id` is ON DELETE
   * CASCADE in the initial migration. A duplicate pointing AT this row keeps its
   * status and has its pointer nulled, by the SET NULL added in P9's migration —
   * the alternative was this delete failing with a foreign-key error the learner
   * could do nothing about.
   */
  async withdraw(requestId: string, userId: string): Promise<void> {
    const row = await this.prisma.client.topicRequest.findUnique({
      where: { id: requestId },
      select: { requestedByUserId: true, requestStatus: true },
    });
    if (!row || row.requestedByUserId !== userId) {
      throw new NotFoundException({ errorCode: errorCodes.TOPIC_REQUEST_NOT_FOUND });
    }
    if (row.requestStatus !== PENDING) {
      throw new ConflictException({ errorCode: errorCodes.TOPIC_REQUEST_NOT_PENDING });
    }
    await this.prisma.client.topicRequest.delete({ where: { id: requestId } });
  }

  /**
   * The caller's own requests, every status, newest first.
   *
   * This endpoint exists because the board carries no attribution: with no
   * submitter field there, a learner has no way to find their own rows and the
   * withdraw endpoint is unreachable from any UI. It returns only rows the
   * caller submitted, so it adds no visibility the board withholds.
   */
  async mine(userId: string): Promise<MyRequestsView> {
    const cap = pendingCap();
    const [rows, pendingCount] = await Promise.all([
      this.prisma.client.topicRequest.findMany({
        where: { requestedByUserId: userId },
        select: ROW_SELECT,
        orderBy: { createdAt: 'desc' },
        take: MAX_BOARD_PAGE_SIZE,
      }),
      // Counted, not derived from `rows`: the list is capped at MAX_BOARD_PAGE_SIZE
      // and a learner with more reviewed requests than that would otherwise be
      // told they have fewer pending than they do — and then refused on submit.
      this.prisma.client.topicRequest.count({
        where: { requestedByUserId: userId, requestStatus: PENDING },
      }),
    ]);

    const voted = await this.votedIds(
      rows.map((row) => row.id),
      userId,
    );

    const items = rows.map((row) => ({
      ...this.toView(row as Row, userId, voted),
      canWithdraw: (row as Row).requestStatus === PENDING,
    }));

    return { items, pendingCount, pendingCap: cap };
  }

  /** The true current state, after a concurrent toggle took the write. */
  private async voteState(requestId: string, userId: string): Promise<VoteResult> {
    const [row, vote] = await Promise.all([
      this.prisma.client.topicRequest.findUnique({
        where: { id: requestId },
        select: { upvoteCount: true },
      }),
      this.prisma.client.topicRequestVote.findUnique({
        where: { topicRequestId_userId: { topicRequestId: requestId, userId } },
        select: { topicRequestId: true },
      }),
    ]);
    if (!row) throw new NotFoundException({ errorCode: errorCodes.TOPIC_REQUEST_NOT_FOUND });
    return { upvoteCount: row.upvoteCount, viewerHasVoted: vote !== null };
  }

  private async votedIds(
    requestIds: readonly string[],
    viewerId: string | null,
  ): Promise<ReadonlySet<string>> {
    if (!viewerId || requestIds.length === 0) return new Set();
    const votes = await this.prisma.client.topicRequestVote.findMany({
      where: { userId: viewerId, topicRequestId: { in: [...requestIds] } },
      select: { topicRequestId: true },
    });
    return new Set(votes.map((vote) => vote.topicRequestId));
  }

  private toView(row: Row, viewerId: string | null, voted: ReadonlySet<string>): TopicRequestView {
    return {
      id: row.id,
      requestedTopicTitle: row.requestedTopicTitle,
      requestDescription: row.requestDescription,
      requestStatus: row.requestStatus as RequestStatus,
      upvoteCount: row.upvoteCount,
      createdAt: row.createdAt.toISOString(),
      reviewerNote: row.reviewerNote,
      /**
       * Only a PUBLISHED course is named. An accepted request pointing at a
       * course still in draft renders as built with no link, rather than as a
       * dead link into a 404 — and §4.3 keeps a draft course's slug private.
       */
      linkedCourse:
        row.linkedCourse && row.linkedCourse.publicationStatus === 'published'
          ? { slug: row.linkedCourse.slug, title: row.linkedCourse.title }
          : null,
      viewerHasVoted: voted.has(row.id),
      viewerIsRequester: viewerId !== null && row.requestedByUserId === viewerId,
    };
  }
}
