import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-REQ-01 — specs/p9-topic-requests/spec.md.
 *
 * Four properties here would pass a casual reading while being wrong:
 *
 *  - **the board carries no submitter identity.** A single `include` added for
 *    the owner's queue and reused by the board serializer leaks an email onto an
 *    anonymous page, and every functional test still passes.
 *  - **the board has no guard, on purpose.** An absence looks exactly like an
 *    oversight. Asserted by name below.
 *  - **`upvote_count` equals `COUNT(topic_request_votes)` under concurrency.**
 *    Sequential toggles pass against an implementation that is entirely broken.
 *  - **a refused PATCH writes nothing.** Half-applying a rejected body is the
 *    mixed-write failure OwnerFieldGuard exists to prevent elsewhere.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const api = () => request(app.getHttpServer());

let app: INestApplication;
let ownerId = '';
let ownerToken = '';
let adminToken = '';
let learnerAId = '';
let learnerAToken = '';
let learnerBId = '';
let learnerBToken = '';

const learnerCookie = (token: string) => `authjs.learner-session-token=${token}`;
const adminCookie = (token: string) => `authjs.session-token=${token}`;

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-req-${run}@example.test`, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-req-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

const titles: string[] = [];
const title = (label: string): string => {
  const value = `${label} ${run}`;
  titles.push(value);
  return value;
};

beforeAll(async () => {
  [ownerId, ownerToken] = await seedUser('owner', 'admin_owner');
  [, adminToken] = await seedUser('admin', 'admin');
  [learnerAId, learnerAToken] = await seedUser('learner-a', 'learner');
  [learnerBId, learnerBToken] = await seedUser('learner-b', 'learner');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await prisma.topicRequest.deleteMany({
    where: { requestedTopicTitle: { endsWith: run } },
  });
  await prisma.course.deleteMany({ where: { slug: { contains: run } } });
  await prisma.category.deleteMany({ where: { slug: { contains: run } } });
  await prisma.user.deleteMany({ where: { email: { contains: `-req-${run}@` } } });
  await app.close();
});

interface BoardItem {
  id: string;
  requestedTopicTitle: string;
  requestDescription: string | null;
  requestStatus: string;
  upvoteCount: number;
  reviewerNote: string | null;
  linkedCourse: { slug: string; title: string } | null;
  viewerHasVoted: boolean;
  viewerIsRequester: boolean;
}

/** Only this run's rows; the suites share one database. */
const ours = (body: { open: { items: BoardItem[] } }): BoardItem[] =>
  body.open.items.filter((item) => item.requestedTopicTitle.endsWith(run));

describe('FR-REQ-01 submission', () => {
  it('creates a pending request at zero upvotes', async () => {
    const response = await api()
      .post('/api/topic-requests')
      .set('Cookie', learnerCookie(learnerAToken))
      .send({ requestedTopicTitle: title('Korean TOPIK I'), requestDescription: 'TOPIK prep' })
      .expect(201);

    expect(response.body.requestStatus).toBe('pending');
    // Zero, not one: a learner may not vote for their own request, so seeding a
    // self-vote would put a floor of 1 under every row.
    expect(response.body.upvoteCount).toBe(0);
    expect(response.body.viewerIsRequester).toBe(true);
    expect(response.body.viewerHasVoted).toBe(false);
  });

  it('stores an absent description as null rather than an empty string', async () => {
    const response = await api()
      .post('/api/topic-requests')
      .set('Cookie', learnerCookie(learnerAToken))
      .send({ requestedTopicTitle: title('Business Japanese') })
      .expect(201);

    expect(response.body.requestDescription).toBeNull();
  });

  it.each([
    ['too short', { requestedTopicTitle: 'ab' }],
    ['too long', { requestedTopicTitle: 'x'.repeat(121) }],
    ['unknown field', { requestedTopicTitle: 'A valid title', upvoteCount: 99 }],
    ['missing title', { requestDescription: 'no title' }],
  ])('refuses a body that is %s', async (_label, body) => {
    await api()
      .post('/api/topic-requests')
      .set('Cookie', learnerCookie(learnerAToken))
      .send(body)
      .expect(400);
  });
});

describe('§3 — who may submit', () => {
  it('refuses an anonymous submission', async () => {
    const response = await api()
      .post('/api/topic-requests')
      .send({ requestedTopicTitle: 'Anonymous attempt' })
      .expect(401);
    expect(response.body.errorCode).toBe('UNAUTHENTICATED');
  });

  it("refuses admin-web's cookie, because LearnerSessionGuard does not read it", async () => {
    // Not a role refusal: the owner simply carries no learner cookie. This is
    // §3 delivered by the two-cookie split rather than by the matrix.
    const response = await api()
      .post('/api/topic-requests')
      .set('Cookie', adminCookie(ownerToken))
      .send({ requestedTopicTitle: 'Owner attempt' })
      .expect(401);
    expect(response.body.errorCode).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['admin_owner', () => ownerToken],
    ['admin', () => adminToken],
  ])('refuses %s holding a learner-named cookie with FORBIDDEN_ROLE', async (_role, token) => {
    // §3 gives submitAndUpvoteTopicRequests to `learner` alone. If staff ever
    // reach this guard, the matrix — not the cookie — must be what stops them.
    const response = await api()
      .post('/api/topic-requests')
      .set('Cookie', learnerCookie(token()))
      .send({ requestedTopicTitle: 'Staff attempt' })
      .expect(403);
    expect(response.body.errorCode).toBe('FORBIDDEN_ROLE');
  });
});

describe('the board', () => {
  /**
   * The guard chain is ABSENT here and that is the design, not an oversight.
   *
   * This test is named for the absence so a later reader who "fixes" the
   * missing @UseGuards sees a failure that explains itself. Its twin for the
   * reader is entitlement-gates.e2e-spec.ts.
   */
  it('serves an anonymous caller — no guard, no permission, deliberately', async () => {
    const response = await api().get('/api/topic-requests').expect(200);
    expect(response.body.open.items.length).toBeGreaterThan(0);
  });

  it('carries no submitter identity anywhere in the payload', async () => {
    const response = await api().get('/api/topic-requests').expect(200);

    // The strongest available form: no learner email or id appears ANYWHERE in
    // the serialized response, whatever field a future change might add.
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('@example.test');
    expect(raw).not.toContain(learnerAId);
    expect(raw).not.toContain(learnerBId);
    for (const item of response.body.open.items as BoardItem[]) {
      expect(item).not.toHaveProperty('requestedByUserId');
      expect(item).not.toHaveProperty('requestedByEmail');
      expect(item).not.toHaveProperty('requestedByUser');
    }
  });

  it('reports viewer fields as false for an anonymous caller', async () => {
    const response = await api().get('/api/topic-requests').expect(200);
    for (const item of ours(response.body)) {
      expect(item.viewerHasVoted).toBe(false);
      expect(item.viewerIsRequester).toBe(false);
    }
  });

  it("marks the caller's own rows when a learner cookie is present", async () => {
    const response = await api()
      .get('/api/topic-requests')
      .set('Cookie', learnerCookie(learnerAToken))
      .expect(200);

    const mine = ours(response.body);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((item) => item.viewerIsRequester)).toBe(true);
  });

  it('orders by upvotes descending and paginates', async () => {
    const response = await api().get('/api/topic-requests?page=1&pageSize=1').expect(200);
    expect(response.body.open.items).toHaveLength(1);
    expect(response.body.open.pageSize).toBe(1);
    expect(response.body.open.total).toBeGreaterThan(1);
  });

  it.each([
    ['a page size above the cap', '?pageSize=500'],
    ['an unknown parameter', '?sort=upvotes'],
    ['a non-numeric page', '?page=first'],
  ])('refuses %s', async (_label, query) => {
    await api().get(`/api/topic-requests${query}`).expect(400);
  });

  it('lists only pending requests', async () => {
    const reviewed = await prisma.topicRequest.create({
      data: {
        requestedByUserId: learnerBId,
        requestedTopicTitle: `Already reviewed ${run}`,
        requestStatus: 'rejected',
        reviewerNote: 'no',
      },
      select: { id: true },
    });

    const response = await api().get('/api/topic-requests?pageSize=50').expect(200);
    expect(response.body.open.items.map((i: { id: string }) => i.id)).not.toContain(reviewed.id);
  });
});

describe('FR-REQ-01 voting', () => {
  let requestId = '';

  beforeAll(async () => {
    const created = await prisma.topicRequest.create({
      data: { requestedByUserId: learnerAId, requestedTopicTitle: title('Votable') },
      select: { id: true },
    });
    requestId = created.id;
  });

  const vote = (token: string, id = requestId) =>
    api().post(`/api/topic-requests/${id}/vote`).set('Cookie', learnerCookie(token));

  /** The counter is a cache of COUNT(topic_request_votes). This is the check. */
  const assertCounterMatchesRows = async (id = requestId) => {
    const [row, votes] = await Promise.all([
      prisma.topicRequest.findUniqueOrThrow({
        where: { id },
        select: { upvoteCount: true },
      }),
      prisma.topicRequestVote.count({ where: { topicRequestId: id } }),
    ]);
    expect(row.upvoteCount, 'upvote_count drifted from topic_request_votes').toBe(votes);
  };

  it('toggles on, off and on again, keeping the counter equal to the vote rows', async () => {
    const on = await vote(learnerBToken).expect(201);
    expect(on.body).toEqual({ upvoteCount: 1, viewerHasVoted: true });
    await assertCounterMatchesRows();

    const off = await vote(learnerBToken).expect(201);
    expect(off.body).toEqual({ upvoteCount: 0, viewerHasVoted: false });
    await assertCounterMatchesRows();

    const again = await vote(learnerBToken).expect(201);
    expect(again.body).toEqual({ upvoteCount: 1, viewerHasVoted: true });
    await assertCounterMatchesRows();
  });

  it('reports the vote back on the board for the voter and not for anyone else', async () => {
    const asVoter = await api()
      .get('/api/topic-requests?pageSize=50')
      .set('Cookie', learnerCookie(learnerBToken))
      .expect(200);
    expect(ours(asVoter.body).find((item) => item.id === requestId)?.viewerHasVoted).toBe(true);

    const anonymous = await api().get('/api/topic-requests?pageSize=50').expect(200);
    expect(ours(anonymous.body).find((item) => item.id === requestId)?.viewerHasVoted).toBe(false);
  });

  it('refuses a vote on the caller’s own request', async () => {
    const response = await vote(learnerAToken).expect(409);
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_OWN');
    await assertCounterMatchesRows();
  });

  it('refuses a vote on a request that has been reviewed', async () => {
    const reviewed = await prisma.topicRequest.create({
      data: {
        requestedByUserId: learnerAId,
        requestedTopicTitle: title('Settled'),
        requestStatus: 'accepted',
      },
      select: { id: true },
    });

    const response = await vote(learnerBToken, reviewed.id).expect(409);
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_NOT_PENDING');
  });

  it('refuses a vote on an unknown request', async () => {
    const response = await vote(learnerBToken, '00000000-0000-4000-8000-000000000000').expect(404);
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_NOT_FOUND');
  });

  /**
   * One caller, eight simultaneous clicks. This exercises the COLLISION path —
   * the vote row's primary key admits exactly one insert and the losers must
   * come back with the true state rather than a 500.
   *
   * It does NOT prove the counter is safe, and a version of this test that
   * claimed to was the first thing written here: with a single voter the primary
   * key serializes every write, so even a read-modify-write counter survives it.
   * The test below is the one with teeth.
   */
  it('survives eight simultaneous toggles from one caller without a 500', async () => {
    const contested = await prisma.topicRequest.create({
      data: { requestedByUserId: learnerAId, requestedTopicTitle: title('Contested') },
      select: { id: true },
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => vote(learnerBToken, contested.id)),
    );

    for (const response of responses) {
      expect(response.status, `a concurrent toggle returned ${response.status}`).toBeLessThan(500);
    }
    await assertCounterMatchesRows(contested.id);
  });

  /**
   * The assertion this phase exists to need.
   *
   * EIGHT DIFFERENT LEARNERS, one request, all at once. No primary key stands
   * between them — each writes its own vote row — so the only thing keeping
   * `upvote_count` equal to `COUNT(topic_request_votes)` is that the counter
   * moves by `{ increment: 1 }` inside the same transaction as the row. Replace
   * that with a read-modify-write and this test loses votes immediately, which is
   * exactly the defect that has no symptom in production until the owner sorts
   * the queue by a number that has been quietly wrong for months.
   */
  it('holds upvote_count === COUNT(votes) when eight different learners vote at once', async () => {
    const contested = await prisma.topicRequest.create({
      data: { requestedByUserId: learnerAId, requestedTopicTitle: title('Crowded') },
      select: { id: true },
    });

    const voters = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => seedUser(`crowd-${index}`, 'learner')),
    );

    const responses = await Promise.all(voters.map(([, token]) => vote(token, contested.id)));

    for (const response of responses) {
      expect(response.status, `a concurrent voter returned ${response.status}`).toBe(201);
    }

    const row = await prisma.topicRequest.findUniqueOrThrow({
      where: { id: contested.id },
      select: { upvoteCount: true },
    });
    expect(row.upvoteCount, 'votes were lost to a counter race').toBe(8);
    await assertCounterMatchesRows(contested.id);
  });
});

describe('the pending cap and withdrawal', () => {
  let capLearnerId = '';
  let capToken = '';

  beforeAll(async () => {
    [capLearnerId, capToken] = await seedUser('capped', 'learner');
  });

  const submit = (token: string, label: string) =>
    api()
      .post('/api/topic-requests')
      .set('Cookie', learnerCookie(token))
      .send({ requestedTopicTitle: title(label) });

  it('refuses a submission past the cap, naming the cap and the current count', async () => {
    const cap = Number(process.env['TOPIC_REQUEST_PENDING_CAP'] ?? '5');

    for (let index = 0; index < cap; index += 1) {
      await submit(capToken, `Capped ${index}`).expect(201);
    }

    const refused = await submit(capToken, 'One too many').expect(409);
    expect(refused.body.errorCode).toBe('TOPIC_REQUEST_LIMIT_REACHED');
    expect(refused.body.pendingCap).toBe(cap);
    expect(refused.body.pendingCount).toBe(cap);
  });

  it('reports the cap through /me/topic-requests', async () => {
    const response = await api()
      .get('/api/me/topic-requests')
      .set('Cookie', learnerCookie(capToken))
      .expect(200);

    expect(response.body.pendingCount).toBe(response.body.pendingCap);
    expect(response.body.items.length).toBeGreaterThan(0);
    expect(response.body.items.every((item: { canWithdraw: boolean }) => item.canWithdraw)).toBe(
      true,
    );
  });

  it('frees a slot when a request is withdrawn, and takes its votes with it', async () => {
    const before = await api()
      .get('/api/me/topic-requests')
      .set('Cookie', learnerCookie(capToken))
      .expect(200);
    const victim = before.body.items[0] as { id: string };

    // A vote from someone else, so the cascade has something to remove.
    await api()
      .post(`/api/topic-requests/${victim.id}/vote`)
      .set('Cookie', learnerCookie(learnerBToken))
      .expect(201);
    expect(await prisma.topicRequestVote.count({ where: { topicRequestId: victim.id } })).toBe(1);

    await api()
      .delete(`/api/topic-requests/${victim.id}`)
      .set('Cookie', learnerCookie(capToken))
      .expect(204);

    expect(await prisma.topicRequest.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(await prisma.topicRequestVote.count({ where: { topicRequestId: victim.id } })).toBe(0);

    // The freed slot is real, not just reported.
    await submit(capToken, 'After withdrawing').expect(201);
  });

  it("reports someone else's request as absent rather than forbidden", async () => {
    const mine = await prisma.topicRequest.create({
      data: { requestedByUserId: capLearnerId, requestedTopicTitle: title('Not yours') },
      select: { id: true },
    });

    const response = await api()
      .delete(`/api/topic-requests/${mine.id}`)
      .set('Cookie', learnerCookie(learnerBToken))
      .expect(404);
    // 403 would confirm the id is real and someone else's.
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_NOT_FOUND');
    expect(await prisma.topicRequest.findUnique({ where: { id: mine.id } })).not.toBeNull();
  });

  it('refuses to withdraw a request that has already been reviewed', async () => {
    const reviewed = await prisma.topicRequest.create({
      data: {
        requestedByUserId: capLearnerId,
        requestedTopicTitle: title('Already ruled on'),
        requestStatus: 'accepted',
      },
      select: { id: true },
    });

    const response = await api()
      .delete(`/api/topic-requests/${reviewed.id}`)
      .set('Cookie', learnerCookie(capToken))
      .expect(409);
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_NOT_PENDING');
  });

  it('refuses /me/topic-requests without a learner session', async () => {
    await api().get('/api/me/topic-requests').expect(401);
    await api().get('/api/me/topic-requests').set('Cookie', adminCookie(ownerToken)).expect(401);
  });
});

describe('§9.2 the owner review queue', () => {
  let subjectId = '';
  let otherId = '';
  let courseId = '';

  beforeAll(async () => {
    const subject = await prisma.topicRequest.create({
      data: { requestedByUserId: learnerAId, requestedTopicTitle: title('Under review') },
      select: { id: true },
    });
    subjectId = subject.id;

    const other = await prisma.topicRequest.create({
      data: { requestedByUserId: learnerBId, requestedTopicTitle: title('The original') },
      select: { id: true },
    });
    otherId = other.id;

    const category = await prisma.category.create({
      data: { slug: `req-${run}`, displayName: `Req ${run}` },
      select: { id: true },
    });
    const course = await prisma.course.create({
      data: {
        categoryId: category.id,
        slug: `req-${run}-course`,
        levelLabel: 'N5',
        levelOrder: 1,
        title: `Khoá ${run}`,
        publicationStatus: 'published',
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    courseId = course.id;
  });

  const asOwner = () => api().get('/api/admin/topic-requests').set('Cookie', adminCookie(ownerToken));
  const review = (id: string, body: Record<string, unknown>) =>
    api()
      .patch(`/api/admin/topic-requests/${id}`)
      .set('Cookie', adminCookie(ownerToken))
      .send(body);

  it('is refused to an admin and to a learner', async () => {
    const admin = await api()
      .get('/api/admin/topic-requests')
      .set('Cookie', adminCookie(adminToken))
      .expect(403);
    expect(admin.body.errorCode).toBe('FORBIDDEN_ROLE');

    await api()
      .patch(`/api/admin/topic-requests/${subjectId}`)
      .set('Cookie', adminCookie(adminToken))
      .send({ requestStatus: 'accepted' })
      .expect(403);

    // A learner carries no admin-web cookie at all, so the session guard stops them first.
    await api().get('/api/admin/topic-requests').expect(401);
  });

  it('shows the submitter’s email to the owner, which the board never does', async () => {
    const response = await asOwner().query({ status: 'all', pageSize: 100 }).expect(200);
    const row = response.body.items.find((item: { id: string }) => item.id === subjectId);
    expect(row.requestedByEmail).toContain('@example.test');
  });

  it('filters by status and sorts by upvotes or newest', async () => {
    const pending = await asOwner().query({ status: 'pending', pageSize: 100 }).expect(200);
    expect(
      pending.body.items.every((item: { requestStatus: string }) => item.requestStatus === 'pending'),
    ).toBe(true);

    const byUpvotes = await asOwner().query({ status: 'all', sort: 'upvotes', pageSize: 100 });
    const counts = byUpvotes.body.items.map((item: { upvoteCount: number }) => item.upvoteCount);
    expect([...counts].sort((a: number, b: number) => b - a)).toEqual(counts);

    await asOwner().query({ status: 'nonsense' }).expect(400);
    await asOwner().query({ sort: 'random' }).expect(400);
  });

  it('requires a note to reject, and writes nothing when it is missing', async () => {
    const refused = await review(subjectId, { requestStatus: 'rejected' }).expect(400);
    expect(refused.body.errorCode).toBe('TOPIC_REQUEST_NOTE_REQUIRED');

    const untouched = await prisma.topicRequest.findUniqueOrThrow({
      where: { id: subjectId },
      select: { requestStatus: true, reviewedByUserId: true },
    });
    // The refused body must not have half-applied: status unchanged, no reviewer.
    expect(untouched.requestStatus).toBe('pending');
    expect(untouched.reviewedByUserId).toBeNull();
  });

  it('requires a target to mark a duplicate, and refuses a bad one', async () => {
    const missing = await review(subjectId, { requestStatus: 'duplicated' }).expect(400);
    expect(missing.body.errorCode).toBe('TOPIC_REQUEST_DUPLICATE_TARGET_REQUIRED');

    const itself = await review(subjectId, {
      requestStatus: 'duplicated',
      duplicateOfRequestId: subjectId,
    }).expect(400);
    expect(itself.body.errorCode).toBe('TOPIC_REQUEST_DUPLICATE_TARGET_INVALID');

    const unknown = await review(subjectId, {
      requestStatus: 'duplicated',
      duplicateOfRequestId: '00000000-0000-4000-8000-000000000000',
    }).expect(400);
    expect(unknown.body.errorCode).toBe('TOPIC_REQUEST_DUPLICATE_TARGET_INVALID');

    expect(
      (await prisma.topicRequest.findUniqueOrThrow({ where: { id: subjectId } })).requestStatus,
    ).toBe('pending');
  });

  it('refuses a field that does not belong to the chosen status', async () => {
    await review(subjectId, { requestStatus: 'rejected', reviewerNote: 'no', linkedCourseId: courseId })
      .expect(400);
    await review(subjectId, { requestStatus: 'accepted', duplicateOfRequestId: otherId }).expect(400);
    // strictObject: an unknown key never reaches the service.
    await review(subjectId, { requestStatus: 'accepted', upvoteCount: 99 }).expect(400);
  });

  it('marks a duplicate without moving a single vote', async () => {
    await api()
      .post(`/api/topic-requests/${otherId}/vote`)
      .set('Cookie', learnerCookie(learnerAToken))
      .expect(201);

    const before = await prisma.topicRequest.findMany({
      where: { id: { in: [subjectId, otherId] } },
      select: { id: true, upvoteCount: true },
      orderBy: { id: 'asc' },
    });

    const response = await review(subjectId, {
      requestStatus: 'duplicated',
      duplicateOfRequestId: otherId,
    }).expect(200);
    expect(response.body.duplicateOf.id).toBe(otherId);

    const after = await prisma.topicRequest.findMany({
      where: { id: { in: [subjectId, otherId] } },
      select: { id: true, upvoteCount: true },
      orderBy: { id: 'asc' },
    });
    // Vote merging is an explicit non-goal: the column records the relationship
    // and the counts stay separate.
    expect(after).toEqual(before);
  });

  it('refuses a duplicate of a duplicate — no chains', async () => {
    const third = await prisma.topicRequest.create({
      data: { requestedByUserId: learnerBId, requestedTopicTitle: title('Third') },
      select: { id: true },
    });
    const response = await review(third.id, {
      requestStatus: 'duplicated',
      duplicateOfRequestId: subjectId,
    }).expect(400);
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_DUPLICATE_TARGET_INVALID');
  });

  it('accepts with a linked course, and records the reviewer', async () => {
    const response = await review(otherId, {
      requestStatus: 'accepted',
      linkedCourseId: courseId,
      reviewerNote: 'Đã xuất bản khoá này',
    }).expect(200);

    expect(response.body.requestStatus).toBe('accepted');
    expect(response.body.linkedCourse.id).toBe(courseId);

    const row = await prisma.topicRequest.findUniqueOrThrow({
      where: { id: otherId },
      select: { reviewedByUserId: true },
    });
    expect(row.reviewedByUserId).toBe(ownerId);
  });

  it('refuses an unknown linked course', async () => {
    const response = await review(otherId, {
      requestStatus: 'accepted',
      linkedCourseId: '00000000-0000-4000-8000-000000000000',
    }).expect(400);
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_LINKED_COURSE_NOT_FOUND');
  });

  it('reopening clears the whole ruling', async () => {
    await review(otherId, { requestStatus: 'pending' }).expect(200);

    const row = await prisma.topicRequest.findUniqueOrThrow({
      where: { id: otherId },
      select: {
        requestStatus: true,
        reviewerNote: true,
        linkedCourseId: true,
        duplicateOfRequestId: true,
        reviewedByUserId: true,
      },
    });
    expect(row.requestStatus).toBe('pending');
    // A pending request carrying a stale note reads as a decision that was not made.
    expect(row.reviewerNote).toBeNull();
    expect(row.linkedCourseId).toBeNull();
    expect(row.duplicateOfRequestId).toBeNull();
    // The reviewer is still recorded: somebody did reopen it.
    expect(row.reviewedByUserId).toBe(ownerId);
  });

  it('returns 404 for an unknown request', async () => {
    const response = await review('00000000-0000-4000-8000-000000000000', {
      requestStatus: 'accepted',
    }).expect(404);
    expect(response.body.errorCode).toBe('TOPIC_REQUEST_NOT_FOUND');
  });
});

describe('the built and closed groups', () => {
  let draftCourseId = '';
  let publishedCourseId = '';
  let builtId = '';
  let draftLinkedId = '';

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: { slug: `grp-${run}`, displayName: `Grp ${run}` },
      select: { id: true },
    });
    const published = await prisma.course.create({
      data: {
        categoryId: category.id,
        slug: `grp-${run}-published`,
        levelLabel: 'N4',
        levelOrder: 1,
        title: `Đã xuất bản ${run}`,
        publicationStatus: 'published',
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    publishedCourseId = published.id;

    const draft = await prisma.course.create({
      data: {
        categoryId: category.id,
        slug: `grp-${run}-draft`,
        levelLabel: 'N3',
        levelOrder: 2,
        title: `Chưa xuất bản ${run}`,
        publicationStatus: 'draft',
      },
      select: { id: true },
    });
    draftCourseId = draft.id;

    const built = await prisma.topicRequest.create({
      data: {
        requestedByUserId: learnerAId,
        requestedTopicTitle: title('Built and linked'),
        requestStatus: 'accepted',
        linkedCourseId: publishedCourseId,
      },
      select: { id: true },
    });
    builtId = built.id;

    const draftLinked = await prisma.topicRequest.create({
      data: {
        requestedByUserId: learnerAId,
        requestedTopicTitle: title('Built but unpublished'),
        requestStatus: 'accepted',
        linkedCourseId: draftCourseId,
      },
      select: { id: true },
    });
    draftLinkedId = draftLinked.id;

    await prisma.topicRequest.create({
      data: {
        requestedByUserId: learnerBId,
        requestedTopicTitle: title('Turned down'),
        requestStatus: 'rejected',
        reviewerNote: 'Không đủ nhu cầu',
      },
    });
  });

  it('names the linked course when it is published', async () => {
    const response = await api().get('/api/topic-requests').expect(200);
    const row = response.body.built.items.find((item: { id: string }) => item.id === builtId);
    expect(row.linkedCourse.slug).toBe(`grp-${run}-published`);
  });

  it('shows an accepted request linked to a DRAFT course as built with no link', async () => {
    const response = await api().get('/api/topic-requests').expect(200);
    const row = response.body.built.items.find((item: { id: string }) => item.id === draftLinkedId);
    expect(row).toBeDefined();
    // §4.3: a draft course's slug is not public information, and a link into a
    // 404 is worse than no link.
    expect(row.linkedCourse).toBeNull();
  });

  it('withholds closed items by default but always reports the total', async () => {
    const collapsed = await api().get('/api/topic-requests').expect(200);
    expect(collapsed.body.closed.items).toEqual([]);
    expect(collapsed.body.closed.total).toBeGreaterThan(0);

    const expanded = await api().get('/api/topic-requests?includeClosed=true').expect(200);
    expect(expanded.body.closed.items.length).toBeGreaterThan(0);
    expect(
      expanded.body.closed.items.every((item: { requestStatus: string }) =>
        ['rejected', 'duplicated'].includes(item.requestStatus),
      ),
    ).toBe(true);
  });

  it('carries the reviewer note on closed rows', async () => {
    const response = await api().get('/api/topic-requests?includeClosed=true').expect(200);
    const rejected = response.body.closed.items.find(
      (item: { requestedTopicTitle: string }) => item.requestedTopicTitle === `Turned down ${run}`,
    );
    expect(rejected.reviewerNote).toBe('Không đủ nhu cầu');
  });

  it('keeps every group free of submitter identity', async () => {
    const response = await api().get('/api/topic-requests?includeClosed=true').expect(200);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('@example.test');
    expect(raw).not.toContain(learnerAId);
    expect(raw).not.toContain(learnerBId);
  });

  it('refuses a non-boolean includeClosed', async () => {
    await api().get('/api/topic-requests?includeClosed=yes').expect(400);
  });
});
