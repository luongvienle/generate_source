import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  segmentChecksum,
} from '@knowledge-explorer/content';
import { signIn } from './helpers';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser scenario from specs/p5-audio/spec.md.
 *
 * Three things here would pass every unit test while being wrong end to end:
 *
 *  - **the merged file is actually fetchable.** The server stores an object KEY
 *    and must presign it; returning the key raw would 404 in a player and no
 *    server-side assertion would notice. Asserted by intercepting the response,
 *    never by playing the audio.
 *  - **approval genuinely gates the button**, with the reason visible, rather
 *    than the tab rendering a control the API would refuse.
 *  - **one narration edit flips exactly one badge**, which is the admin-visible
 *    face of FR-AUDIO-01's per-segment reuse.
 *
 * The run uses the deterministic fake provider, so this needs no API key. It does
 * need ffmpeg: the worker refuses to boot without it and global-setup.ts waits on
 * the `Worker ready.` line.
 */

const prisma = getPrismaClient();
const run = randomBytes(4).toString('hex');

const ownerEmail = `p5-owner-${run}@example.test`;
const categorySlug = `p5-${run}`;

const ids = { course: '', lesson: '', unapprovedCourse: '', unapprovedLesson: '' };

const LESSON_BODY =
  '# Writing systems\n\nJapanese uses three scripts in combination.\n\nHiragana is a syllabary used for grammar.\n';

const editorUrl = (courseId: string, lessonId: string): string =>
  `/courses/${courseId}/lessons/${lessonId}`;

async function seedCourse(suffix: string, levelOrder: number) {
  const category = await prisma.category.upsert({
    where: { slug: categorySlug },
    create: { slug: categorySlug, displayName: `P5 ${run}` },
    update: {},
    select: { id: true },
  });
  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `${categorySlug}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Audio ${suffix}`,
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
  const data = {
    draftContentMarkdown: markdown,
    draftBlockList: parsed.blockList as unknown as object,
    draftContentChecksum: blockListChecksum(parsed.blockList),
    draftUpdatedAt: new Date(),
  };
  await prisma.lessonContent.upsert({
    where: { lessonId },
    create: { lessonId, ...data },
    update: data,
  });
}

/** Seeds a narration script directly; generating one would be testing P4. */
async function seedScript(lessonId: string, approved: boolean): Promise<void> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true, draftContentChecksum: true },
  });
  const blocks = (content!.draftBlockList as unknown as {
    blocks: Parameters<typeof buildSegment>[0]['block'][];
  }).blocks;

  const segments = blocks.map((block, index) =>
    buildSegment({
      block,
      segmentOrder: index,
      narrationText: `Bản đọc cho khối ${block.blockId}.`,
      isEdited: false,
    }),
  );

  const owner = await prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } });
  const data = {
    scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
    scriptChecksum: scriptChecksum(segments),
    sourceContentChecksum: content!.draftContentChecksum ?? '',
    scriptStatus: 'ready',
    reviewedByUserId: approved ? owner!.id : null,
    reviewedAt: approved ? new Date() : null,
  };

  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: { lessonId, ...data },
    update: data,
  });
}

async function openAudio(page: Page, courseId: string, lessonId: string): Promise<void> {
  await signIn(page, ownerEmail, editorUrl(courseId, lessonId), 'lesson-editor');
  await expect(page.locator('[data-testid="markdown-source"] .cm-content')).toBeVisible();
  await page.getByTestId('tab-audio').click();
  await expect(page.getByTestId('audio-tab')).toBeVisible();
}

/** Waits for the worker to land a terminal audio status. */
async function waitForStatus(lessonId: string, status: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await prisma.lessonAudio.findFirst({
            where: { lessonId },
            select: { audioStatus: true },
          })
        )?.audioStatus ?? 'none',
      { timeout: 120_000, message: `waiting for audioStatus ${status}` },
    )
    .toBe(status);
}

test.beforeAll(async () => {
  await prisma.user.create({ data: { email: ownerEmail, name: 'Owner', userRole: 'admin_owner' } });

  const main = await seedCourse('main', 1);
  ids.course = main.courseId;
  ids.lesson = main.lessonId;
  await seedBody(ids.lesson, LESSON_BODY);
  await seedScript(ids.lesson, true);

  const unapproved = await seedCourse('unapproved', 2);
  ids.unapprovedCourse = unapproved.courseId;
  ids.unapprovedLesson = unapproved.lessonId;
  await seedBody(ids.unapprovedLesson, LESSON_BODY);
  await seedScript(ids.unapprovedLesson, false);
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('refuses to generate while the narration script is unapproved, and says why', async ({
  page,
}) => {
  await openAudio(page, ids.unapprovedCourse, ids.unapprovedLesson);

  // §5.5 makes approval the enforcement point; the tab must not offer a click
  // the API would refuse.
  await expect(page.getByTestId('audio-generate')).toBeDisabled();
  await expect(page.getByTestId('audio-blocked')).toContainText(/approved/iu);
});

test('generates audio, shows progress, and serves a fetchable merged file', async ({ page }) => {
  await openAudio(page, ids.course, ids.lesson);

  await expect(page.getByTestId('audio-status')).toHaveText(/Not generated/u);
  await expect(page.getByTestId('audio-generate')).toBeEnabled();

  await page.getByTestId('audio-generate').click();
  await waitForStatus(ids.lesson, 'ready');

  await expect
    .poll(async () => page.getByTestId('audio-status').textContent(), { timeout: 60_000 })
    .toMatch(/Ready/u);

  const player = page.getByTestId('audio-player');
  await expect(player).toBeVisible();

  const source = await player.getAttribute('src');
  expect(source).toBeTruthy();

  /**
   * THE ASSERTION THIS SUITE EXISTS FOR. The server stores an object KEY;
   * returning it unsigned would render a player that silently fails. Fetching
   * the URL the browser actually holds is the only way to catch that — and the
   * response is INTERCEPTED rather than played, because Playwright's browser has
   * no audio device and playback would prove nothing anyway.
   */
  const response = await page.request.get(source!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('audio/mpeg');
  expect((await response.body()).byteLength).toBeGreaterThan(0);
});

test('shows one row per narration segment with its offset', async ({ page }) => {
  await openAudio(page, ids.course, ids.lesson);

  const rows = page.getByTestId('audio-rows').locator('li');
  await expect(rows).toHaveCount(3);

  // The first segment starts the file.
  await expect(rows.first()).toContainText('0:00');
});

test('one narration edit flips exactly one badge to stale', async ({ page }) => {
  const script = await prisma.narrationScript.findUnique({
    where: { lessonId: ids.lesson },
    select: { scriptSegments: true },
  });
  const envelope = script!.scriptSegments as unknown as {
    segments: { blockId: string; narrationText: string; segmentChecksum: string }[];
    totalEstimatedSeconds: number;
  };

  const targetBlockId = envelope.segments[1]!.blockId;
  const edited = envelope.segments.map((segment, index) =>
    index === 1
      ? {
          ...segment,
          narrationText: 'Một câu hoàn toàn mới.',
          segmentChecksum: segmentChecksum('Một câu hoàn toàn mới.'),
          isEdited: true,
        }
      : segment,
  );

  await prisma.narrationScript.update({
    where: { lessonId: ids.lesson },
    data: {
      scriptSegments: { ...envelope, segments: edited } as unknown as object,
      scriptChecksum: scriptChecksum(edited as never),
    },
  });

  await openAudio(page, ids.course, ids.lesson);

  // FR-AUDIO-01's saving, made visible: one row moved, the rest did not.
  await expect(page.getByTestId(`audio-freshness-${targetBlockId}`)).toBeVisible();
  await expect(page.getByTestId('audio-rows').locator('li[data-freshness="stale"]')).toHaveCount(1);
  await expect(page.getByTestId('audio-rows').locator('li[data-freshness="fresh"]')).toHaveCount(2);

  // And the regeneration dialog quotes the same split, since that is the only
  // view an admin gets of what a run will cost.
  await page.getByTestId('audio-generate').click();
  await expect(page.getByTestId('audio-regenerate-confirm')).toContainText('1 segment');
  await expect(page.getByTestId('audio-regenerate-confirm')).toContainText('2 will be reused');
});
