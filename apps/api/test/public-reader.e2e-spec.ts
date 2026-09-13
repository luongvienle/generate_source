import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import {
  blockListChecksum,
  buildSegment,
  parseLessonMarkdown,
  scriptChecksum,
  type Block,
} from '@knowledge-explorer/content';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * `GET /lessons/:lessonId` — the published track, the presigned figures, and
 * the §6.5 audio gate.
 *
 * The gate is the subject most of this file is about. §8 gives
 * `narration_scripts` and `lesson_audios` no published copy, so after a publish
 * an admin's narration edit reaches learners immediately and a body edit leaves
 * the live segments pointing at blockIds the published list does not contain.
 * P7's answer is to serve audio only when the checksum chain resolves to the
 * PUBLISHED text, and the cases below walk that chain breaking and healing.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const api = () => request(app.getHttpServer());

const BODY = '# Thứ tự nét viết\n\nNét đầu tiên chạy từ trái sang phải.\n\n::figure\n';
const EDITED_BODY = '# Thứ tự nét viết\n\nNét đầu tiên chạy từ phải sang trái.\n\n::figure\n';

let app: INestApplication;
let ownerId = '';
let categoryId = '';
let courseId = '';
let chapterId = '';
let lessonId = '';
let secondLessonId = '';
let mediaId = '';
let publishedChecksum = '';

/** Writes both tracks, a fresh script and ready audio, all in step. */
async function seedLesson(order: number, title: string): Promise<{ id: string; audioId: string }> {
  const lesson = await prisma.lesson.create({
    data: {
      chapterId,
      lessonOrder: order,
      title,
      estimatedMinutes: 10,
      isFreePreview: true,
      contentStatus: 'published',
    },
    select: { id: true },
  });

  const parsed = parseLessonMarkdown(BODY, null);
  if (!parsed.ok) throw new Error('seed markdown did not parse');
  const checksum = blockListChecksum(parsed.blockList);
  publishedChecksum = checksum;

  await prisma.lessonContent.create({
    data: {
      lessonId: lesson.id,
      draftContentMarkdown: BODY,
      draftBlockList: parsed.blockList as unknown as object,
      draftContentChecksum: checksum,
      publishedContentMarkdown: BODY,
      publishedBlockList: parsed.blockList as unknown as object,
      publishedAt: new Date(),
      draftUpdatedAt: new Date(),
    },
  });

  const blocks = (parsed.blockList as unknown as { blocks: Block[] }).blocks;

  for (const figure of blocks.filter((block) => block.blockType === 'figure')) {
    await prisma.lessonImage.create({
      data: {
        lessonId: lesson.id,
        blockReferenceId: figure.blockId,
        figureNumber: figure.figureNumber ?? 1,
        imageFileUrl: `lessons/${lesson.id}/images/${figure.blockId}.png`,
        captionText: 'Thứ tự ba nét viết',
        alternativeText: 'Sơ đồ ba nét được đánh số',
        imageSource: 'ai_generated',
        isSelected: true,
      },
    });
    // An UNSELECTED candidate for the same block: it must never be served.
    await prisma.lessonImage.create({
      data: {
        lessonId: lesson.id,
        blockReferenceId: figure.blockId,
        figureNumber: figure.figureNumber ?? 1,
        imageFileUrl: `lessons/${lesson.id}/images/${figure.blockId}-rejected.png`,
        captionText: 'Ảnh bị loại',
        alternativeText: 'Không được chọn',
        imageSource: 'ai_generated',
        isSelected: false,
      },
    });
  }

  const segments = blocks.map((block, index) =>
    buildSegment({
      block,
      segmentOrder: index,
      narrationText: `Bản đọc cho khối ${block.blockId}.`,
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
      reviewedAt: new Date(),
    },
  });

  const audio = await prisma.lessonAudio.create({
    data: {
      lessonId: lesson.id,
      voiceIdentifier: 'alloy',
      voiceProviderName: 'fake',
      mergedAudioFileUrl: `lessons/${lesson.id}/audio/merged.mp3`,
      totalDurationSeconds: 12,
      sourceScriptChecksum: script,
      audioStatus: 'ready',
    },
    select: { id: true },
  });

  let cursor = 0;
  for (const segment of segments) {
    await prisma.audioSegment.create({
      data: {
        lessonAudioId: audio.id,
        blockReferenceId: segment.blockId,
        segmentOrder: segment.segmentOrder,
        startMillisecond: cursor,
        endMillisecond: cursor + 2_000,
        sourceSegmentChecksum: segment.segmentChecksum,
      },
    });
    cursor += 2_000;
  }

  return { id: lesson.id, audioId: audio.id };
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `owner-read-${run}@example.test`, userRole: 'admin_owner' },
    select: { id: true },
  });
  ownerId = owner.id;

  const category = await prisma.category.create({
    data: { slug: `read-${run}`, displayName: 'Đọc' },
    select: { id: true },
  });
  categoryId = category.id;

  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `read-${run}-course`,
      levelLabel: 'N5',
      levelOrder: 1,
      title: 'Khoá đọc',
      pricingType: 'free',
      publicationStatus: 'published',
      publishedAt: new Date(),
    },
    select: { id: true },
  });
  courseId = course.id;

  const chapter = await prisma.chapter.create({
    data: { courseId, chapterOrder: 1, title: 'Chương 1' },
    select: { id: true },
  });
  chapterId = chapter.id;

  const first = await seedLesson(1, 'Bài 1');
  const second = await seedLesson(2, 'Bài 2');
  lessonId = first.id;
  mediaId = first.audioId;
  secondLessonId = second.id;

  await prisma.publishedCourseStructure.create({
    data: {
      courseId,
      publishedVersionNumber: 1,
      totalLessonCount: 2,
      publishedByUserId: ownerId,
      structurePayload: {
        courseId,
        publishedVersionNumber: 1,
        totalLessonCount: 2,
        chapters: [
          {
            chapterId,
            order: 1,
            title: 'Chương 1',
            description: null,
            lessons: [
              {
                lessonId,
                order: 1,
                title: 'Bài 1',
                estimatedMinutes: 10,
                isFreePreview: true,
                hasAudio: true,
                audioDurationSeconds: 12,
                figureCount: 1,
              },
              {
                lessonId: secondLessonId,
                order: 2,
                title: 'Bài 2',
                estimatedMinutes: 10,
                isFreePreview: true,
                hasAudio: true,
                audioDurationSeconds: 12,
                figureCount: 1,
              },
            ],
          },
        ],
      } as object,
    },
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await prisma.publishedCourseStructure.deleteMany({ where: { courseId } });
  await prisma.course.deleteMany({ where: { id: courseId } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.user.delete({ where: { id: ownerId } });
});

const read = async (id = lessonId) => (await api().get(`/api/lessons/${id}`).expect(200)).body as {
  blocks: Block[];
  figureImages: Record<string, { url: string; captionText: string; alternativeText: string }>;
  audio: { mediaId: string; segments: { blockId: string; startMillisecond: number }[] } | null;
  previous: { lessonId: string } | null;
  next: { lessonId: string } | null;
  courseSlug: string;
};

describe('the published track', () => {
  it('serves the published block list and no draft column', async () => {
    const body = await read();
    expect(body.blocks.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('draftContentMarkdown');
    expect(raw).not.toContain('draftBlockList');
    // The body travels as blocks; shipping the markdown too would be a second
    // copy of the same content that could disagree with it.
    expect(raw).not.toContain('publishedContentMarkdown');
  });

  it('presigns only the selected image for each figure block', async () => {
    const body = await read();
    const images = Object.values(body.figureImages);
    expect(images).toHaveLength(1);
    expect(images[0]?.captionText).toBe('Thứ tự ba nét viết');
    // The rejected candidate must not appear anywhere.
    expect(JSON.stringify(body.figureImages)).not.toContain('rejected');
  });

  it('signs figure URLs against S3_PUBLIC_ENDPOINT', async () => {
    // CLAUDE.md invariant 5: a URL signed against the internal endpoint fails in
    // a browser with an opaque SignatureDoesNotMatch and no other symptom. P7 is
    // the first phase where every presigned URL is learner-facing.
    const body = await read();
    const url = Object.values(body.figureImages)[0]?.url ?? '';
    const publicEndpoint = process.env['S3_PUBLIC_ENDPOINT'] ?? 'http://localhost:9010';
    expect(url.startsWith(publicEndpoint)).toBe(true);
    expect(url).toContain('X-Amz-Signature');
  });

  it('navigates previous and next from the snapshot', async () => {
    const first = await read(lessonId);
    expect(first.previous).toBeNull();
    expect(first.next?.lessonId).toBe(secondLessonId);

    const second = await read(secondLessonId);
    expect(second.previous?.lessonId).toBe(lessonId);
    expect(second.next).toBeNull();
  });
});

describe('§6.5: the audio gate resolves against the PUBLISHED text', () => {
  it('serves audio and per-block timings while the chain holds', async () => {
    const body = await read();
    expect(body.audio).not.toBeNull();
    expect(body.audio?.mediaId).toBe(mediaId);
    expect(body.audio?.segments.length).toBeGreaterThan(0);
    // Every timing names a block that is actually in the published list, which
    // is what highlight sync binds to.
    const publishedIds = new Set(body.blocks.map((block) => block.blockId));
    for (const segment of body.audio?.segments ?? []) {
      expect(publishedIds.has(segment.blockId)).toBe(true);
    }
  });

  it('withholds audio after a draft-only body edit, and still serves the lesson', async () => {
    // The admin edits the body but does not publish. The learner must keep
    // reading the PUBLISHED words — and must not hear narration written for
    // words they are not reading.
    const edited = parseLessonMarkdown(EDITED_BODY, null);
    if (!edited.ok) throw new Error('edit did not parse');
    await prisma.lessonContent.update({
      where: { lessonId },
      data: {
        draftContentMarkdown: EDITED_BODY,
        draftBlockList: edited.blockList as unknown as object,
        draftContentChecksum: blockListChecksum(edited.blockList),
      },
    });

    const body = await read();
    // Published text is unchanged: §4.3 holding.
    expect(JSON.stringify(body.blocks)).toContain('trái sang phải');
    // ...and the script still matches it, so audio SURVIVES a draft-only edit.
    expect(body.audio).not.toBeNull();
  });

  it('withholds audio once the script no longer matches the published text', async () => {
    // This is the case that matters: the admin regenerated narration against
    // the edited draft. The script now voices words the learner is not reading.
    const edited = parseLessonMarkdown(EDITED_BODY, null);
    if (!edited.ok) throw new Error('edit did not parse');
    await prisma.narrationScript.update({
      where: { lessonId },
      data: { sourceContentChecksum: blockListChecksum(edited.blockList) },
    });

    const body = await read();
    expect(body.audio).toBeNull();
    // The lesson still reads. Losing the player is not losing the lesson.
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  it('restores audio when the script is regenerated against the published text', async () => {
    await prisma.narrationScript.update({
      where: { lessonId },
      data: { sourceContentChecksum: publishedChecksum },
    });
    expect((await read()).audio).not.toBeNull();
  });

  it('withholds audio when the audio no longer matches its script', async () => {
    // §6.5's second link: the admin edited a narration segment, so
    // script_checksum moved and the merged file is stale against it.
    await prisma.lessonAudio.update({
      where: { id: mediaId },
      data: { sourceScriptChecksum: 'stale-checksum-that-matches-nothing' },
    });

    expect((await read()).audio).toBeNull();
  });

  it('withholds audio that is not ready', async () => {
    const script = await prisma.narrationScript.findUniqueOrThrow({
      where: { lessonId },
      select: { scriptChecksum: true },
    });
    await prisma.lessonAudio.update({
      where: { id: mediaId },
      data: { sourceScriptChecksum: script.scriptChecksum, audioStatus: 'failed' },
    });
    expect((await read()).audio).toBeNull();

    await prisma.lessonAudio.update({ where: { id: mediaId }, data: { audioStatus: 'ready' } });
    expect((await read()).audio).not.toBeNull();
  });
});

describe('§4.3: an unpublished course stops serving its lessons', () => {
  it('404s every lesson once the course leaves the published track', async () => {
    await prisma.course.update({
      where: { id: courseId },
      data: { publicationStatus: 'unpublished' },
    });

    const response = await api().get(`/api/lessons/${lessonId}`).expect(404);
    expect((response.body as { errorCode: string }).errorCode).toBe('COURSE_NOT_PUBLISHED');

    await prisma.course.update({
      where: { id: courseId },
      data: { publicationStatus: 'published' },
    });
    await api().get(`/api/lessons/${lessonId}`).expect(200);
  });
});
