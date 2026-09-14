import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  type Block,
} from '@knowledge-explorer/content';
import { S3ObjectStorage, s3ConfigFromEnv } from '@knowledge-explorer/storage';
import { prisma } from './helpers';

/**
 * Builds the course the learner scenario reads.
 *
 * Everything P1 through P5 own is written through Prisma, exactly as
 * `apps/admin-web/e2e/publishing.spec.ts` does: driving the editor to author
 * lessons would be testing P2, would take minutes, and would fail for reasons
 * unrelated to the learner app. What is NOT seeded is anything P7 owns — the
 * free-preview flag goes through its admin control, and the publish goes
 * through the publish job.
 *
 * REAL BYTES GO INTO OBJECT STORAGE. A presigned URL that resolves to nothing
 * is indistinguishable from a correctly signed one until a browser tries to
 * render it, and "the figure actually loads" is the assertion that catches a
 * URL signed against the wrong endpoint (CLAUDE.md invariant 5).
 */

export const BODY = [
  '# Thứ tự nét viết',
  '',
  'Nét đầu tiên chạy từ trái sang phải.',
  '',
  '::figure',
  '',
  '| Chữ | Âm |',
  '| --- | --- |',
  '| あ | a |',
  '| い | i |',
  '',
  'Hãy luyện tập mỗi ngày.',
  '',
].join('\n');

/** A 1×1 PNG. Small, valid, and enough to prove the URL resolves. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A real, short MP3 so the player genuinely decodes and plays.
 *
 * ffmpeg is a hard dependency of apps/worker since P5 and the browser suite
 * already spawns the worker, so it is present wherever this runs.
 */
function generateMp3(seconds: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'ke-e2e-audio-'));
  const file = join(dir, 'tone.mp3');
  try {
    execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
       `sine=frequency=440:duration=${seconds}`, '-codec:a', 'libmp3lame', '-q:a', '9', file],
      { stdio: 'ignore' },
    );
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface SeededLesson {
  readonly id: string;
  readonly audioId: string;
  readonly blockIds: readonly string[];
}

export interface SeededCourse {
  readonly courseId: string;
  readonly courseSlug: string;
  readonly categoryId: string;
  readonly categorySlug: string;
  readonly chapterIds: readonly string[];
  readonly lessons: readonly SeededLesson[];
}

/**
 * §5.7 item 5 wants at least 3 chapters of at least 2 lessons, so the publish
 * checklist passes and the publish job is exercised rather than refused.
 */
export async function seedCourse(options: {
  run: string;
  ownerId: string;
  pricingType: 'free' | 'paid';
  title: string;
  overview: string;
  /**
   * Put the course in an existing category instead of creating one. P8a's
   * scenario needs two paid courses in one category, to sell them singly and as
   * a bundle. Omitted, the behaviour is exactly P7's.
   */
  categoryId?: string;
  /** Defaults to 1 for a paid course and 2 for a free one, as P7 seeded them. */
  levelOrder?: number;
  /** Distinguishes two courses of the same pricing type within one run. */
  slugSuffix?: string;
}): Promise<SeededCourse> {
  const storage = new S3ObjectStorage(s3ConfigFromEnv());
  const audioBytes = generateMp3(6);

  const category = options.categoryId
    ? await prisma.category.findUniqueOrThrow({
        where: { id: options.categoryId },
        select: { id: true, slug: true },
      })
    : await prisma.category.create({
        data: {
          slug: `p7-${options.run}`,
          displayName: `Tiếng Nhật ${options.run}`,
          displayOrder: 0,
        },
        select: { id: true, slug: true },
      });

  const course = await prisma.course.create({
    data: {
      categoryId: category.id,
      slug: `p7-${options.run}-${options.pricingType}${options.slugSuffix ? `-${options.slugSuffix}` : ''}`,
      levelLabel: 'N5',
      levelOrder: options.levelOrder ?? (options.pricingType === 'paid' ? 1 : 2),
      title: options.title,
      overviewSummary: options.overview,
      learningObjectives: ['Đọc được bảng chữ cái', 'Viết đúng thứ tự nét'],
      prerequisites: ['Không yêu cầu kiến thức trước'],
      estimatedTotalMinutes: 60,
      pricingType: options.pricingType,
      coverImageUrl: 'https://cdn.example.test/cover.png',
      languageCode: 'vi',
      publicationStatus: 'draft',
    },
    select: { id: true, slug: true },
  });

  const chapterIds: string[] = [];
  const lessons: SeededLesson[] = [];

  for (let c = 1; c <= 3; c += 1) {
    const chapter = await prisma.chapter.create({
      data: { courseId: course.id, chapterOrder: c, title: `Chương ${c}` },
      select: { id: true },
    });
    chapterIds.push(chapter.id);

    for (let l = 1; l <= 2; l += 1) {
      const lesson = await prisma.lesson.create({
        data: {
          chapterId: chapter.id,
          lessonOrder: l,
          title: `Bài ${c}.${l}`,
          estimatedMinutes: 10,
          contentStatus: 'drafting',
        },
        select: { id: true },
      });

      const parsed = parseLessonMarkdown(BODY, null);
      if (!parsed.ok) throw new Error('seed markdown did not parse');
      const checksum = blockListChecksum(parsed.blockList);
      const blocks = (parsed.blockList as unknown as { blocks: Block[] }).blocks;

      await prisma.lessonContent.create({
        data: {
          lessonId: lesson.id,
          draftContentMarkdown: BODY,
          draftBlockList: parsed.blockList as unknown as object,
          draftContentChecksum: checksum,
          draftUpdatedAt: new Date(),
        },
      });

      for (const figure of blocks.filter((block) => block.blockType === 'figure')) {
        const key = `e2e/${lesson.id}/${figure.blockId}.png`;
        await storage.put(key, PNG_BYTES, 'image/png');
        await prisma.lessonImage.create({
          data: {
            lessonId: lesson.id,
            blockReferenceId: figure.blockId,
            figureNumber: figure.figureNumber ?? 1,
            imageFileUrl: key,
            captionText: 'Thứ tự ba nét viết',
            alternativeText: 'Sơ đồ ba nét được đánh số',
            imageSource: 'ai_generated',
            isSelected: true,
          },
        });
      }

      const segments = blocks.map((block, index) =>
        buildSegment({
          block,
          segmentOrder: index,
          narrationText: `Bản đọc cho khối ${index + 1}.`,
          isEdited: false,
        }),
      );
      const script = scriptChecksum(segments);

      await prisma.narrationScript.create({
        data: {
          lessonId: lesson.id,
          scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
          scriptChecksum: script,
          sourceContentChecksum: checksum,
          scriptStatus: 'ready',
          reviewedByUserId: options.ownerId,
          reviewedAt: new Date(),
        },
      });

      const audioKey = `e2e/${lesson.id}/merged.mp3`;
      await storage.put(audioKey, audioBytes, 'audio/mpeg');
      const audio = await prisma.lessonAudio.create({
        data: {
          lessonId: lesson.id,
          voiceIdentifier: 'alloy',
          voiceProviderName: 'fake',
          mergedAudioFileUrl: audioKey,
          totalDurationSeconds: 6,
          totalCharacterCount: 120,
          sourceScriptChecksum: script,
          audioStatus: 'ready',
        },
        select: { id: true },
      });

      // Even offsets across the 6-second file, so highlight sync has something
      // deterministic to follow.
      const perSegment = Math.floor(6_000 / Math.max(1, segments.length));
      let cursor = 0;
      for (const segment of segments) {
        await prisma.audioSegment.create({
          data: {
            lessonAudioId: audio.id,
            blockReferenceId: segment.blockId,
            segmentOrder: segment.segmentOrder,
            startMillisecond: cursor,
            endMillisecond: cursor + perSegment,
            segmentAudioFileUrl: `e2e/${lesson.id}/seg-${segment.segmentOrder}.mp3`,
            sourceSegmentChecksum: segment.segmentChecksum,
          },
        });
        cursor += perSegment;
      }

      lessons.push({
        id: lesson.id,
        audioId: audio.id,
        blockIds: blocks.map((block) => block.blockId),
      });
    }
  }

  return {
    courseId: course.id,
    courseSlug: course.slug,
    categoryId: category.id,
    categorySlug: category.slug,
    chapterIds,
    lessons,
  };
}

/** Removes everything a seeded course owns. Cascades handle the rest. */
export async function cleanUp(course: SeededCourse, userIds: readonly string[]): Promise<void> {
  await prisma.lessonProgress.deleteMany({ where: { userId: { in: [...userIds] } } });
  await prisma.accessGrant.deleteMany({ where: { userId: { in: [...userIds] } } });
  await prisma.publishedCourseStructure.deleteMany({ where: { courseId: course.courseId } });
  await prisma.course.deleteMany({ where: { id: course.courseId } });
  await prisma.category.deleteMany({ where: { id: course.categoryId } });
  await prisma.session.deleteMany({ where: { userId: { in: [...userIds] } } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
}
