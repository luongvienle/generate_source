import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { errorCodes, AUDIO_RUN_MAX_SEGMENTS } from '@knowledge-explorer/shared';
import { buildSegment, scriptChecksum, segmentChecksum, type Block } from '@knowledge-explorer/content';
import { AppModule } from '../src/app.module';
import { AudioQueue } from '../src/jobs/audio.queue';
import { REDIS_URL } from '../src/jobs/import.queue';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §5.6 audio — the API half of specs/p5-audio/spec.md's verification.
 *
 * Nothing here runs the worker. These assertions are about what the API REFUSES
 * before any money is spent, what it writes before enqueueing, and what it
 * computes on read. The run itself is apps/worker/test/audio-processor.spec.ts.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
/** A queue of this suite's own, so enqueued jobs never leak into a shared one. */
const queueName = `audio-e2e-${run}`;
let audioQueue: AudioQueue;

let app: INestApplication;
const tokens = { owner: '', adminA: '', adminB: '', learner: '' };
const ids = {
  owner: '',
  adminA: '',
  adminB: '',
  course: '',
  lesson: '',
  noScriptLesson: '',
  unapprovedLesson: '',
  staleLesson: '',
  assignedLesson: '',
  publishedLesson: '',
  longLesson: '',
};

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });
const api = () => request(app.getHttpServer());

const LESSON_BODY =
  '# Writing systems\n\nJapanese uses three scripts in combination.\n\nHiragana is a syllabary used for grammar.\n';

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-audio-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-audio-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

async function seedLesson(
  suffix: string,
  publicationStatus: string,
  levelOrder: number,
  categoryId: string,
  assignedAdminId?: string,
): Promise<{ lessonId: string; courseId: string }> {
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `audio-${run}-${suffix}`,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Course ${suffix}`,
      publicationStatus,
      languageCode: 'vi',
    },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chapter one' },
    select: { id: true },
  });
  const lesson = await prisma.lesson.create({
    data: {
      chapterId: chapter.id,
      lessonOrder: 1,
      title: `Lesson ${suffix}`,
      learningObjective: 'Tell the scripts apart',
      ...(assignedAdminId ? { assignedAdminId } : {}),
    },
    select: { id: true },
  });
  return { lessonId: lesson.id, courseId: course.id };
}

/** Saves markdown through the real endpoint, so the stored block list is authoritative. */
async function saveContent(lessonId: string, token: string, markdown: string): Promise<void> {
  const current = await api().get(`/api/admin/lessons/${lessonId}/content`).set(as(token));
  const expectedDraftUpdatedAt =
    (current.body as { draftUpdatedAt?: string | null }).draftUpdatedAt ?? null;
  await api()
    .put(`/api/admin/lessons/${lessonId}/content`)
    .set(as(token))
    .send({ markdown, expectedDraftUpdatedAt })
    .expect(200);
}

/**
 * Writes a script directly, as a successful narration run would, optionally
 * approved. Lets the audio assertions run without a narration worker in the loop.
 */
async function seedScript(
  lessonId: string,
  options: { approved: boolean; reviewerId?: string; texts?: (blockId: string) => string },
): Promise<{ scriptChecksum: string }> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true, draftContentChecksum: true },
  });
  const blocks = (content?.draftBlockList as unknown as { blocks: Block[] }).blocks;

  const segments = blocks.map((block, index) =>
    buildSegment({
      block,
      segmentOrder: index,
      narrationText: options.texts ? options.texts(block.blockId) : `Spoken ${block.blockId}.`,
      isEdited: false,
    }),
  );
  const checksum = scriptChecksum(segments);

  const payload = {
    scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
    scriptChecksum: checksum,
    sourceContentChecksum: content?.draftContentChecksum ?? '',
    scriptStatus: 'ready',
    generatorModelName: 'fake-narrator-v1',
    generatorPromptVersion: 'narration/v1',
    reviewedByUserId: options.approved ? (options.reviewerId ?? ids.owner) : null,
    reviewedAt: options.approved ? new Date() : null,
  };

  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: { lessonId, ...payload },
    update: payload,
  });
  return { scriptChecksum: checksum };
}

/** Writes a READY lesson_audios row with its segments, as a successful run would. */
async function seedReadyAudio(
  lessonId: string,
  voiceIdentifier = 'alloy',
): Promise<{ audioId: string }> {
  const script = await prisma.narrationScript.findUnique({
    where: { lessonId },
    select: { scriptSegments: true, scriptChecksum: true },
  });
  const segments = (script?.scriptSegments as unknown as {
    segments: { blockId: string; segmentOrder: number; segmentChecksum: string }[];
  }).segments;

  const audio = await prisma.lessonAudio.create({
    data: {
      lessonId,
      voiceIdentifier,
      voiceProviderName: 'fake',
      mergedAudioFileUrl: `lessons/${lessonId}/audio/merged/seeded.mp3`,
      totalDurationSeconds: 12,
      totalCharacterCount: 120,
      sourceScriptChecksum: script?.scriptChecksum ?? '',
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
        endMillisecond: cursor + 1_000,
        segmentAudioFileUrl: `lessons/${lessonId}/audio/segments/${segment.blockId}.mp3`,
        sourceSegmentChecksum: segment.segmentChecksum,
      },
    });
    cursor += 1_000;
  }
  return { audioId: audio.id };
}

const readAudio = (lessonId: string, token: string) =>
  api().get(`/api/admin/lessons/${lessonId}/audio`).set(as(token));

const generate = (lessonId: string, token: string) =>
  api().post(`/api/admin/lessons/${lessonId}/audio`).set(as(token));

const readStaleness = (lessonId: string, token: string) =>
  api().get(`/api/admin/lessons/${lessonId}/staleness`).set(as(token));

const setVoice = (courseId: string, token: string, body: object) =>
  api().patch(`/api/admin/courses/${courseId}/voice`).set(as(token)).send(body);

beforeAll(async () => {
  audioQueue = new AudioQueue(redisUrl, queueName);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(redisUrl)
    .overrideProvider(AudioQueue)
    .useValue(audioQueue)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  [ids.owner, tokens.owner] = await seedUser('owner', 'admin_owner');
  [ids.adminA, tokens.adminA] = await seedUser('admin-a', 'admin');
  [ids.adminB, tokens.adminB] = await seedUser('admin-b', 'admin');
  [, tokens.learner] = await seedUser('learner', 'learner');

  const category = await prisma.category.create({
    data: { slug: `audio-${run}`, displayName: 'Audio' },
    select: { id: true },
  });

  ({ lessonId: ids.lesson, courseId: ids.course } = await seedLesson('ready', 'draft', 1, category.id));
  ({ lessonId: ids.noScriptLesson } = await seedLesson('noscript', 'draft', 2, category.id));
  ({ lessonId: ids.unapprovedLesson } = await seedLesson('unapproved', 'draft', 3, category.id));
  ({ lessonId: ids.staleLesson } = await seedLesson('stale', 'draft', 4, category.id));
  ({ lessonId: ids.assignedLesson } = await seedLesson('assigned', 'draft', 5, category.id, ids.adminB));
  ({ lessonId: ids.publishedLesson } = await seedLesson('published', 'published', 6, category.id));
  ({ lessonId: ids.longLesson } = await seedLesson('long', 'draft', 7, category.id));

  for (const lessonId of [
    ids.lesson,
    ids.noScriptLesson,
    ids.unapprovedLesson,
    ids.staleLesson,
    ids.assignedLesson,
    ids.publishedLesson,
    ids.longLesson,
  ]) {
    await saveContent(lessonId, tokens.owner, LESSON_BODY);
  }

  await seedScript(ids.lesson, { approved: true });
  await seedScript(ids.unapprovedLesson, { approved: false });
  await seedScript(ids.assignedLesson, { approved: true });
  await seedScript(ids.publishedLesson, { approved: true });
}, 90_000);

afterAll(async () => {
  // Obliterate BEFORE closing the app: the overridden AudioQueue is a provider,
  // so app.close() runs its onModuleDestroy and closes the connection this would
  // otherwise still need.
  //
  // Fixture rows are left in place, as the narration and images suites leave
  // theirs: every id here is suffixed with a per-run token, and deleting users
  // would trip lesson_contents.last_edited_by_user_id, which is NoAction by §8.
  await audioQueue?.queue.obliterate({ force: true });
  await app?.close();
  await prisma.$disconnect();
});

describe('preconditions: nothing is spent on a lesson that cannot produce publishable audio', () => {
  it('404s when the lesson has no narration script at all', async () => {
    const response = await generate(ids.noScriptLesson, tokens.owner).expect(404);
    expect(response.body.errorCode).toBe(errorCodes.AUDIO_SCRIPT_NOT_FOUND);
  });

  /** §5.5 names approval as the enforcement point for FR-SCRIPT-02. */
  it('422s when the script has never been approved', async () => {
    const response = await generate(ids.unapprovedLesson, tokens.owner).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.AUDIO_SCRIPT_NOT_APPROVED);
  });

  it('422s when the content moved on after approval, so the script reads stale', async () => {
    await seedScript(ids.staleLesson, { approved: true });
    // The content changes; the script's source_content_checksum no longer matches.
    await saveContent(ids.staleLesson, tokens.owner, `${LESSON_BODY}\nA new paragraph.\n`);

    const response = await generate(ids.staleLesson, tokens.owner).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.AUDIO_SCRIPT_STALE);
  });

  it('422s a segment longer than the provider accepts, naming the block', async () => {
    await seedScript(ids.longLesson, {
      approved: true,
      texts: (blockId) => (blockId.endsWith('1') ? 'x'.repeat(5_000) : `Spoken ${blockId}.`),
    });

    const response = await generate(ids.longLesson, tokens.owner).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.AUDIO_SEGMENT_TOO_LONG);
    expect(response.body.blockId).toBeTruthy();
    expect(response.body.maximum).toBe(4_096);
  });

  it('names AUDIO_RUN_MAX_SEGMENTS as a real ceiling rather than an unbounded run', () => {
    expect(AUDIO_RUN_MAX_SEGMENTS).toBeGreaterThan(0);
  });

  it('enqueues a job and takes the in-flight lock when everything passes', async () => {
    const response = await generate(ids.lesson, tokens.owner).expect(202);

    expect(response.body.jobId).toMatch(/^audio:\d+$/);
    expect(response.body.generationJobId).toBeTruthy();

    const row = await prisma.lessonAudio.findFirst({
      where: { lessonId: ids.lesson },
      select: { audioStatus: true, voiceIdentifier: true, mergedAudioFileUrl: true },
    });
    expect(row?.audioStatus).toBe('generating');
    // §8 makes the URL NOT NULL and no run has produced one; '' is the unwritten
    // state, and only ever coexists with a non-ready status.
    expect(row?.mergedAudioFileUrl).toBe('');
    expect(row?.voiceIdentifier).toBeTruthy();
  });

  it('409s a second run while one is in flight, carrying the running jobId', async () => {
    const response = await generate(ids.lesson, tokens.owner).expect(409);
    expect(response.body.errorCode).toBe(errorCodes.AUDIO_GENERATION_IN_FLIGHT);
    expect(response.body.jobId).toMatch(/^audio:\d+$/);
  });
});

describe('§3 and the rule guards', () => {
  it('refuses a learner on both endpoints', async () => {
    await readAudio(ids.lesson, tokens.learner).expect(403);
    await generate(ids.lesson, tokens.learner).expect(403);
  });

  it('refuses a non-owner admin writing a published course (R-01) but allows the read', async () => {
    await readAudio(ids.publishedLesson, tokens.adminA).expect(200);

    const response = await generate(ids.publishedLesson, tokens.adminA).expect(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);
  });

  it('refuses an admin the lesson of another admin (R-02) but allows the read', async () => {
    await readAudio(ids.assignedLesson, tokens.adminA).expect(200);

    const response = await generate(ids.assignedLesson, tokens.adminA).expect(403);
    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
  });

  it('reports canEdit false with the reason on a read-only lesson', async () => {
    const response = await readAudio(ids.assignedLesson, tokens.adminA).expect(200);
    expect(response.body.canEdit).toBe(false);
    expect(response.body.readOnlyReason).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
  });
});

describe('FR-AUDIO-03 voice configuration', () => {
  it('is owner-only: an admin is refused', async () => {
    await setVoice(ids.course, tokens.adminA, { voiceIdentifier: 'nova' }).expect(403);
    await setVoice(ids.course, tokens.learner, { voiceIdentifier: 'nova' }).expect(403);
  });

  it('lets the owner set a voice the provider recognises', async () => {
    const response = await setVoice(ids.course, tokens.owner, { voiceIdentifier: 'nova' }).expect(200);
    expect(response.body.voiceIdentifier).toBe('nova');
  });

  it('422s a voice the provider does not recognise, before any lesson is synthesized', async () => {
    const response = await setVoice(ids.course, tokens.owner, {
      voiceIdentifier: 'not-a-voice',
    }).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.AUDIO_VOICE_NOT_CONFIGURED);
  });

  it('falls back to the install default when the course has configured none', async () => {
    await setVoice(ids.course, tokens.owner, { voiceIdentifier: null }).expect(200);

    const response = await readAudio(ids.lesson, tokens.owner).expect(200);
    expect(response.body.configuredVoiceIdentifier).toBeTruthy();
  });
});

describe('§6.5 the script → audio link', () => {
  it('reports audio null before any run, rather than a synthesized pending', async () => {
    const response = await readStaleness(ids.unapprovedLesson, tokens.owner).expect(200);
    expect(response.body.audio).toBeNull();
  });

  it('still reports the P4 script key unchanged', async () => {
    const response = await readStaleness(ids.lesson, tokens.owner).expect(200);
    expect(response.body.script).not.toBeNull();
    expect(response.body.script.status).toBeTruthy();
  });

  it('reports ready for audio that matches its script', async () => {
    await prisma.lessonAudio.deleteMany({ where: { lessonId: ids.assignedLesson } });
    await seedReadyAudio(ids.assignedLesson);

    const response = await readStaleness(ids.assignedLesson, tokens.owner).expect(200);
    expect(response.body.audio.status).toBe('ready');
    expect(response.body.audio.staleSegmentBlockIds).toEqual([]);
    expect(response.body.audio.voiceChanged).toBe(false);
  });

  it('goes stale when a narration segment is edited, naming the affected block', async () => {
    const script = await prisma.narrationScript.findUnique({
      where: { lessonId: ids.assignedLesson },
      select: { scriptSegments: true },
    });
    const envelope = script?.scriptSegments as unknown as {
      segments: { blockId: string; narrationText: string; segmentChecksum: string }[];
      totalEstimatedSeconds: number;
    };

    const edited = envelope.segments.map((segment, index) =>
      index === 0
        ? {
            ...segment,
            narrationText: 'Completely rewritten.',
            segmentChecksum: segmentChecksum('Completely rewritten.'),
          }
        : segment,
    );

    await prisma.narrationScript.update({
      where: { lessonId: ids.assignedLesson },
      data: {
        scriptSegments: { ...envelope, segments: edited } as unknown as object,
        scriptChecksum: scriptChecksum(edited as never),
      },
    });

    const response = await readStaleness(ids.assignedLesson, tokens.owner).expect(200);
    expect(response.body.audio.status).toBe('stale');
    expect(response.body.audio.staleSegmentBlockIds).toEqual([edited[0]!.blockId]);
    // Exactly one segment moved; the rest are still fresh.
    expect(response.body.audio.staleSegmentBlockIds).toHaveLength(1);
  });

  /**
   * FR-AUDIO-03 stores the voice on the row "so a voice change is detectable".
   * Detection with no consequence would be a column nobody reads.
   */
  it('goes stale when the COURSE VOICE changes, with the script untouched', async () => {
    const fresh = await seedLesson('voice', 'draft', 8, (
      await prisma.category.findFirst({ where: { slug: `audio-${run}` }, select: { id: true } })
    )!.id);
    await saveContent(fresh.lessonId, tokens.owner, LESSON_BODY);
    await seedScript(fresh.lessonId, { approved: true });
    await seedReadyAudio(fresh.lessonId, 'alloy');

    const before = await readStaleness(fresh.lessonId, tokens.owner).expect(200);
    expect(before.body.audio.status).toBe('ready');

    await setVoice(fresh.courseId, tokens.owner, { voiceIdentifier: 'nova' }).expect(200);

    const after = await readStaleness(fresh.lessonId, tokens.owner).expect(200);
    expect(after.body.audio.status).toBe('stale');
    expect(after.body.audio.voiceChanged).toBe(true);
    expect(after.body.audio.voiceIdentifier).toBe('alloy');
    expect(after.body.audio.configuredVoiceIdentifier).toBe('nova');
  });
});

describe('the read model', () => {
  it('presigns the merged URL and never returns the stored key', async () => {
    const response = await readAudio(ids.assignedLesson, tokens.owner).expect(200);

    expect(response.body.mergedAudioUrl).toBeTruthy();
    expect(response.body.mergedAudioUrl).toMatch(/^https?:\/\//);
    // The stored column is a key, not a URL; returning it raw would 404 a player.
    expect(response.body.mergedAudioUrl).not.toBe(`lessons/${ids.assignedLesson}/audio/merged/seeded.mp3`);
  });

  it('returns no URL for a row that has never completed a run', async () => {
    const response = await readAudio(ids.lesson, tokens.owner).expect(200);
    expect(response.body.mergedAudioUrl).toBeNull();
  });

  it('explains why Generate is blocked, using the code the write would give', async () => {
    const unapproved = await readAudio(ids.unapprovedLesson, tokens.owner).expect(200);
    expect(unapproved.body.blockedReason).toBe(errorCodes.AUDIO_SCRIPT_NOT_APPROVED);

    const noScript = await readAudio(ids.noScriptLesson, tokens.owner).expect(200);
    expect(noScript.body.blockedReason).toBe(errorCodes.AUDIO_SCRIPT_NOT_FOUND);
  });

  it('lists one row per narration segment, in order, with per-row freshness', async () => {
    const response = await readAudio(ids.assignedLesson, tokens.owner).expect(200);

    expect(response.body.rows.length).toBeGreaterThan(0);
    const orders = response.body.rows.map((row: { segmentOrder: number }) => row.segmentOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));

    const freshnesses = new Set(
      response.body.rows.map((row: { freshness: string }) => row.freshness),
    );
    // One segment was rewritten above; the others still match their audio.
    expect(freshnesses.has('stale')).toBe(true);
    expect(freshnesses.has('fresh')).toBe(true);
  });
});
