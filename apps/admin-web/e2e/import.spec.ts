import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { SCHEMA_VERSION } from '@knowledge-explorer/content';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser end-to-end scenario from specs/p1-curriculum/spec.md.
 *
 * Step 8 is the one no other suite can make: that a reorder produces exactly ONE
 * PATCH .../structure request (FR-EDIT-04), which is only observable from the
 * network.
 */

const prisma = getPrismaClient();
const run = randomBytes(4).toString('hex');
const categorySlug = `e2e-${run}`;
const ownerEmail = `owner-${run}@example.test`;
const adminEmail = `admin-${run}@example.test`;

const payload = (titleSuffix = '') => ({
  schemaVersion: SCHEMA_VERSION,
  category: { slug: categorySlug, displayName: `E2E ${run}` },
  course: {
    levelLabel: 'N5',
    levelOrder: 1,
    title: `Browser course${titleSuffix}`,
    languageCode: 'vi',
  },
  chapters: [
    {
      chapterOrder: 1,
      title: 'First chapter',
      lessons: [
        { lessonOrder: 1, title: 'Lesson one' },
        { lessonOrder: 2, title: 'Lesson two' },
      ],
    },
    {
      chapterOrder: 2,
      title: 'Second chapter',
      lessons: [{ lessonOrder: 1, title: 'Lesson three' }],
    },
  ],
});

/** Consumes a real Auth.js magic link: the token is stored as sha256(raw + AUTH_SECRET). */
async function signIn(page: Page, email: string): Promise<void> {
  const raw = randomBytes(32).toString('hex');
  const secret = process.env['AUTH_SECRET'] ?? '';
  await prisma.verificationToken.create({
    data: {
      identifier: email,
      token: createHash('sha256').update(`${raw}${secret}`).digest('hex'),
      expires: new Date(Date.now() + 10 * 60_000),
    },
  });

  await page.goto(
    `/api/auth/callback/email?token=${raw}&email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent('/import')}`,
  );
  await expect(page.getByTestId('payload')).toBeVisible();
}

test.beforeAll(async () => {
  await prisma.user.create({ data: { email: ownerEmail, name: 'Owner', userRole: 'admin_owner' } });
  await prisma.user.create({ data: { email: adminEmail, name: 'Admin', userRole: 'admin' } });
});

test.afterAll(async () => {
  const emails = [ownerEmail, adminEmail];
  const category = await prisma.category.findUnique({ where: { slug: categorySlug } });
  if (category) {
    await prisma.course.deleteMany({ where: { categoryId: category.id } });
    await prisma.category.delete({ where: { id: category.id } });
  }
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map((user) => user.id);
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.verificationToken.deleteMany({ where: { identifier: { in: emails } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test('an owner imports an outline and reorders the tree it produced', async ({ page }) => {
  // 1. Sign in through a real single-use magic link.
  await signIn(page, ownerEmail);

  // 2. The prompt template is downloadable and declares the shipped version.
  const templateHref = await page.getByTestId('template-download').getAttribute('href');
  const template = await page.request.get(templateHref!);
  expect(template.ok()).toBe(true);
  expect(await template.text()).toContain(`schemaVersion: ${SCHEMA_VERSION}`);

  // 3. A valid payload, with commit still disabled.
  const body = JSON.stringify(payload(), null, 2);
  await page.getByTestId('payload').fill(body);
  await expect(page.getByTestId('commit')).toBeDisabled();

  // 4. The dry run previews, and enables commit.
  await page.getByTestId('dry-run').click();
  await expect(page.getByTestId('job-progress')).toHaveAttribute('data-status', 'succeeded');
  await expect(page.getByTestId('preview')).toBeVisible();
  await expect(page.getByTestId('preview-chapters-to-create')).toHaveText('2');
  await expect(page.getByTestId('preview-lessons-to-create')).toHaveText('3');
  await expect(page.getByTestId('commit')).toBeEnabled();

  // 5. Editing the payload invalidates the preview.
  await page.getByTestId('payload').fill(`${body} `);
  await expect(page.getByTestId('commit')).toBeDisabled();

  // 6. Restore, re-run, commit.
  await page.getByTestId('payload').fill(body);
  await page.getByTestId('dry-run').click();
  await expect(page.getByTestId('job-progress')).toHaveAttribute('data-status', 'succeeded');
  await expect(page.getByTestId('commit')).toBeEnabled();

  await page.getByTestId('commit').click();
  await expect(page.getByTestId('job-progress')).toHaveAttribute('data-status', 'succeeded');
  await expect(page.getByTestId('applied')).toBeVisible();

  // 7. The tree shows what was imported, in order.
  const course = await prisma.course.findUniqueOrThrow({
    where: { slug: `${categorySlug}-n5` },
    select: { id: true },
  });
  await page.goto(`/courses/${course.id}`);
  await expect(page.getByTestId('curriculum-tree')).toBeVisible();
  await expect(page.getByTestId('chapter')).toHaveCount(2);
  await expect(page.getByTestId('chapter-title').first()).toHaveValue('First chapter');
  await expect(page.getByTestId('chapter-title').nth(1)).toHaveValue('Second chapter');

  // 8. Reordering sends exactly ONE structure request (FR-EDIT-04).
  const structureCalls: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes('/structure')) {
      structureCalls.push(request.url());
    }
  });

  await page.getByTestId('chapter-down').first().click();
  await expect(page.getByTestId('chapter-title').first()).toHaveValue('Second chapter');
  expect(structureCalls).toHaveLength(1);

  await page.reload();
  await expect(page.getByTestId('chapter-title').first()).toHaveValue('Second chapter');
});

test('an admin cannot assign, in the UI or past it', async ({ page }) => {
  await signIn(page, adminEmail);

  const course = await prisma.course.findUniqueOrThrow({
    where: { slug: `${categorySlug}-n5` },
    select: { id: true },
  });
  await page.goto(`/courses/${course.id}`);
  await expect(page.getByTestId('curriculum-tree')).toBeVisible();

  // 9a. The control is not rendered for an admin.
  await expect(page.getByTestId('chapter-assign')).toHaveCount(0);

  // 9b. And the server refuses it anyway — hiding a control is never the enforcement.
  const chapter = await prisma.chapter.findFirstOrThrow({
    where: { courseId: course.id, deletedAt: null },
    select: { id: true },
  });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } });

  const refused = await page.evaluate(
    async ([apiBase, chapterId, adminId]) => {
      const response = await fetch(`${apiBase}/api/admin/chapters/${chapterId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedAdminId: adminId }),
      });
      return { status: response.status, body: await response.json() };
    },
    [process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001', chapter.id, owner.id] as const,
  );

  expect(refused.status).toBe(403);
  expect(refused.body.errorCode).toBe('FORBIDDEN_OWNER_ONLY_FIELD');
});
