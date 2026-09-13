import type { PrismaClient } from './client';
import type {
  ChecklistChapter,
  ChecklistInput,
  ChecklistLesson,
} from '@knowledge-explorer/content';

/**
 * Loads everything FR-PUB-01 needs about a course, in six queries.
 *
 * Here rather than in either app for the reason the generation_jobs machine is
 * here: apps/api serves the checklist on GET and apps/worker re-checks it before
 * writing the published track, and the two never import each other. This is
 * plain data access over the Prisma client, which is what §11 assigns this
 * package; the VERDICT is `evaluatePublishChecklist` in packages/content, which
 * takes what this returns.
 *
 * BATCHED ON PURPOSE. The per-lesson staleness services in apps/api each run
 * several queries, so evaluating a forty-lesson course through them is roughly
 * two hundred round-trips for one screen. Everything below is fetched per
 * COURSE, never per lesson, and the api suite asserts the query count.
 *
 * `configuredVoiceIdentifier` is a parameter because resolving it reads
 * TTS_DEFAULT_VOICE, and this package never touches process.env for behaviour.
 */

/** The figure blocks of a stored draft block list. */
interface StoredBlock {
  readonly blockId: string;
  readonly blockType: string;
  readonly figureNumber?: number;
}

function figureBlocksOf(draftBlockList: unknown): ChecklistLesson['figureBlocks'] {
  const blocks = (draftBlockList as { blocks?: readonly StoredBlock[] } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block.blockType === 'figure')
    .map((block) => ({ blockId: block.blockId, figureNumber: block.figureNumber ?? null }));
}

export async function loadPublishChecklistInput(
  client: PrismaClient,
  courseId: string,
  configuredVoiceIdentifier: string,
): Promise<ChecklistInput | null> {
  const course = await client.course.findUnique({
    where: { id: courseId },
    select: { id: true, categoryId: true, coverImageUrl: true, pricingType: true },
  });
  if (!course) return null;

  // §4.3: soft-deleted rows stay in the LAST published snapshot but are excluded
  // from the next one, so the checklist must not see them either.
  const chapters = await client.chapter.findMany({
    where: { courseId, deletedAt: null },
    orderBy: { chapterOrder: 'asc' },
    select: {
      id: true,
      title: true,
      lessons: {
        where: { deletedAt: null },
        orderBy: { lessonOrder: 'asc' },
        select: { id: true, title: true, contentStatus: true },
      },
    },
  });

  const lessonIds = chapters.flatMap((chapter) => chapter.lessons.map((lesson) => lesson.id));

  const [contents, scripts, audios, images, activeProductCount] = await Promise.all([
    client.lessonContent.findMany({
      where: { lessonId: { in: lessonIds } },
      select: { lessonId: true, draftContentMarkdown: true, draftContentChecksum: true, draftBlockList: true },
    }),
    client.narrationScript.findMany({
      where: { lessonId: { in: lessonIds } },
      select: { lessonId: true, scriptStatus: true, sourceContentChecksum: true, scriptChecksum: true },
    }),
    client.lessonAudio.findMany({
      where: { lessonId: { in: lessonIds } },
      orderBy: { createdAt: 'asc' },
      select: { lessonId: true, audioStatus: true, sourceScriptChecksum: true, voiceIdentifier: true },
    }),
    client.lessonImage.findMany({
      where: { lessonId: { in: lessonIds } },
      select: {
        lessonId: true,
        blockReferenceId: true,
        isSelected: true,
        captionText: true,
        alternativeText: true,
      },
    }),
    // §5.7 item 7: a product may sell this course directly or its whole category.
    client.product.count({
      where: { isActive: true, OR: [{ courseId }, { categoryId: course.categoryId }] },
    }),
  ]);

  const contentByLesson = new Map(contents.map((row) => [row.lessonId, row]));
  const scriptByLesson = new Map(scripts.map((row) => [row.lessonId, row]));
  /**
   * §8 allows one audio row per (lesson, voice), so a course whose voice changed
   * can hold several. The first by creation wins, matching what
   * AudioService.stalenessFor reads; computeAudioStatus then reports `stale`
   * when its voice is not the configured one, which is exactly FR-AUDIO-03's
   * detectable voice change.
   */
  const audioByLesson = new Map<string, (typeof audios)[number]>();
  for (const row of audios) if (!audioByLesson.has(row.lessonId)) audioByLesson.set(row.lessonId, row);

  const imagesByLesson = new Map<string, (typeof images)[number][]>();
  for (const row of images) {
    const list = imagesByLesson.get(row.lessonId);
    if (list) list.push(row);
    else imagesByLesson.set(row.lessonId, [row]);
  }

  const mapped: ChecklistChapter[] = chapters.map((chapter) => ({
    chapterId: chapter.id,
    title: chapter.title,
    lessons: chapter.lessons.map((lesson): ChecklistLesson => {
      const content = contentByLesson.get(lesson.id);
      const script = scriptByLesson.get(lesson.id);
      const audio = audioByLesson.get(lesson.id);
      return {
        lessonId: lesson.id,
        title: lesson.title,
        contentStatus: lesson.contentStatus,
        draftContentMarkdown: content?.draftContentMarkdown ?? null,
        draftContentChecksum: content?.draftContentChecksum ?? null,
        figureBlocks: figureBlocksOf(content?.draftBlockList ?? null),
        images: (imagesByLesson.get(lesson.id) ?? []).map((image) => ({
          blockReferenceId: image.blockReferenceId,
          isSelected: image.isSelected,
          captionText: image.captionText,
          alternativeText: image.alternativeText,
        })),
        script: script
          ? {
              scriptStatus: script.scriptStatus,
              sourceContentChecksum: script.sourceContentChecksum,
              scriptChecksum: script.scriptChecksum,
            }
          : null,
        audio: audio
          ? {
              audioStatus: audio.audioStatus,
              sourceScriptChecksum: audio.sourceScriptChecksum,
              voiceIdentifier: audio.voiceIdentifier,
            }
          : null,
      };
    }),
  }));

  return {
    courseId: course.id,
    categoryId: course.categoryId,
    coverImageUrl: course.coverImageUrl,
    pricingType: course.pricingType,
    configuredVoiceIdentifier,
    activeProductCount,
    chapters: mapped,
  };
}
