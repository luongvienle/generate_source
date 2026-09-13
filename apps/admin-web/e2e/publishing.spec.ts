import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  type Block,
} from '@knowledge-explorer/content';
import { structurePayloadSchema } from '@knowledge-explorer/shared';
import { signIn } from './helpers';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser scenario from specs/p6-publishing/spec.md.
 *
 * Three things here would pass every API test while being wrong end to end:
 *
 *  - **the checklist an owner actually sees names what to fix.** A failing item
 *    with a generic reason passes any assertion about `passed: false` and is
 *    useless in front of a person.
 *  - **the publish completes without a reload.** The panel attaches to the job
 *    stream; if it did not, the owner would sit on "Publishing…" forever while
 *    the database said `published`.
 *  - **the unpublished-changes indicator comes back after an edit**, which is
 *    the admin-visible face of FR-PUB-03 and the thing seven write paths used to
 *    get wrong.
 *
 * Everything P2 through P5 own is seeded through Prisma. Driving the editor to
 * author six lessons would be testing P2, would take minutes, and would fail for
 * reasons that have nothing to do with publishing.
 */

const prisma = getPrismaClient();
const run = randomBytes(4).toString('hex');
const ownerEmail = `p6-owner-${run}@example.test`;

const BODY = '# Writing systems\n\nJapanese uses three scripts in combination.\n\nHiragana is a syllabary.\n';
const FIGURE_BODY = '# Stroke order\n\nThe first stroke runs left to right.\n\n::figure\n';

const ids = { owner: '', category: '', course: '', firstLesson: '', figureLesson: '' };

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

/** An approved script and ready audio, as successful P4 and P5 runs would leave them. */
async function seedNarrationAndAudio(lessonId: string): Promise<void> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true, draftContentChecksum: true },
  });
  const blocks = (content?.draftBlockList as unknown as { blocks: Block[] }).blocks;
  const segments = blocks.map((block, index) =>
    buildSegment({ block, segmentOrder: index, narrationText: `Đọc ${block.blockId}.`, isEdited: false }),
  );
  const checksum = scriptChecksum(segments);

  const payload = {
    scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
    scriptChecksum: checksum,
    sourceContentChecksum: content?.draftContentChecksum ?? '',
    scriptStatus: 'ready',
    reviewedByUserId: ids.owner,
    reviewedAt: new Date(),
  };
  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: { lessonId, ...payload },
    update: payload,
  });

  await prisma.lessonAudio.deleteMany({ where: { lessonId } });
  await prisma.lessonAudio.create({
    data: {
      lessonId,
      voiceIdentifier: 'alloy',
      voiceProviderName: 'fake',
      mergedAudioFileUrl: `lessons/${lessonId}/audio/merged/seeded.mp3`,
      totalDurationSeconds: 12,
      totalCharacterCount: 120,
      sourceScriptChecksum: checksum,
      audioStatus: 'ready',
    },
  });
}

async function seedSelectedImage(lessonId: string): Promise<void> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true },
  });
  const blocks = (content?.draftBlockList as unknown as { blocks: Block[] }).blocks;
  for (const figure of blocks.filter((block) => block.blockType === 'figure')) {
    await prisma.lessonImage.create({
      data: {
        lessonId,
        blockReferenceId: figure.blockId,
        figureNumber: figure.figureNumber ?? 1,
        imageFileUrl: `lessons/${lessonId}/images/${figure.blockId}.png`,
        captionText: 'Stroke order for the first character',
        alternativeText: 'A diagram showing three numbered strokes',
        imageSource: 'ai_generated',
        isSelected: true,
      },
    });
  }
}

test.beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: ownerEmail, name: 'P6 owner', userRole: 'admin_owner' },
    select: { id: true },
  });
  ids.owner = owner.id;

  const category = await prisma.category.create({
    data: { slug: `p6-${run}`, displayName: `P6 ${run}` },
    select: { id: true },
  });
  ids.category = category.id;

  /**
   * A course that fails the checklist in four distinct ways:
   *   - only two chapters (item 5)
   *   - one lesson with no body, still `empty` (items 1 and 2)
   *   - one figure block with no selected image (item 3)
   *   - no cover image (item 6)
   */
  const course = await prisma.course.create({
    data: {
      categoryId: ids.category,
      slug: `p6-${run}`,
      levelLabel: 'N5',
      levelOrder: 1,
      title: 'Publishing scenario',
      publicationStatus: 'draft',
      languageCode: 'vi',
      coverImageUrl: null,
    },
    select: { id: true },
  });
  ids.course = course.id;

  for (let c = 1; c <= 2; c += 1) {
    const chapter = await prisma.chapter.create({
      data: { courseId: course.id, chapterOrder: c, title: `Chapter ${c}` },
      select: { id: true },
    });
    for (let l = 1; l <= 2; l += 1) {
      const isEmptyOne = c === 1 && l === 1;
      const isFigureOne = c === 1 && l === 2;
      const lesson = await prisma.lesson.create({
        data: {
          chapterId: chapter.id,
          lessonOrder: l,
          title: `Lesson ${c}.${l}`,
          estimatedMinutes: 10,
          contentStatus: isEmptyOne ? 'empty' : 'drafting',
        },
        select: { id: true },
      });
      if (isEmptyOne) {
        ids.firstLesson = lesson.id;
        continue;
      }
      if (isFigureOne) ids.figureLesson = lesson.id;
      await seedBody(lesson.id, isFigureOne ? FIGURE_BODY : BODY);
      await seedNarrationAndAudio(lesson.id);
    }
  }
});

test('an owner fixes a failing checklist, publishes, and sees the change indicator return', async ({
  page,
}) => {
  await signIn(page, ownerEmail, `/courses/${ids.course}`, 'publish-panel');

  // ── 1. the checklist shows the failures, with reasons that name the rows ──
  await expect(page.getByTestId('publication-status')).toHaveAttribute('data-status', 'draft');
  await expect(page.getByTestId('publish-checklist')).toHaveAttribute('data-passed', 'false');

  for (const id of ['lesson_content_present', 'no_empty_lesson', 'figures_illustrated', 'structure_minimums', 'category_and_cover']) {
    await expect(page.getByTestId(`checklist-${id}`)).toHaveAttribute('data-passed', 'false');
  }
  await expect(page.getByTestId('checklist-reason-structure_minimums')).toContainText(
    '2 of the 3 chapters',
  );
  await expect(page.getByTestId('checklist-offenders-lesson_content_present')).toContainText(
    'Lesson 1.1',
  );
  await expect(page.getByTestId('checklist-reason-category_and_cover')).toContainText('cover image');

  // Publishing is refused while the checklist fails, and the panel says so.
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-error')).toContainText('checklist has failures');
  await expect(page.getByTestId('publication-status')).toHaveAttribute('data-status', 'draft');

  // ── 2. fix every failing item ──
  await seedBody(ids.firstLesson, BODY);
  await seedNarrationAndAudio(ids.firstLesson);
  await prisma.lesson.update({
    where: { id: ids.firstLesson },
    data: { contentStatus: 'drafting' },
  });
  await seedSelectedImage(ids.figureLesson);

  const third = await prisma.chapter.create({
    data: { courseId: ids.course, chapterOrder: 3, title: 'Chapter 3' },
    select: { id: true },
  });
  for (let l = 1; l <= 2; l += 1) {
    const lesson = await prisma.lesson.create({
      data: {
        chapterId: third.id,
        lessonOrder: l,
        title: `Lesson 3.${l}`,
        estimatedMinutes: 10,
        contentStatus: 'drafting',
      },
      select: { id: true },
    });
    await seedBody(lesson.id, BODY);
    await seedNarrationAndAudio(lesson.id);
  }
  await prisma.course.update({
    where: { id: ids.course },
    data: { coverImageUrl: 'https://cdn.example.test/n5.png', hasUnpublishedChanges: false },
  });

  await page.reload();
  await expect(page.getByTestId('publish-checklist')).toHaveAttribute('data-passed', 'true');

  // ── 3. publish, and watch it settle without a reload ──
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('job-progress')).toBeVisible();
  await expect(page.getByTestId('publication-status')).toHaveAttribute('data-status', 'published', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('published-version')).toContainText('version 1');

  const structure = await prisma.publishedCourseStructure.findUnique({
    where: { courseId: ids.course },
  });
  expect(structure?.publishedVersionNumber).toBe(1);
  expect(structure?.totalLessonCount).toBe(6);
  const payload = structurePayloadSchema.parse(structure?.structurePayload);
  expect(payload.chapters).toHaveLength(3);
  expect(payload.chapters.flatMap((chapter) => chapter.lessons)).toHaveLength(6);

  const contents = await prisma.lessonContent.findMany({
    where: { lesson: { chapter: { courseId: ids.course } } },
    select: { draftContentMarkdown: true, publishedContentMarkdown: true },
  });
  expect(contents).toHaveLength(6);
  for (const content of contents) {
    expect(content.publishedContentMarkdown).toBe(content.draftContentMarkdown);
  }

  const lessons = await prisma.lesson.findMany({
    where: { chapter: { courseId: ids.course }, deletedAt: null },
    select: { contentStatus: true },
  });
  expect(lessons.every((lesson) => lesson.contentStatus === 'published')).toBe(true);

  const course = await prisma.course.findUnique({
    where: { id: ids.course },
    select: { hasUnpublishedChanges: true, publicationStatus: true },
  });
  expect(course).toMatchObject({ hasUnpublishedChanges: false, publicationStatus: 'published' });

  // ── 4. an edit brings the indicator back ──
  await seedBody(ids.firstLesson, `${BODY}\nAn extra paragraph added after publishing.\n`);
  await seedNarrationAndAudio(ids.firstLesson);
  await prisma.lesson.update({
    where: { id: ids.firstLesson },
    data: { contentStatus: 'drafting' },
  });
  // FR-PUB-03 is asserted through the API in unpublished-changes.e2e-spec.ts;
  // here the flag is set the way an edit would set it, so the PANEL is what is
  // under test.
  await prisma.course.update({
    where: { id: ids.course },
    data: { hasUnpublishedChanges: true },
  });

  await page.reload();
  await expect(page.getByTestId('unpublished-changes')).toBeVisible();
  await expect(page.getByTestId('publish')).toHaveText('Publish changes');

  // ── 5. publishing again advances the version ──
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('published-version')).toContainText('version 2', {
    timeout: 30_000,
  });
  expect(
    (await prisma.publishedCourseStructure.findUnique({ where: { courseId: ids.course } }))
      ?.publishedVersionNumber,
  ).toBe(2);

  // ── 6. unpublish preserves the published track ──
  await page.getByTestId('unpublish').click();
  await expect(page.getByTestId('publication-status')).toHaveAttribute(
    'data-status',
    'unpublished',
  );

  const afterUnpublish = await prisma.publishedCourseStructure.findUnique({
    where: { courseId: ids.course },
  });
  expect(afterUnpublish?.publishedVersionNumber).toBe(2);
  const stillPublished = await prisma.lessonContent.findMany({
    where: { lesson: { chapter: { courseId: ids.course } } },
    select: { publishedContentMarkdown: true },
  });
  expect(stillPublished.every((row) => row.publishedContentMarkdown !== null)).toBe(true);
});
