import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import {
  API,
  adminCookie,
  learnerCookie,
  prisma,
  seedLearner,
  seedStaff,
  signInAsLearner,
  type SeededUser,
} from './helpers';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * FR-REQ-01 — the browser scenario from specs/p9-topic-requests/spec.md.
 *
 * Three things here cannot be asserted in the api suite, and they are why this
 * file exists:
 *
 *  - **no submitter identity reaches the rendered page.** The API payload is
 *    checked in apps/api/test/topic-requests.e2e-spec.ts; this checks the HTML,
 *    which is what an anonymous visitor actually receives.
 *  - **ON DELETE SET NULL saves a learner's withdrawal.** Under NoAction the
 *    delete fails with a foreign-key error and a 500, and the only place the
 *    whole path runs — owner marks a duplicate, learner withdraws the target —
 *    is across both apps.
 *  - **the board is live, not cached.** A vote followed by an immediate reload
 *    is the only proof `force-dynamic` is doing its job; an ISR window would
 *    pass every other assertion here.
 *
 * The published course this scenario links to is written directly with Prisma
 * rather than through seed.ts's authoring pipeline. P9 reads nothing but the
 * course's slug, title and publication status, and seed.ts would spend minutes
 * generating images, narration and an ffmpeg audio merge for a hyperlink.
 */

const run = randomBytes(4).toString('hex');
const suffix = ` ${run}`;

let owner: SeededUser;
let learnerA: SeededUser;
let learnerB: SeededUser;
let courseId = '';
let courseSlug = '';
const created: string[] = [];

const title = (label: string) => `${label}${suffix}`;

/** Creates a request straight through the API as a given learner. */
async function submitAs(learner: SeededUser, label: string): Promise<string> {
  const response = await fetch(`${API}/api/topic-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...learnerCookie(learner.token) },
    body: JSON.stringify({ requestedTopicTitle: title(label) }),
  });
  expect(response.status, `submitting "${label}"`).toBe(201);
  const body = (await response.json()) as { id: string };
  created.push(body.id);
  return body.id;
}

const rowFor = (page: Page, requestId: string) =>
  page.locator(`[data-testid="request-row"][data-request-id="${requestId}"]`);

test.beforeAll(async () => {
  owner = await seedStaff('admin_owner', `p9-${run}`);
  learnerA = await seedLearner('p9-a', run);
  learnerB = await seedLearner('p9-b', run);

  const category = await prisma.category.create({
    data: { slug: `p9-${run}`, displayName: `Chủ đề ${run}`, displayOrder: 0 },
    select: { id: true, slug: true },
  });
  courseSlug = `p9-${run}-course`;
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: courseSlug,
      levelLabel: 'N5',
      levelOrder: 1,
      title: `Khoá đã xuất bản ${run}`,
      overviewSummary: 'Khoá học cho kịch bản P9.',
      pricingType: 'free',
      languageCode: 'vi',
      publicationStatus: 'published',
      publishedAt: new Date(),
    },
    select: { id: true },
  });
  courseId = course.id;
});

test.afterAll(async () => {
  await prisma.topicRequest.deleteMany({ where: { requestedTopicTitle: { endsWith: suffix } } });
  await prisma.course.deleteMany({ where: { slug: courseSlug } });
  await prisma.category.deleteMany({ where: { slug: `p9-${run}` } });
  await prisma.user.deleteMany({ where: { email: { contains: `-e2e-${run}@` } } });
  await prisma.user.deleteMany({ where: { email: { contains: `-e2e-p9-${run}@` } } });
});

test('FR-REQ-01: submit, vote, withdraw, review and see the outcome', async ({ page }) => {
  // ── 1. The board, anonymous and empty of this run's rows ────────────────────
  await page.goto('/requests');
  await expect(page.getByRole('heading', { name: 'Đề xuất chủ đề' })).toBeVisible();
  await expect(page.getByTestId('vote-signin').first().or(page.getByTestId('requests-empty')))
    .toBeVisible();

  // ── 2. Learner A submits, and the board shows it to a visitor ──────────────
  await signInAsLearner(page, learnerA.email);
  await page.goto('/requests');
  await page.getByTestId('request-title').fill(title('Tiếng Hàn TOPIK I'));
  await page.getByTestId('request-description').fill('Mình muốn học TOPIK.');
  await page.getByTestId('request-submit').click();
  await expect(page.getByText(title('Tiếng Hàn TOPIK I'))).toBeVisible();

  const koreanId = (
    await prisma.topicRequest.findFirstOrThrow({
      where: { requestedTopicTitle: title('Tiếng Hàn TOPIK I') },
      select: { id: true, upvoteCount: true },
    })
  ).id;
  created.push(koreanId);

  // Zero, not one — a learner may not vote for their own request.
  expect(
    (await prisma.topicRequest.findUniqueOrThrow({ where: { id: koreanId } })).upvoteCount,
  ).toBe(0);

  // ── 3. No submitter identity in the rendered page ──────────────────────────
  const anonymous = await page.context().browser()!.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto('/requests');
  await expect(anonymousPage.getByText(title('Tiếng Hàn TOPIK I'))).toBeVisible();
  const html = await anonymousPage.content();
  // The assertion the api suite cannot make: this is what a visitor receives.
  expect(html).not.toContain(learnerA.email);
  expect(html).not.toContain(learnerB.email);
  expect(html).not.toContain(learnerA.id);
  await expect(anonymousPage.getByTestId('vote-signin').first()).toBeVisible();

  // ── 4. A learner cannot vote for their own request ─────────────────────────
  await expect(rowFor(page, koreanId).getByTestId('vote-own')).toBeVisible();
  const ownVote = await fetch(`${API}/api/topic-requests/${koreanId}/vote`, {
    method: 'POST',
    headers: learnerCookie(learnerA.token),
  });
  expect(ownVote.status).toBe(409);
  expect((await ownVote.json()).errorCode).toBe('TOPIC_REQUEST_OWN');

  // ── 5. Learner B votes in the browser; the count moves and survives a reload ─
  const pageB = await (await page.context().browser()!.newContext()).newPage();
  await signInAsLearner(pageB, learnerB.email);
  await pageB.goto('/requests');

  const bRow = rowFor(pageB, koreanId);
  await expect(bRow.getByTestId('vote-button')).toHaveAttribute('data-voted', 'false');
  await bRow.getByTestId('vote-button').click();
  await expect(bRow.getByTestId('vote-button')).toHaveAttribute('data-voted', 'true');
  await expect(bRow.getByTestId('vote-button')).toContainText('1');

  // ── 6. The board is live, not cached ───────────────────────────────────────
  // An immediate reload with no wait: an ISR window would still show 0 here.
  await pageB.reload();
  await expect(rowFor(pageB, koreanId).getByTestId('vote-button')).toHaveAttribute(
    'data-voted',
    'true',
  );
  await expect(rowFor(pageB, koreanId).getByTestId('vote-button')).toContainText('1');

  // Un-voting is symmetric, and the counter follows the vote rows either way.
  await rowFor(pageB, koreanId).getByTestId('vote-button').click();
  await expect(rowFor(pageB, koreanId).getByTestId('vote-button')).toHaveAttribute(
    'data-voted',
    'false',
  );
  await rowFor(pageB, koreanId).getByTestId('vote-button').click();
  await expect(rowFor(pageB, koreanId).getByTestId('vote-button')).toHaveAttribute(
    'data-voted',
    'true',
  );
  await assertCounterMatchesRows(koreanId);

  // ── 7. The cap, and withdrawal freeing a slot ──────────────────────────────
  const cap = Number(process.env['TOPIC_REQUEST_PENDING_CAP'] ?? '5');
  for (let index = 1; index < cap; index += 1) {
    await submitAs(learnerA, `Lấp chỗ ${index}`);
  }
  const overCap = await fetch(`${API}/api/topic-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...learnerCookie(learnerA.token) },
    body: JSON.stringify({ requestedTopicTitle: title('Quá giới hạn') }),
  });
  expect(overCap.status).toBe(409);
  expect((await overCap.json()).errorCode).toBe('TOPIC_REQUEST_LIMIT_REACHED');

  await page.goto('/me/requests');
  await expect(page.getByTestId('pending-cap')).toContainText(`${cap} / ${cap}`);
  await page.getByTestId('withdraw-button').first().click();
  await expect(page.getByTestId('pending-cap')).toContainText(`${cap - 1} / ${cap}`);

  // ── 8. The owner rules on the queue, through admin-web ─────────────────────
  const duplicateId = await submitAs(learnerB, 'Tiếng Hàn sơ cấp');

  const ownerPage = await (
    await page.context().browser()!.newContext({
      extraHTTPHeaders: {},
    })
  ).newPage();
  await ownerPage.context().addCookies([
    {
      name: 'authjs.session-token',
      value: owner.token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
    },
  ]);
  await ownerPage.goto('http://localhost:3000/topic-requests');
  await expect(ownerPage.getByRole('heading', { name: 'Topic requests' })).toBeVisible();

  /**
   * The owner works the ALL view, newest first.
   *
   * Not incidental: under the default `pending` filter a row LEAVES the list the
   * moment it is reviewed, which is correct behaviour and makes every
   * after-the-fact assertion on that row race the refetch. `all` keeps each row
   * on screen so its new status can be read; `newest` keeps this run's rows at
   * the top of a shared database.
   */
  await ownerPage.getByTestId('queue-status').selectOption('all');
  await ownerPage.getByTestId('queue-sort').selectOption('newest');

  const queueRow = (id: string) =>
    ownerPage.locator(`[data-testid="queue-row"][data-request-id="${id}"]`);
  await expect(queueRow(koreanId)).toBeVisible();

  // The owner — and only the owner — sees who asked.
  await expect(queueRow(koreanId).getByTestId('queue-email')).toContainText(learnerA.email);

  // A duplicate with no target is refused, and writes nothing.
  await queueRow(duplicateId).getByTestId('queue-review-toggle').click();
  await queueRow(duplicateId).getByTestId('review-status-duplicated').check();
  await queueRow(duplicateId).getByTestId('review-save').click();
  await expect(queueRow(duplicateId).getByTestId('review-error')).toContainText(
    'Choose which request this duplicates',
  );
  expect(
    (await prisma.topicRequest.findUniqueOrThrow({ where: { id: duplicateId } })).requestStatus,
  ).toBe('pending');

  // With a target it succeeds, and neither count moves — vote merging is a non-goal.
  const beforeCounts = await counts([koreanId, duplicateId]);
  await queueRow(duplicateId)
    .getByTestId('review-duplicate-of')
    .selectOption({ label: title('Tiếng Hàn TOPIK I') });
  await queueRow(duplicateId).getByTestId('review-save').click();
  await expect(queueRow(duplicateId)).toHaveAttribute('data-status', 'duplicated');
  expect(await counts([koreanId, duplicateId])).toEqual(beforeCounts);

  // ── 9. Rejecting requires a note ───────────────────────────────────────────
  const rejectId = await submitAs(learnerB, 'Sẽ bị từ chối');
  // Re-select rather than reload: a reload resets the filter to `pending`.
  await ownerPage.getByTestId('queue-sort').selectOption('upvotes');
  await ownerPage.getByTestId('queue-sort').selectOption('newest');
  await expect(queueRow(rejectId)).toBeVisible();
  await queueRow(rejectId).getByTestId('queue-review-toggle').click();
  await queueRow(rejectId).getByTestId('review-status-rejected').check();
  await queueRow(rejectId).getByTestId('review-save').click();
  await expect(queueRow(rejectId).getByTestId('review-error')).toContainText(
    'needs a reviewer note',
  );
  expect(
    (await prisma.topicRequest.findUniqueOrThrow({ where: { id: rejectId } })).requestStatus,
  ).toBe('pending');

  await queueRow(rejectId).getByTestId('review-note').fill('Chưa đủ nhu cầu.');
  await queueRow(rejectId).getByTestId('review-save').click();
  await expect(queueRow(rejectId)).toHaveAttribute('data-status', 'rejected');

  // ── 10. Accepting with a linked course ─────────────────────────────────────
  await queueRow(koreanId).getByTestId('queue-review-toggle').click();
  await queueRow(koreanId).getByTestId('review-status-accepted').check();
  // The picker is bounded at the 50 newest courses and this database holds
  // thousands, so the search is how the owner reaches one — exercised here
  // rather than relying on the new course happening to be near the top.
  await queueRow(koreanId).getByTestId('review-course-search').fill(`Khoá đã xuất bản ${run}`);
  await expect(queueRow(koreanId).getByTestId('review-course')).toContainText(
    `Khoá đã xuất bản ${run}`,
  );
  await queueRow(koreanId).getByTestId('review-course').selectOption(courseId);
  await queueRow(koreanId).getByTestId('review-save').click();
  await expect(queueRow(koreanId)).toHaveAttribute('data-status', 'accepted');

  // ── 11. The learner sees every outcome on the board ────────────────────────
  await anonymousPage.goto('/requests');
  const builtRow = anonymousPage.locator(
    `[data-testid="built-row"][data-request-id="${koreanId}"]`,
  );
  await expect(builtRow).toBeVisible();
  await builtRow.getByTestId('built-course-link').click();
  await expect(anonymousPage).toHaveURL(new RegExp(`/courses/${courseSlug}$`));
  await expect(anonymousPage.getByRole('heading', { name: `Khoá đã xuất bản ${run}` })).toBeVisible();

  await anonymousPage.goto('/requests');
  await expect(anonymousPage.getByTestId('closed-requests')).toHaveCount(0);
  await anonymousPage.getByTestId('closed-expand').click();
  await expect(
    anonymousPage.locator(`[data-testid="closed-row"][data-request-id="${rejectId}"]`),
  ).toContainText('Chưa đủ nhu cầu.');

  // Voting on a reviewed request is refused.
  const settled = await fetch(`${API}/api/topic-requests/${koreanId}/vote`, {
    method: 'POST',
    headers: learnerCookie(learnerB.token),
  });
  expect(settled.status).toBe(409);
  expect((await settled.json()).errorCode).toBe('TOPIC_REQUEST_NOT_PENDING');

  // ── 12. Roles, and the two-cookie split from P7 ────────────────────────────
  const asOwnerLearnerEndpoint = await fetch(`${API}/api/topic-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...adminCookie(owner.token) },
    body: JSON.stringify({ requestedTopicTitle: title('Owner attempt') }),
  });
  // The owner carries no LEARNER cookie, so they never reach the matrix.
  expect(asOwnerLearnerEndpoint.status).toBe(401);

  const asLearnerAdminEndpoint = await fetch(`${API}/api/admin/topic-requests`, {
    headers: learnerCookie(learnerA.token),
  });
  expect(asLearnerAdminEndpoint.status).toBe(401);

  const anonymousSubmit = await fetch(`${API}/api/topic-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestedTopicTitle: title('Anonymous attempt') }),
  });
  expect(anonymousSubmit.status).toBe(401);

  // ── 13. ON DELETE SET NULL: withdrawing a duplicate's target ───────────────
  // Under NoAction this delete fails with a foreign-key error and a 500, and the
  // learner has no way to act on it. This is the whole reason P9's migration
  // departs from the project's NoAction convention.
  const targetId = await submitAs(learnerA, 'Sẽ bị rút');
  const dupId = await submitAs(learnerB, 'Trỏ tới cái sẽ bị rút');
  const marked = await fetch(`${API}/api/admin/topic-requests/${dupId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...adminCookie(owner.token) },
    body: JSON.stringify({ requestStatus: 'duplicated', duplicateOfRequestId: targetId }),
  });
  expect(marked.status).toBe(200);

  const withdrawn = await fetch(`${API}/api/topic-requests/${targetId}`, {
    method: 'DELETE',
    headers: learnerCookie(learnerA.token),
  });
  expect(withdrawn.status, 'the withdrawal must succeed, not 500').toBe(204);

  const orphan = await prisma.topicRequest.findUniqueOrThrow({
    where: { id: dupId },
    select: { requestStatus: true, duplicateOfRequestId: true },
  });
  expect(orphan.requestStatus).toBe('duplicated');
  expect(orphan.duplicateOfRequestId).toBeNull();

  // The owner's queue must render that state rather than throw on a null target.
  await ownerPage.getByTestId('queue-sort').selectOption('upvotes');
  await ownerPage.getByTestId('queue-sort').selectOption('newest');
  await expect(queueRow(dupId).getByTestId('queue-duplicate-of')).toContainText(
    'Duplicate of a withdrawn request',
  );
});

async function counts(ids: readonly string[]): Promise<Record<string, number>> {
  const rows = await prisma.topicRequest.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, upvoteCount: true },
  });
  return Object.fromEntries(rows.map((row) => [row.id, row.upvoteCount]));
}

async function assertCounterMatchesRows(requestId: string): Promise<void> {
  const [row, votes] = await Promise.all([
    prisma.topicRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { upvoteCount: true },
    }),
    prisma.topicRequestVote.count({ where: { topicRequestId: requestId } }),
  ]);
  expect(row.upvoteCount, 'upvote_count drifted from topic_request_votes').toBe(votes);
}
