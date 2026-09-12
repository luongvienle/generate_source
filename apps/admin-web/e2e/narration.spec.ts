import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { blockListChecksum, parseLessonMarkdown } from '@knowledge-explorer/content';
import { signIn } from './helpers';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser scenario from specs/p4-narration/spec.md.
 *
 * Two steps are load-bearing and would pass every unit test while being wrong
 * end to end:
 *
 *  - **flush-then-generate** is asserted on NETWORK ORDER — the content PUT must
 *    complete before the narration POST is issued, or an admin pays for a script
 *    of a paragraph they had already rewritten.
 *  - **an edit keeps approval, a run clears it**, which is the one pair of rules
 *    that looks inconsistent and is deliberate.
 *
 * Generation runs against the deterministic fake provider, so this needs no API
 * key and produces the same narration every run.
 */

const prisma = getPrismaClient();
const run = randomBytes(4).toString('hex');

const ownerEmail = `p4-owner-${run}@example.test`;
const categorySlug = `p4-${run}`;

const ids = { course: '', lesson: '', figureCourse: '', figureLesson: '' };

const LESSON_BODY =
  '# Writing systems\n\nJapanese uses three scripts in combination.\n\nHiragana is a syllabary used for grammar.\n';

const editorUrl = (courseId: string, lessonId: string): string =>
  `/courses/${courseId}/lessons/${lessonId}`;

async function seedCourse(suffix: string, levelOrder: number) {
  const category = await prisma.category.upsert({
    where: { slug: categorySlug },
    create: { slug: categorySlug, displayName: `P4 ${run}` },
    update: {},
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `${categorySlug}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Narration ${suffix}`,
      publicationStatus: 'draft',
      languageCode: 'vi',
    },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, lessonOrder: 1, title: `Lesson ${suffix}` },
    select: { id: true },
  });
  return { courseId: course.id, lessonId: lesson.id };
}

/** Seeds a body directly; driving the editor for it would be testing P2. */
async function seedBody(lessonId: string, markdown: string): Promise<void> {
  const parsed = parseLessonMarkdown(markdown, null);
  if (!parsed.ok) throw new Error('seed markdown did not parse');
  await prisma.lessonContent.upsert({
    where: { lessonId },
    create: {
      lessonId,
      draftContentMarkdown: markdown,
      draftBlockList: parsed.blockList as unknown as object,
      draftContentChecksum: blockListChecksum(parsed.blockList),
      draftUpdatedAt: new Date(),
    },
    update: {
      draftContentMarkdown: markdown,
      draftBlockList: parsed.blockList as unknown as object,
      draftContentChecksum: blockListChecksum(parsed.blockList),
      draftUpdatedAt: new Date(),
    },
  });
}

/** Signs in straight to the editor, as the other browser suites do. */
async function openEditor(page: Page, courseId: string, lessonId: string): Promise<void> {
  await signIn(page, ownerEmail, editorUrl(courseId, lessonId), 'lesson-editor');
  await expect(page.locator('[data-testid="markdown-source"] .cm-content')).toBeVisible();
}

async function openNarration(page: Page, courseId: string, lessonId: string): Promise<void> {
  await openEditor(page, courseId, lessonId);
  await page.getByTestId('tab-narration').click();
  await expect(page.getByTestId('narration-tab')).toBeVisible();
}

/** Waits for the worker to land a terminal script status. */
async function waitForStatus(lessonId: string, status: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await prisma.narrationScript.findUnique({
            where: { lessonId },
            select: { scriptStatus: true },
          })
        )?.scriptStatus ?? 'none',
      { timeout: 40_000, message: `waiting for scriptStatus ${status}` },
    )
    .toBe(status);
}

test.beforeAll(async () => {
  await prisma.user.create({ data: { email: ownerEmail, name: 'Owner', userRole: 'admin_owner' } });

  const main = await seedCourse('main', 1);
  ids.course = main.courseId;
  ids.lesson = main.lessonId;
  await seedBody(ids.lesson, LESSON_BODY);

  const figure = await seedCourse('figure', 2);
  ids.figureCourse = figure.courseId;
  ids.figureLesson = figure.lessonId;
  await seedBody(ids.figureLesson, '::figure\n\nProse that follows the figure.\n');
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('generates a script and shows one row per block', async ({ page }) => {
  await openNarration(page, ids.course, ids.lesson);

  await expect(page.getByTestId('narration-row')).toHaveCount(3);
  await expect(page.getByTestId('narration-status')).toHaveText(/Not generated/u);

  await page.getByTestId('narration-generate').click();
  await waitForStatus(ids.lesson, 'ready');

  await expect
    .poll(async () => page.getByTestId('narration-status').textContent(), { timeout: 30_000 })
    .toMatch(/Ready/u);

  const texts = await page.getByTestId('narration-text').all();
  expect(texts.length).toBe(3);
  for (const box of texts) expect((await box.inputValue()).trim().length).toBeGreaterThan(0);
});

test('an edit keeps approval, and a regeneration clears it', async ({ page }) => {
  await openNarration(page, ids.course, ids.lesson);
  await expect(page.getByTestId('narration-status')).toHaveText(/Ready/u);

  await page.getByTestId('narration-approve').click();
  await expect(page.getByTestId('narration-approved')).toBeVisible();

  // A hand edit is itself an act of review: approval survives it.
  const firstBox = page.getByTestId('narration-text').first();
  await firstBox.click();
  await firstBox.fill('A sentence I wrote myself.');
  await firstBox.blur();

  await expect(page.getByTestId('narration-edited').first()).toBeVisible();
  await expect(page.getByTestId('narration-approved')).toBeVisible();

  // A run writes machine text no human has read, so it always clears approval —
  // and the confirmation says so before anything is spent.
  await page.getByTestId('narration-generate').click();
  await expect(page.getByTestId('narration-regenerate-confirm')).toBeVisible();
  await page.getByTestId('narration-regenerate-confirmed').click();

  await waitForStatus(ids.lesson, 'ready');
  await expect
    .poll(async () => page.getByTestId('narration-approved').count(), { timeout: 30_000 })
    .toBe(0);

  // The hand-edited segment survived, because its block never changed.
  await expect
    .poll(async () => page.getByTestId('narration-text').first().inputValue(), { timeout: 10_000 })
    .toBe('A sentence I wrote myself.');
});

test('editing the lesson body marks exactly the touched block stale', async ({ page }) => {
  await openEditor(page, ids.course, ids.lesson);

  const content = page.locator('[data-testid="markdown-source"] .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(
    '# Writing systems\n\nJapanese uses four scripts in combination.\n\nHiragana is a syllabary used for grammar.\n',
  );
  await content.blur();

  await expect
    .poll(
      async () =>
        (
          await prisma.lessonContent.findUnique({
            where: { lessonId: ids.lesson },
            select: { draftContentMarkdown: true },
          })
        )?.draftContentMarkdown ?? '',
      { timeout: 25_000 },
    )
    .toContain('four scripts');

  await page.getByTestId('tab-narration').click();
  await expect(page.getByTestId('narration-status')).toHaveText(/Out of date/u);
  await expect(page.locator('[data-testid="narration-row"][data-freshness="changed"]')).toHaveCount(1);

  // Approving a stale script would record a review of text the lesson no longer
  // says, so the action is refused at the UI as well as at the API.
  await expect(page.getByTestId('narration-approve')).toBeDisabled();
});

test('Generate flushes a dirty buffer before issuing the POST', async ({ page }) => {
  await openEditor(page, ids.course, ids.lesson);

  /**
   * THE ASSERTION IS ON NETWORK ORDER, not on a screenshot: the content PUT must
   * have completed before the narration POST is issued. Anything weaker passes
   * even when the admin pays for a script of text they already replaced.
   */
  const order: string[] = [];
  page.on('requestfinished', (requestObject) => {
    const url = requestObject.url();
    const method = requestObject.method();
    if (method === 'PUT' && url.includes('/content')) order.push('content-put-finished');
    if (method === 'POST' && url.includes('/narration-script')) order.push('narration-post');
  });

  const content = page.locator('[data-testid="markdown-source"] .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(LESSON_BODY + '\nAn appended paragraph, typed just now.\n');

  // Switch tabs and generate immediately, well inside the autosave debounce.
  await page.getByTestId('tab-narration').click();
  await page.getByTestId('narration-generate').click();

  const confirm = page.getByTestId('narration-regenerate-confirm');
  if (await confirm.isVisible().catch(() => false)) {
    await page.getByTestId('narration-regenerate-confirmed').click();
  }

  await expect.poll(() => order.filter((e) => e === 'narration-post').length, { timeout: 30_000 }).toBe(1);

  expect(order.indexOf('content-put-finished')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('content-put-finished')).toBeLessThan(order.indexOf('narration-post'));

  await waitForStatus(ids.lesson, 'ready');
});

test('refuses a lesson whose figure has no caption, and names it', async ({ page }) => {
  await openNarration(page, ids.figureCourse, ids.figureLesson);

  await page.getByTestId('narration-generate').click();

  const gaps = page.getByTestId('narration-figure-gaps');
  await expect(gaps).toBeVisible();
  await expect(gaps).toContainText('Figure 1');
  await expect(gaps).toContainText('selectedImage');

  // Nothing was written: no script row at all, so no lock to clear.
  expect(
    await prisma.narrationScript.findUnique({ where: { lessonId: ids.figureLesson } }),
  ).toBeNull();
});
