import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { errorCodes } from '@knowledge-explorer/shared';
import { buildSegment, parseLessonMarkdown, scriptChecksum } from '@knowledge-explorer/content';
import { AppModule } from '../src/app.module';
import { NarrationQueue } from '../src/jobs/narration.queue';
import { REDIS_URL } from '../src/jobs/import.queue';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §5.5 narration — the verification table in specs/p4-narration/spec.md.
 *
 * Nothing here runs the worker: these assertions are about what the API refuses,
 * what it writes before enqueueing, and what it computes on read. The run itself
 * is apps/worker/test/narration-processor.spec.ts.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
/** A queue of this suite's own, so enqueued jobs never leak into a shared one. */
const queueName = `narration-e2e-${run}`;
let narrationQueue: NarrationQueue;

let app: INestApplication;
const tokens = { owner: '', adminA: '', adminB: '', learner: '' };
const ids = {
  owner: '',
  adminA: '',
  adminB: '',
  lesson: '',
  figureLesson: '',
  emptyLesson: '',
  assignedLesson: '',
  publishedLesson: '',
};

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });
const api = () => request(app.getHttpServer());

const LESSON_BODY =
  '# Writing systems\n\nJapanese uses three scripts in combination.\n\nHiragana is a syllabary used for grammar.\n';

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-narr-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-narr-${run}-${randomBytes(6).toString('hex')}`;
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
): Promise<string> {
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug: `narration-${run}-${suffix}`,
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
  return lesson.id;
}

/** Saves markdown through the real endpoint, so the stored block list is authoritative. */
async function saveContent(lessonId: string, token: string, markdown: string): Promise<void> {
  const current = await api().get(`/api/admin/lessons/${lessonId}/content`).set(as(token));
  const expectedDraftUpdatedAt = (current.body as { draftUpdatedAt?: string | null }).draftUpdatedAt ?? null;
  await api()
    .put(`/api/admin/lessons/${lessonId}/content`)
    .set(as(token))
    .send({ markdown, expectedDraftUpdatedAt })
    .expect(200);
}

const readScript = (lessonId: string, token: string) =>
  api().get(`/api/admin/lessons/${lessonId}/narration-script`).set(as(token));

const readStaleness = (lessonId: string, token: string) =>
  api().get(`/api/admin/lessons/${lessonId}/staleness`).set(as(token));

const generate = (lessonId: string, token: string) =>
  api().post(`/api/admin/lessons/${lessonId}/narration-script`).set(as(token));

const update = (lessonId: string, token: string, body: object) =>
  api().put(`/api/admin/lessons/${lessonId}/narration-script`).set(as(token)).send(body);

/**
 * Writes a READY script directly, as a successful worker run would. Lets the API
 * assertions run without a worker in the loop.
 */
async function seedReadyScript(lessonId: string): Promise<{ scriptChecksum: string }> {
  const content = await prisma.lessonContent.findUnique({
    where: { lessonId },
    select: { draftBlockList: true, draftContentChecksum: true },
  });
  const blocks = (content?.draftBlockList as unknown as {
    blocks: Parameters<typeof buildSegment>[0]['block'][];
  }).blocks;

  const segments = blocks.map((block, index) =>
    buildSegment({ block, segmentOrder: index, narrationText: `Spoken ${block.blockId}.`, isEdited: false }),
  );
  const checksum = scriptChecksum(segments);

  await prisma.narrationScript.upsert({
    where: { lessonId },
    create: {
      lessonId,
      scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
      scriptChecksum: checksum,
      sourceContentChecksum: content?.draftContentChecksum ?? '',
      scriptStatus: 'ready',
      generatorModelName: 'fake-narrator-v1',
      generatorPromptVersion: 'narration/v1',
    },
    update: {
      scriptSegments: { segments, totalEstimatedSeconds: 30 } as unknown as object,
      scriptChecksum: checksum,
      sourceContentChecksum: content?.draftContentChecksum ?? '',
      scriptStatus: 'ready',
      generatorModelName: 'fake-narrator-v1',
      generatorPromptVersion: 'narration/v1',
      reviewedByUserId: null,
      reviewedAt: null,
    },
  });
  return { scriptChecksum: checksum };
}

beforeAll(async () => {
  narrationQueue = new NarrationQueue(redisUrl, queueName);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(redisUrl)
    .overrideProvider(NarrationQueue)
    .useValue(narrationQueue)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  [ids.owner, tokens.owner] = await seedUser('owner', 'admin_owner');
  [ids.adminA, tokens.adminA] = await seedUser('admin-a', 'admin');
  [ids.adminB, tokens.adminB] = await seedUser('admin-b', 'admin');
  [, tokens.learner] = await seedUser('learner', 'learner');

  const category = await prisma.category.create({
    data: { slug: `narration-${run}`, displayName: 'Narration' },
    select: { id: true },
  });

  ids.lesson = await seedLesson('draft', 'draft', 1, category.id);
  ids.figureLesson = await seedLesson('figure', 'draft', 2, category.id);
  ids.emptyLesson = await seedLesson('empty', 'draft', 3, category.id);
  ids.assignedLesson = await seedLesson('assigned', 'draft', 4, category.id, ids.adminB);
  ids.publishedLesson = await seedLesson('published', 'published', 5, category.id);

  await saveContent(ids.lesson, tokens.owner, LESSON_BODY);
  await saveContent(ids.figureLesson, tokens.owner, '::figure\n\nProse after the figure.\n');
  await saveContent(ids.assignedLesson, tokens.owner, LESSON_BODY);
  await saveContent(ids.publishedLesson, tokens.owner, LESSON_BODY);
}, 60_000);

afterAll(async () => {
  // Obliterate BEFORE closing the app: the overridden NarrationQueue is a
  // provider, so app.close() runs its onModuleDestroy and closes the connection
  // this would otherwise still need.
  await narrationQueue?.queue.obliterate({ force: true });
  await app?.close();
  await prisma.$disconnect();
});

describe('POST — preconditions refuse before anything is spent', () => {
  it('accepts a complete lesson with 202, a script: job id and a generating lock', async () => {
    const response = await generate(ids.lesson, tokens.owner).expect(202);
    expect(response.body.jobId).toMatch(/^script:/u);

    const job = await prisma.generationJob.findUnique({
      where: { id: response.body.generationJobId },
    });
    expect(job?.jobType).toBe('generate_narration_script');
    expect(job?.targetEntityId).toBe(ids.lesson);

    const script = await prisma.narrationScript.findUnique({ where: { lessonId: ids.lesson } });
    expect(script?.scriptStatus).toBe('generating');
  });

  it('refuses a second run while one is in flight, naming the job to attach to', async () => {
    const response = await generate(ids.lesson, tokens.owner).expect(409);
    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_GENERATION_IN_FLIGHT);
    expect(response.body.jobId).toMatch(/^script:/u);

    const jobs = await prisma.generationJob.count({
      where: { jobType: 'generate_narration_script', targetEntityId: ids.lesson },
    });
    expect(jobs).toBe(1);
  });

  it('refuses a lesson with no blocks and enqueues nothing', async () => {
    const before = await narrationQueue.queue.getJobCountByTypes('waiting', 'active', 'delayed');
    const response = await generate(ids.emptyLesson, tokens.owner).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_LESSON_EMPTY);
    expect(await narrationQueue.queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(before);
  });

  it('refuses an uncaptioned figure, naming it, and enqueues nothing', async () => {
    const before = await narrationQueue.queue.getJobCountByTypes('waiting', 'active', 'delayed');
    const response = await generate(ids.figureLesson, tokens.owner).expect(422);

    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_FIGURES_INCOMPLETE);
    expect(response.body.figures).toHaveLength(1);
    expect(response.body.figures[0].figureNumber).toBe(1);
    expect(response.body.figures[0].missing).toContain('selectedImage');
    expect(await narrationQueue.queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(before);

    // And nothing was written: no lock, no job row.
    expect(await prisma.narrationScript.findUnique({ where: { lessonId: ids.figureLesson } })).toBeNull();
  });

  it('refuses a figure whose selected image has an empty caption', async () => {
    const content = await prisma.lessonContent.findUnique({
      where: { lessonId: ids.figureLesson },
      select: { draftBlockList: true },
    });
    const figure = (
      content?.draftBlockList as unknown as { blocks: { blockId: string; blockType: string }[] }
    ).blocks.find((block) => block.blockType === 'figure');

    await prisma.lessonImage.create({
      data: {
        lessonId: ids.figureLesson,
        blockReferenceId: figure!.blockId,
        imageFileUrl: 'k/e/y.png',
        captionText: '',
        alternativeText: 'Alt is present',
        imageSource: 'uploaded',
        isSelected: true,
      },
    });

    const response = await generate(ids.figureLesson, tokens.owner).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_FIGURES_INCOMPLETE);
    expect(response.body.figures[0].missing).toEqual(['captionText']);
  });
});

describe('a failed enqueue must not wedge the lesson', () => {
  it('clears the generating lock and fails the job row', async () => {
    // The enqueue sits OUTSIDE the transaction that writes the job row and the
    // lock, because Redis is not enlisted in a Postgres transaction. Without the
    // compensating catch, a Redis outage would leave script_status = 'generating'
    // and the lesson could never be regenerated from the UI.
    const lessonId = await seedLesson(
      'enqueue-fail',
      'draft',
      20,
      (await prisma.category.findFirst({ where: { slug: `narration-${run}` }, select: { id: true } }))!.id,
    );
    await saveContent(lessonId, tokens.owner, LESSON_BODY);

    const original = narrationQueue.enqueueGenerate.bind(narrationQueue);
    narrationQueue.enqueueGenerate = async () => {
      throw new Error('Connection is closed.');
    };

    try {
      await generate(lessonId, tokens.owner).expect(500);
    } finally {
      narrationQueue.enqueueGenerate = original;
    }

    const script = await prisma.narrationScript.findUnique({ where: { lessonId } });
    expect(script?.scriptStatus).toBe('failed');
    expect(script?.scriptStatus).not.toBe('generating');

    const job = await prisma.generationJob.findFirst({
      where: { jobType: 'generate_narration_script', targetEntityId: lessonId },
      orderBy: { createdAt: 'desc' },
    });
    expect(job?.jobStatus).toBe('failed');
    expect(job?.errorMessage).toContain('could not enqueue');

    // And the lesson can be generated again once Redis is back.
    await generate(lessonId, tokens.owner).expect(202);
  });
});

describe('GET — the review model', () => {
  it('returns rows for every block with null segments before anything is generated', async () => {
    const fresh = await seedLesson(
      'ungenerated',
      'draft',
      9,
      (await prisma.category.findFirst({ where: { slug: `narration-${run}` }, select: { id: true } }))!.id,
    );
    await saveContent(fresh, tokens.owner, LESSON_BODY);

    const response = await readScript(fresh, tokens.owner).expect(200);
    expect(response.body.status).toBeNull();
    expect(response.body.rows).toHaveLength(3);
    expect(response.body.rows.every((row: { narrationText: null }) => row.narrationText === null)).toBe(true);
    expect(response.body.rows.every((row: { freshness: string }) => row.freshness === 'missing')).toBe(true);
  });

  it('reports ready and fresh rows right after a successful run', async () => {
    await seedReadyScript(ids.lesson);
    const response = await readScript(ids.lesson, tokens.owner).expect(200);

    expect(response.body.status).toBe('ready');
    expect(response.body.rows).toHaveLength(3);
    expect(response.body.rows.every((row: { freshness: string }) => row.freshness === 'fresh')).toBe(true);
    expect(response.body.generatorPromptVersion).toBe('narration/v1');
  });

  it('carries the block text the SERVER stored, not a client parse', async () => {
    const response = await readScript(ids.lesson, tokens.owner).expect(200);
    expect(response.body.rows[0].text).toContain('Writing systems');
    expect(response.body.rows[0].blockType).toBe('heading');
  });
});

describe('§6.5 staleness', () => {
  it('reports ready immediately after a run, with all three sets empty', async () => {
    await seedReadyScript(ids.lesson);
    const response = await readStaleness(ids.lesson, tokens.owner).expect(200);

    expect(response.body.script.status).toBe('ready');
    expect(response.body.script.changedBlockIds).toEqual([]);
    expect(response.body.script.missingBlockIds).toEqual([]);
    expect(response.body.script.orphanedSegmentBlockIds).toEqual([]);
  });

  it('has NO audio key until P5 adds one', () => {
    // Asserted explicitly so P5's addition is a deliberate change rather than a
    // field that quietly appears. A key that is always null teaches every client
    // to skip it.
    return readStaleness(ids.lesson, tokens.owner)
      .expect(200)
      .then((response) => {
        expect(Object.keys(response.body)).not.toContain('audio');
        expect(response.body).not.toHaveProperty('audio');
      });
  });

  it('goes stale after a body edit and names exactly the edited block', async () => {
    await seedReadyScript(ids.lesson);
    const before = await readScript(ids.lesson, tokens.owner);
    const editedBlockId = before.body.rows[1].blockId;

    await saveContent(
      ids.lesson,
      tokens.owner,
      '# Writing systems\n\nJapanese uses four scripts in combination.\n\nHiragana is a syllabary used for grammar.\n',
    );

    const response = await readStaleness(ids.lesson, tokens.owner).expect(200);
    expect(response.body.script.status).toBe('stale');
    expect(response.body.script.changedBlockIds).toEqual([editedBlockId]);

    const view = await readScript(ids.lesson, tokens.owner).expect(200);
    const row = view.body.rows.find((item: { blockId: string }) => item.blockId === editedBlockId);
    expect(row.freshness).toBe('changed');
  });

  it('reports failed rather than stale when the row is both', async () => {
    // failed outranks stale: a failed row is not `ready`, and the failure is the
    // more actionable fact.
    await prisma.narrationScript.update({
      where: { lessonId: ids.lesson },
      data: { scriptStatus: 'failed' },
    });
    const response = await readStaleness(ids.lesson, tokens.owner).expect(200);
    expect(response.body.script.status).toBe('failed');
  });

  it('reports script: null for a lesson never generated', async () => {
    const response = await readStaleness(ids.assignedLesson, tokens.owner).expect(200);
    expect(response.body.script).toBeNull();
    expect(response.body.contentChecksum).toBeTruthy();
  });
});

describe('PUT — editing and approval', () => {
  it('refuses a stale scriptChecksum rather than overwriting another admin', async () => {
    await saveContent(ids.lesson, tokens.owner, LESSON_BODY);
    await seedReadyScript(ids.lesson);

    const response = await update(ids.lesson, tokens.owner, {
      scriptChecksum: 'not-the-current-one',
      approve: true,
    }).expect(409);
    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_CONFLICT);
  });

  it('edits a segment, sets isEdited, moves the script checksum, and KEEPS approval', async () => {
    const { scriptChecksum: checksum } = await seedReadyScript(ids.lesson);
    const view = await readScript(ids.lesson, tokens.owner);
    const blockId = view.body.rows[0].blockId;

    await update(ids.lesson, tokens.owner, { scriptChecksum: checksum, approve: true }).expect(200);
    const approvedAt = (await prisma.narrationScript.findUnique({ where: { lessonId: ids.lesson } }))
      ?.reviewedAt;
    expect(approvedAt).not.toBeNull();

    const current = await readScript(ids.lesson, tokens.owner);
    const edited = await update(ids.lesson, tokens.owner, {
      scriptChecksum: current.body.scriptChecksum,
      segments: [{ blockId, narrationText: 'A sentence I wrote myself.' }],
    }).expect(200);

    const row = edited.body.rows.find((item: { blockId: string }) => item.blockId === blockId);
    expect(row.narrationText).toBe('A sentence I wrote myself.');
    expect(row.isEdited).toBe(true);
    expect(edited.body.scriptChecksum).not.toBe(current.body.scriptChecksum);
    // FR-SCRIPT-04 says an edit stales the audio; it does not say approval is lost.
    expect(edited.body.reviewedAt).not.toBeNull();
  });

  it('leaves sourceBlockChecksum alone, so an edit does not fake freshness', async () => {
    const view = await readScript(ids.lesson, tokens.owner);
    expect(view.body.rows.every((row: { freshness: string }) => row.freshness === 'fresh')).toBe(true);
  });

  it('refuses the whole request when one blockId is unknown', async () => {
    const current = await readScript(ids.lesson, tokens.owner);
    const goodId = current.body.rows[1].blockId;

    const response = await update(ids.lesson, tokens.owner, {
      scriptChecksum: current.body.scriptChecksum,
      segments: [
        { blockId: goodId, narrationText: 'This must NOT be written.' },
        { blockId: 'no-such-block', narrationText: 'Nor this.' },
      ],
    }).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_SEGMENT_UNKNOWN);

    const after = await readScript(ids.lesson, tokens.owner);
    const row = after.body.rows.find((item: { blockId: string }) => item.blockId === goodId);
    expect(row.narrationText).not.toBe('This must NOT be written.');
    expect(after.body.scriptChecksum).toBe(current.body.scriptChecksum);
  });

  it('refuses approval of a stale script', async () => {
    await seedReadyScript(ids.lesson);
    await saveContent(ids.lesson, tokens.owner, LESSON_BODY + '\nAn appended paragraph of prose.\n');

    const current = await readScript(ids.lesson, tokens.owner);
    expect(current.body.status).toBe('stale');

    const response = await update(ids.lesson, tokens.owner, {
      scriptChecksum: current.body.scriptChecksum,
      approve: true,
    }).expect(422);
    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_NOT_APPROVABLE);
  });

  it('returns 404 for a lesson with no script row', async () => {
    const response = await update(ids.assignedLesson, tokens.owner, {
      scriptChecksum: 'anything',
      approve: true,
    }).expect(404);
    expect(response.body.errorCode).toBe(errorCodes.SCRIPT_NOT_FOUND);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    await update(ids.lesson, tokens.owner, { scriptChecksum: 'x', nonsense: 1 }).expect(400);
  });

  it('rejects a body that changes nothing', async () => {
    await update(ids.lesson, tokens.owner, { scriptChecksum: 'x' }).expect(400);
  });
});

describe('§3 and the rule guards', () => {
  it('refuses a learner on all three endpoints', async () => {
    await readScript(ids.lesson, tokens.learner).expect(403);
    await generate(ids.lesson, tokens.learner).expect(403);
    await update(ids.lesson, tokens.learner, { scriptChecksum: 'x', approve: true }).expect(403);
  });

  it('lets an admin READ a lesson assigned to someone else, and refuses both writes', async () => {
    // The tab renders read-only and explains itself; the writes refuse independently.
    await readScript(ids.assignedLesson, tokens.adminA).expect(200);

    const generated = await generate(ids.assignedLesson, tokens.adminA).expect(403);
    expect(generated.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);

    const updated = await update(ids.assignedLesson, tokens.adminA, {
      scriptChecksum: 'x',
      approve: true,
    }).expect(403);
    expect(updated.body.errorCode).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
  });

  it('reports canEdit false with the reason on a read-only lesson', async () => {
    const response = await readScript(ids.assignedLesson, tokens.adminA).expect(200);
    expect(response.body.canEdit).toBe(false);
    expect(response.body.readOnlyReason).toBe(errorCodes.FORBIDDEN_NOT_ASSIGNED);
  });

  it('refuses an admin in a published course (R-01) and allows the owner', async () => {
    const refused = await generate(ids.publishedLesson, tokens.adminA).expect(403);
    expect(refused.body.errorCode).toBe(errorCodes.FORBIDDEN_COURSE_PUBLISHED);

    await generate(ids.publishedLesson, tokens.owner).expect(202);
  });
});
