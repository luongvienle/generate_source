import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import {
  API,
  adminCookie,
  grantAccess,
  prisma,
  seedStaff,
  signInAsLearner,
  waitForJob,
  type SeededUser,
} from './helpers';
import { BODY, cleanUp, seedCourse, type SeededCourse } from './seed';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser scenario from specs/p7-learner/spec.md.
 *
 * Four things here would pass every API test while being wrong end to end:
 *
 *  - **the figure actually loads.** A URL signed against the internal endpoint
 *    instead of `S3_PUBLIC_ENDPOINT` is a correct-looking string that fails only
 *    in a browser, with an opaque `SignatureDoesNotMatch` (CLAUDE.md invariant 5).
 *    P7 is the first phase where every presigned URL is learner-facing.
 *  - **the paywalled text is absent from the page source**, not merely hidden.
 *    A server that sends the body and a client that declines to show it is the
 *    leak E-01 describes, and it looks identical to a working paywall.
 *  - **no signed URL is minted before play.** Minting at page load would hand
 *    every visitor a working media URL whose TTL outlives the page (E-03).
 *  - **an unpublish takes effect without waiting out the revalidate interval**,
 *    which is the only proof the synchronous transition path fires the hook at
 *    all — the worker path cannot cover it.
 */

const run = randomBytes(4).toString('hex');
const learnerEmail = `p7-learner-${run}@example.test`;

let owner: SeededUser;
let course: SeededCourse;
let learnerId = '';
let grantId = '';

const lessonUrl = (index: number) => `/lessons/${course.lessons[index]!.id}`;

test.describe.configure({ mode: 'serial' });
/**
 * Playwright gives every test its own browser context, so a session does not
 * survive from one to the next even in serial mode. Each test that needs a
 * signed-in learner establishes one — through a real magic link, so the sign-in
 * path is exercised repeatedly rather than faked once.
 */


test.beforeAll(async ({ request }) => {
  owner = await seedStaff('admin_owner', run);
  course = await seedCourse({
    run,
    ownerId: owner.id,
    pricingType: 'paid',
    title: `Tiếng Nhật N5 ${run}`,
    overview: 'Khoá nhập môn dành cho người mới bắt đầu học bảng chữ cái.',
  });

  /**
   * STEP 1 (part): the free-preview flag goes through the control P7 added,
   * not through Prisma. This is the round-trip task 2 owes — it is the only
   * writer of `is_free_preview` in the product, and without it §7.3's
   * free-preview branch is unreachable.
   */
  const response = await request.patch(`${API}/api/admin/lessons/${course.lessons[0]!.id}`, {
    headers: adminCookie(owner.token),
    data: { isFreePreview: true },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).isFreePreview).toBe(true);
});

test.afterAll(async () => {
  await cleanUp(course, [owner.id, learnerId].filter(Boolean));
});

test('1. the owner publishes the course through the checklist and the publish job', async ({
  request,
}) => {
  await request.post(`${API}/api/admin/courses/${course.courseId}/submit-review`, {
    headers: adminCookie(owner.token),
  });

  const readChecklist = async () => {
    const response = await request.get(
      `${API}/api/admin/courses/${course.courseId}/publish-checklist`,
      { headers: adminCookie(owner.token) },
    );
    return (await response.json()).items as { id: string; passed: boolean; reason: string }[];
  };

  // §5.7 item 7 needs an active product, and P8 owns products — so a paid
  // course cannot pass the checklist yet. Selling it as free is what an owner
  // without a price would do, and it is restored below.
  if ((await readChecklist()).some((item) => item.id === 'active_product_for_paid' && !item.passed)) {
    await request.patch(`${API}/api/admin/courses/${course.courseId}/pricing-type`, {
      headers: adminCookie(owner.token),
      data: { pricingType: 'free' },
    });
  }

  // Fail with the offending items rather than with a bare 422 from the publish.
  const stillFailing = (await readChecklist()).filter((item) => !item.passed);
  expect(stillFailing.map((item) => `${item.id}: ${item.reason}`)).toEqual([]);

  const publish = await request.post(`${API}/api/admin/courses/${course.courseId}/publish`, {
    headers: adminCookie(owner.token),
  });
  expect(publish.status()).toBe(202);
  const { generationJobId } = (await publish.json()) as { generationJobId: string };
  expect(await waitForJob(generationJobId)).toBe('succeeded');

  const published = await prisma.course.findUniqueOrThrow({
    where: { id: course.courseId },
    select: { publicationStatus: true },
  });
  expect(published.publicationStatus).toBe('published');
  expect(
    await prisma.publishedCourseStructure.findUnique({ where: { courseId: course.courseId } }),
  ).not.toBeNull();

  // The course is free, so make the gated lesson genuinely gated again: the
  // scenario below is about entitlement, and a free course entitles everyone.
  await prisma.course.update({
    where: { id: course.courseId },
    data: { pricingType: 'paid' },
  });
});

test('2. the catalog lists the course anonymously, and search finds it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('catalog-list')).toBeVisible();

  await page.getByTestId('catalog-search').fill(`Tiếng Nhật N5 ${run}`);
  await page.getByRole('button', { name: 'Tìm' }).click();

  const links = page.getByTestId('catalog-course-link');
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveText(`Tiếng Nhật N5 ${run}`);

  // A term that matches nothing returns the empty state rather than everything.
  await page.getByTestId('catalog-search').fill(`khong-ton-tai-${run}`);
  await page.getByRole('button', { name: 'Tìm' }).click();
  await expect(page.getByTestId('catalog-empty')).toBeVisible();
});

test('3. the course page shows the snapshot table of contents and no price block', async ({
  page,
}) => {
  await page.goto(`/courses/${course.courseSlug}`);
  await expect(page.getByTestId('course-toc')).toBeVisible();
  await expect(page.getByTestId('toc-lesson-link')).toHaveCount(6);
  await expect(page.getByTestId('free-preview-badge')).toHaveCount(1);

  // No products exist until P8, so the price block is absent rather than a
  // placeholder — and the paid course says plainly that it is not on sale.
  await expect(page.getByTestId('price-block')).toHaveCount(0);
  await expect(page.getByTestId('not-for-sale')).toBeVisible();
});

test('4. a free-preview lesson reads anonymously, and its figure actually loads', async ({
  page,
}) => {
  await page.goto(lessonUrl(0));
  await expect(page.getByTestId('lesson-body')).toBeVisible();
  await expect(page.getByText('Nét đầu tiên chạy từ trái sang phải.')).toBeVisible();

  // §6.1: the renderer reads figure numbers from the stored block.
  await expect(page.getByText('Thứ tự ba nét viết')).toBeVisible();
  await expect(page.locator('.lesson-body table')).toBeVisible();

  const image = page.locator('.lesson-body img').first();
  const src = await image.getAttribute('src');
  const publicEndpoint = process.env['S3_PUBLIC_ENDPOINT'] ?? 'http://localhost:9010';
  expect(src?.startsWith(publicEndpoint)).toBe(true);
  expect(src).toContain('X-Amz-Signature');

  /**
   * The assertion invariant 5 exists for: a URL can be perfectly formed and
   * still 403 because the signature covers a host the browser never uses.
   * Only fetching it can tell.
   */
  const response = await page.request.get(src!);
  expect(response.status()).toBe(200);
  await expect(image).toHaveJSProperty('naturalWidth', 1);

  // Anonymous readers get no completion control, and a prompt in its place.
  await expect(page.getByTestId('signin-prompt')).toBeVisible();
  await expect(page.getByTestId('mark-complete')).toHaveCount(0);
});

test('5. a paid lesson shows the paywall, and its text never reaches the page', async ({ page }) => {
  await page.goto(lessonUrl(1));
  await expect(page.getByTestId('paywall')).toBeVisible();
  await expect(page.getByTestId('paywall-course-link')).toBeVisible();

  // Absent from the SOURCE, not merely hidden: a server that sends the body and
  // a client that declines to render it is the leak, and it looks the same.
  const html = await page.content();
  expect(html).not.toContain('Nét đầu tiên chạy từ trái sang phải');
  expect(html).not.toContain('Hãy luyện tập mỗi ngày');
  expect(html).not.toContain('lesson-body');
});

test('6. E-01: the media endpoint refuses the same callers as the reader', async ({ request }) => {
  const mediaId = course.lessons[1]!.audioId;

  // Anonymous.
  expect((await request.get(`${API}/api/media/${mediaId}/signed-url`)).status()).toBe(403);

  // Signed in as the OWNER, over admin-web's cookie: the learner API does not
  // read that cookie, so this is a visitor — which is §3, since the owner does
  // not hold buyAccessReadListenTrackProgress.
  const asOwner = await request.get(`${API}/api/media/${mediaId}/signed-url`, {
    headers: adminCookie(owner.token),
  });
  expect(asOwner.status()).toBe(403);

  // The free-preview lesson's audio is open to everyone, by the same resolver.
  const preview = await request.get(
    `${API}/api/media/${course.lessons[0]!.audioId}/signed-url`,
  );
  expect(preview.status()).toBe(200);
});

test('7. a learner signs in, is granted access, and reads the paid lesson', async ({ page }) => {
  await signInAsLearner(page, learnerEmail);

  const learner = await prisma.user.findUniqueOrThrow({
    where: { email: learnerEmail },
    select: { id: true, userRole: true },
  });
  learnerId = learner.id;
  // Self-serve sign-up creates learners and nothing else.
  expect(learner.userRole).toBe('learner');

  // Before any grant, My Courses is empty and the lesson is still refused.
  await expect(page.getByTestId('my-courses-empty')).toBeVisible();
  await page.goto(lessonUrl(1));
  await expect(page.getByTestId('paywall')).toBeVisible();

  grantId = await grantAccess(learnerId, course.courseId);

  await page.goto(lessonUrl(1));
  await expect(page.getByTestId('lesson-body')).toBeVisible();
  await expect(page.getByText('Nét đầu tiên chạy từ trái sang phải.')).toBeVisible();
  await expect(page.getByTestId('mark-complete')).toBeVisible();

  await page.goto('/me/courses');
  const row = page.getByTestId('my-course');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-expired', 'false');
  await expect(page.getByText(/Còn \d+ ngày/)).toBeVisible();
});

test('8. the player mints its URL at play, follows offsets, and seeks on click', async ({
  page,
}) => {
  await signInAsLearner(page, learnerEmail);
  const signedUrlCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/signed-url')) signedUrlCalls.push(request.url());
  });

  await page.goto(lessonUrl(1));

  await expect(page.getByTestId('audio-player')).toBeVisible();

  // E-03: nothing is minted until the learner asks to listen.
  expect(signedUrlCalls).toHaveLength(0);

  await page.getByTestId('audio-start').click();
  await expect.poll(() => signedUrlCalls.length).toBeGreaterThan(0);
  await expect(page.getByTestId('audio-element')).toBeVisible();

  // FR-AUDIO-02: the block being read is marked. Drive the element rather than
  // waiting out real time — the offsets are what is under test, not the clock.
  const blockIds = course.lessons[1]!.blockIds;
  await page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>('[data-testid="audio-element"]');
    if (audio) audio.currentTime = 0.2;
  });
  await expect(page.locator(`[data-block-id="${blockIds[0]}"]`)).toHaveAttribute(
    'data-playing',
    'true',
  );

  // Clicking a later block seeks to its start offset.
  const target = blockIds[2] ?? blockIds[1]!;
  const segment = await prisma.audioSegment.findFirstOrThrow({
    where: { lessonAudioId: course.lessons[1]!.audioId, blockReferenceId: target },
    select: { startMillisecond: true },
  });
  await page.locator(`[data-block-id="${target}"]`).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.querySelector<HTMLAudioElement>('[data-testid="audio-element"]')?.currentTime ?? -1,
      ),
    )
    .toBeGreaterThanOrEqual(segment.startMillisecond / 1000 - 0.35);

  // Speed persists across lessons — localStorage, since §8 has no column.
  await page.getByTestId('playback-rate').selectOption('1.5');
  await page.goto(lessonUrl(3));
  await expect(page.getByTestId('playback-rate')).toHaveValue('1.5');
});

test('9. progress persists, survives a tab close, and drives resume', async ({ page }) => {
  await signInAsLearner(page, learnerEmail);
  await page.goto(lessonUrl(1));
  await expect(page.getByTestId('lesson-body')).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // pagehide fires on navigation; the keepalive flush is what must survive it.
  await page.goto('/me/courses');

  await expect
    .poll(async () => {
      const row = await prisma.lessonProgress.findFirst({
        where: { userId: learnerId, lessonId: course.lessons[1]!.id },
        select: { lastScrollPercentage: true },
      });
      return row?.lastScrollPercentage ?? 0;
    })
    .toBeGreaterThan(0);

  await page.goto(lessonUrl(1));
  await page.getByTestId('mark-complete').click();
  await expect(page.getByTestId('mark-complete')).toHaveAttribute('data-completed', 'true');

  await page.goto('/me/courses');
  // FR-LRN-03: one of six lessons complete, over the snapshot's count.
  await expect(page.getByTestId('course-progress')).toContainText('1/6');
  await expect(page.getByTestId('course-progress')).toContainText('17%');
  await expect(page.getByTestId('resume')).toBeVisible();
});

test('10. §7.4: expiry blocks reading, keeps the free preview, and preserves progress', async ({
  page,
}) => {
  await signInAsLearner(page, learnerEmail);
  await prisma.accessGrant.update({
    where: { id: grantId },
    data: { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  await page.goto(lessonUrl(1));
  await expect(page.getByTestId('paywall')).toBeVisible();

  // "Free-preview lessons remain readable after expiry."
  await page.goto(lessonUrl(0));
  await expect(page.getByTestId('lesson-body')).toBeVisible();

  // "An expired course stays visible in My courses with an expired badge, its
  // progress percentage, and a repurchase action. It is not hidden."
  await page.goto('/me/courses');
  await expect(page.getByTestId('my-course')).toHaveAttribute('data-expired', 'true');
  await expect(page.getByTestId('expired-badge')).toBeVisible();
  await expect(page.getByTestId('course-progress')).toContainText('1/6');
  await expect(page.getByTestId('repurchase')).toBeVisible();

  // "lesson_progress is never deleted on expiry."
  expect(
    await prisma.lessonProgress.count({ where: { userId: learnerId, progressStatus: 'completed' } }),
  ).toBeGreaterThan(0);

  await prisma.accessGrant.update({
    where: { id: grantId },
    data: { expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
});

test('11. §6.5: a draft narration edit removes the player, republishing restores it', async ({
  page,
  request,
}) => {
  const lesson = course.lessons[0]!;

  await page.goto(lessonUrl(0));
  await expect(page.getByTestId('audio-player')).toBeVisible();

  // The admin regenerates narration against an edited draft without publishing:
  // the script now voices words the learner is not reading.
  await prisma.narrationScript.update({
    where: { lessonId: lesson.id },
    data: { sourceContentChecksum: 'moved-on-since-the-publish' },
  });

  await page.goto(lessonUrl(0));
  // The lesson still reads — losing the player is not losing the lesson.
  await expect(page.getByTestId('lesson-body')).toBeVisible();
  await expect(page.getByText('Nét đầu tiên chạy từ trái sang phải.')).toBeVisible();
  await expect(page.getByTestId('audio-player')).toHaveCount(0);

  // Regenerate against the published text: the chain resolves and audio returns.
  const content = await prisma.lessonContent.findUniqueOrThrow({
    where: { lessonId: lesson.id },
    select: { draftContentChecksum: true },
  });
  await prisma.narrationScript.update({
    where: { lessonId: lesson.id },
    data: { sourceContentChecksum: content.draftContentChecksum! },
  });

  await page.goto(lessonUrl(0));
  await expect(page.getByTestId('audio-player')).toBeVisible();

  expect(request).toBeTruthy();
});

test('12. unpublishing removes the course without waiting out the revalidate window', async ({
  page,
  request,
}) => {
  // The course page is statically generated with a 300 s revalidate interval,
  // so if the ONLY mechanism were that interval this assertion could not pass
  // in the time this test takes. It passing is the proof that the synchronous
  // transition path fires the revalidation hook.
  await page.goto(`/courses/${course.courseSlug}`);
  await expect(page.getByTestId('course-toc')).toBeVisible();

  const response = await request.post(`${API}/api/admin/courses/${course.courseId}/unpublish`, {
    headers: adminCookie(owner.token),
  });
  // Nest answers POST with 201 by default and the endpoint sets no @HttpCode.
  expect(response.ok()).toBe(true);

  await assert404(page, `/courses/${course.courseSlug}`);

  // And it is gone from the catalog.
  await page.goto('/');
  await page.getByTestId('catalog-search').fill(`Tiếng Nhật N5 ${run}`);
  await page.getByRole('button', { name: 'Tìm' }).click();
  await expect(page.getByTestId('catalog-empty')).toBeVisible();
});

async function assert404(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(404);
}
