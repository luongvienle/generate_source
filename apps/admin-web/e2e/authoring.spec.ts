import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { signIn } from './helpers';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser scenario from specs/p2-authoring/spec.md.
 *
 * Steps 6 to 8 are the assertion no other suite can make: that what the preview
 * DRAWS and what the database STORES agree about figure numbering, across an
 * insertion that renumbers. A renderer that counted figures itself would pass
 * every unit test and fail here.
 */

const prisma = getPrismaClient();
const run = randomBytes(4).toString('hex');

const ownerEmail = `p2-owner-${run}@example.test`;
const adminEmail = `p2-admin-${run}@example.test`;
const categorySlug = `p2-${run}`;

const ids = { draftCourse: '', draftLesson: '', publishedCourse: '', publishedLesson: '' };

const editorUrl = (courseId: string, lessonId: string): string =>
  `/courses/${courseId}/lessons/${lessonId}`;

async function seedCourse(suffix: string, publicationStatus: string, levelOrder: number) {
  const category = await prisma.category.upsert({
    where: { slug: categorySlug },
    create: { slug: categorySlug, displayName: `P2 ${run}` },
    update: {},
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `${categorySlug}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Authoring ${suffix}`,
      publicationStatus,
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

/** The editor is ready once its source pane has mounted CodeMirror. */
async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('lesson-editor')).toBeVisible();
  await expect(page.locator('[data-testid="markdown-source"] .cm-content')).toBeVisible();
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  const content = page.locator('[data-testid="markdown-source"] .cm-content');
  await content.click();
  await page.keyboard.insertText(text);
}

/**
 * Waits until the SERVER holds the content, rather than until the status text
 * says so.
 *
 * Autosave debounces for 3 seconds, so a burst of edits produces several saves;
 * "Saved at" may be reporting an earlier one while a later is still pending.
 * What the test actually cares about is what survives a reload, which is this.
 */
async function waitForStored(lessonId: string, fragment: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await prisma.lessonContent.findUnique({
          where: { lessonId },
          select: { draftContentMarkdown: true },
        });
        return row?.draftContentMarkdown ?? '';
      },
      { timeout: 20_000, message: `waiting for the draft to contain ${fragment}` },
    )
    .toContain(fragment);
}

test.beforeAll(async () => {
  await prisma.user.create({ data: { email: ownerEmail, name: 'Owner', userRole: 'admin_owner' } });
  await prisma.user.create({ data: { email: adminEmail, name: 'Admin', userRole: 'admin' } });

  const draft = await seedCourse('draft', 'draft', 1);
  ids.draftCourse = draft.courseId;
  ids.draftLesson = draft.lessonId;

  const published = await seedCourse('published', 'published', 2);
  ids.publishedCourse = published.courseId;
  ids.publishedLesson = published.lessonId;
});

test.afterAll(async () => {
  const emails = [ownerEmail, adminEmail];
  const category = await prisma.category.findUnique({ where: { slug: categorySlug } });
  if (category) {
    await prisma.course.deleteMany({ where: { categoryId: category.id } });
    await prisma.category.delete({ where: { id: category.id } });
  }
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.verificationToken.deleteMany({ where: { identifier: { in: emails } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test('an owner authors a lesson, and the preview never disagrees with what is stored', async ({
  page,
}) => {
  // 1. Sign in and reach the curriculum tree.
  await signIn(page, ownerEmail, `/courses/${ids.draftCourse}`, 'curriculum-tree');

  // 2. Open the lesson from the tree, as an admin actually would.
  await page.getByTestId('lesson-edit').first().click();
  await waitForEditor(page);

  // 3. Write a heading and prose, then a figure and a captioned table from the
  //    toolbar — the two constructs nobody should have to type by hand.
  await typeInEditor(page, '# The A-row\n\nHiragana is a **syllabary**.\n\n');
  await page.getByTestId('toolbar-insert-figure').click();
  await page.getByTestId('toolbar-insert-table').click();

  // 4. Autosave lands with no click anywhere (FR-EDIT-03).
  await expect(page.getByTestId('save-status')).toContainText('Saved at', { timeout: 15_000 });
  await waitForStored(ids.draftLesson, '::figure');
  await waitForStored(ids.draftLesson, '::caption');

  // 5. The preview shows the numbering the parser assigned.
  await expect(page.getByTestId('preview')).toContainText('Figure 1');
  await expect(page.getByTestId('preview')).toContainText('Table 1');

  // 6. It survives a reload.
  await page.reload();
  await waitForEditor(page);
  await expect(page.getByTestId('preview')).toContainText('Figure 1');
  await expect(page.getByTestId('markdown-source')).toContainText('The A-row');

  // 7. Insert a SECOND figure above the first, and watch both renumber.
  await page.locator('[data-testid="markdown-source"] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.getByTestId('toolbar-insert-figure').click();

  await expect(page.getByTestId('preview')).toContainText('Figure 2');
  await expect
    .poll(
      async () => {
        const row = await prisma.lessonContent.findUnique({
          where: { lessonId: ids.draftLesson },
          select: { draftBlockList: true },
        });
        const blocks = (row?.draftBlockList as { blocks?: Array<{ blockType: string }> })?.blocks;
        return (blocks ?? []).filter((block) => block.blockType === 'figure').length;
      },
      { timeout: 20_000, message: 'waiting for the second figure to be stored' },
    )
    .toBe(2);

  // 8. THE LOAD-BEARING ASSERTION. Read the stored block list back through the
  //    API and require it to agree with what the preview drew — same numbers,
  //    and the original figure's blockId unchanged.
  const stored = await prisma.lessonContent.findUnique({
    where: { lessonId: ids.draftLesson },
    select: { draftBlockList: true, draftContentChecksum: true },
  });
  const blocks = (stored?.draftBlockList as { blocks: Array<Record<string, unknown>> }).blocks;
  const figures = blocks.filter((block) => block['blockType'] === 'figure');

  expect(figures).toHaveLength(2);
  expect(figures.map((figure) => figure['figureNumber'])).toEqual([1, 2]);
  expect(stored?.draftContentChecksum).toMatch(/^[0-9a-f]{64}$/u);

  // The figure written first keeps the id it was minted with, even though it is
  // now Figure 2 — the numeral in a blockId is a mint sequence, not a number.
  const survivor = figures.find((figure) => figure['figureNumber'] === 2);
  expect(survivor?.['blockId']).toBe('fig3');

  const previewFigures = await page
    .locator('[data-testid="preview"] [data-figure-number]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-figure-number')));
  expect(previewFigures).toEqual(['1', '2']);

  // 9. A rich-text paste becomes markdown, and saves.
  await page.evaluate(() => {
    const content = document.querySelector('[data-testid="markdown-source"] .cm-content');
    const data = new DataTransfer();
    data.setData('text/html', '<p>Pasted <strong>rich</strong> text.</p>');
    content?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });

  await expect(page.getByTestId('markdown-source')).toContainText('Pasted **rich** text.');
  await waitForStored(ids.draftLesson, 'Pasted **rich** text.');
});

test('a failed save warns, retries, and recovers without the admin doing anything', async ({
  page,
}) => {
  await signIn(page, ownerEmail, editorUrl(ids.draftCourse, ids.draftLesson), 'lesson-editor');
  await waitForEditor(page);

  // Break the save. Route interception rather than stopping the API, so the test
  // does not fight Playwright's webServer lifecycle.
  await page.route('**/api/admin/lessons/*/content', async (route) => {
    if (route.request().method() === 'PUT') return route.abort('failed');
    return route.fallback();
  });

  await typeInEditor(page, '\n\nA sentence written while the network is down.\n');

  // FR-EDIT-03: a visible warning, never a silent failure.
  await expect(page.getByTestId('save-status')).toContainText('Not saved', { timeout: 15_000 });
  await expect(page.getByTestId('save-status')).toContainText('Retrying');

  // Heal the network and do nothing else: the backoff loop must recover alone.
  await page.unroute('**/api/admin/lessons/*/content');
  await expect(page.getByTestId('save-status')).toContainText('Saved at', { timeout: 45_000 });

  const stored = await prisma.lessonContent.findUnique({
    where: { lessonId: ids.draftLesson },
    select: { draftContentMarkdown: true },
  });
  expect(stored?.draftContentMarkdown).toContain('while the network is down');
});

test('an admin sees a published lesson read-only, and never attempts a write', async ({ page }) => {
  await signIn(
    page,
    adminEmail,
    editorUrl(ids.publishedCourse, ids.publishedLesson),
    'lesson-editor',
  );
  await waitForEditor(page);

  // R-01: the course is published, so only the owner may edit it.
  await expect(page.getByTestId('read-only-banner')).toContainText('published');
  await expect(page.getByTestId('toolbar-insert-figure')).toBeDisabled();

  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT') writes.push(request.url());
  });

  await page.locator('[data-testid="markdown-source"] .cm-content').click();
  await page.keyboard.type('this should not be editable');
  await page.waitForTimeout(5_000);

  expect(writes).toEqual([]);
  const stored = await prisma.lessonContent.findUnique({
    where: { lessonId: ids.publishedLesson },
  });
  expect(stored).toBeNull();
});
