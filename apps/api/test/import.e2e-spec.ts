import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { SCHEMA_VERSION } from '@knowledge-explorer/content';
import { errorCodes } from '@knowledge-explorer/shared';
import { AppModule } from '../src/app.module';
import { ImportQueue, REDIS_URL } from '../src/jobs/import.queue';
import { startWorker, type RunningWorker } from './helpers/worker-process';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §5.2 curriculum import, end to end: HTTP into apps/api, a real apps/worker
 * child process, real Redis and real PostgreSQL.
 *
 * The central assertion of this file is that a dry run writes NOTHING — asserted
 * by comparing row counts across every curriculum table and generation_jobs,
 * not by inspecting the code path.
 */

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const run = randomBytes(4).toString('hex');
const queueName = `curriculum-import-e2e-${run}`;
const prisma = getPrismaClient();

let app: INestApplication;
let importQueue: ImportQueue;
let worker: RunningWorker;
const tokens = { owner: '', admin: '', learner: '' };
const userIds: string[] = [];

const as = (token: string) => ({ Cookie: `authjs.session-token=${token}` });

const categorySlug = `japanese-${run}`;

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    category: { slug: categorySlug, displayName: 'Japanese' },
    course: {
      levelLabel: 'N5',
      levelOrder: 1,
      title: 'Japanese N5',
      overviewSummary: 'A first course.',
      prerequisites: ['None'],
      learningObjectives: ['Read hiragana'],
      estimatedTotalMinutes: 1200,
      languageCode: 'vi',
    },
    chapters: [
      {
        chapterOrder: 1,
        title: 'Hiragana',
        description: 'The first syllabary.',
        lessons: [
          { lessonOrder: 1, title: 'The A-row', keyPoints: ['a i u e o'], estimatedMinutes: 15 },
          { lessonOrder: 2, title: 'The KA-row', keyPoints: ['ka ki ku ke ko'] },
        ],
      },
      {
        chapterOrder: 2,
        title: 'Katakana',
        lessons: [{ lessonOrder: 1, title: 'Foreign words' }],
      },
    ],
    ...over,
  };
}

async function seedUser(local: string, userRole: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `${local}-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  userIds.push(user.id);
  const sessionToken = `tok-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return sessionToken;
}

/**
 * Every table a curriculum import could touch, scoped to this run's own category.
 *
 * Scoped rather than global because other workspaces' suites run concurrently
 * under turbo and write to these same tables; a global count would make this
 * assertion flaky rather than strict.
 */
async function countRows(): Promise<Record<string, number>> {
  const category = await prisma.category.findUnique({
    where: { slug: categorySlug },
    select: { id: true },
  });
  if (!category) {
    return { categories: 0, courses: 0, chapters: 0, lessons: 0, lessonContents: 0, generationJobs: 0 };
  }

  const courseWhere = { categoryId: category.id };
  const [courses, chapters, lessons, lessonContents, generationJobs] = await Promise.all([
    prisma.course.count({ where: courseWhere }),
    prisma.chapter.count({ where: { course: courseWhere } }),
    prisma.lesson.count({ where: { chapter: { course: courseWhere } } }),
    prisma.lessonContent.count({ where: { lesson: { chapter: { course: courseWhere } } } }),
    prisma.generationJob.count({ where: { targetEntityId: category.id } }),
  ]);
  return { categories: 1, courses, chapters, lessons, lessonContents, generationJobs };
}

/** Drives the SSE stream to its terminal event — the real client path. */
async function awaitJob(jobId: string, token: string): Promise<Record<string, unknown>> {
  const response = await request(app.getHttpServer())
    .get(`/api/admin/jobs/${jobId}/stream`)
    .set(as(token))
    .expect(200);

  const events = response.text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);

  const last = events.at(-1);
  if (!last) throw new Error(`stream for job ${jobId} produced no events`);
  return last;
}

async function dryRun(body: unknown, token: string): Promise<Record<string, unknown>> {
  const response = await request(app.getHttpServer())
    .post('/api/admin/courses/import/dry-run')
    .set(as(token))
    .send(body as object)
    .expect(202);

  return awaitJob(response.body.jobId as string, token);
}

beforeAll(async () => {
  importQueue = new ImportQueue(url, queueName);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_URL)
    .useValue(url)
    .overrideProvider(ImportQueue)
    .useValue(importQueue)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  worker = await startWorker({ IMPORT_QUEUE_NAME: queueName, REDIS_URL: url });

  tokens.owner = await seedUser('owner', 'admin_owner');
  tokens.admin = await seedUser('admin', 'admin');
  tokens.learner = await seedUser('learner', 'learner');
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await importQueue.queue.obliterate({ force: true });
  await app.close();

  const category = await prisma.category.findUnique({ where: { slug: categorySlug } });
  if (category) {
    await prisma.course.deleteMany({ where: { categoryId: category.id } });
    await prisma.category.delete({ where: { id: category.id } });
  }
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}, 30_000);

describe('POST /courses/import/dry-run', () => {
  it('previews a first import of a new category', async () => {
    const event = await dryRun(payload(), tokens.owner);

    expect(event['jobStatus']).toBe('succeeded');
    const plan = event['result'] as Record<string, any>;
    expect(plan.category.action).toBe('create');
    expect(plan.course.action).toBe('create');
    expect(plan.course.slug).toBe(`${categorySlug}-n5`);
    expect(plan.course.isPublished).toBe(false);
    expect(plan.counts).toMatchObject({
      chaptersCreated: 2,
      chaptersUpdated: 0,
      chaptersDeleted: 0,
      lessonsCreated: 3,
      lessonsUpdated: 0,
      lessonsDeleted: 0,
      conflicts: 0,
    });
  }, 30_000);

  it('writes nothing at all — not curriculum rows, not a generation_jobs row', async () => {
    const before = await countRows();
    await dryRun(payload(), tokens.owner);
    expect(await countRows()).toEqual(before);
  }, 30_000);

  it('returns identical counts when run twice against an unchanged database', async () => {
    const first = await dryRun(payload(), tokens.owner);
    const second = await dryRun(payload(), tokens.owner);

    expect((second['result'] as Record<string, any>).counts).toEqual(
      (first['result'] as Record<string, any>).counts,
    );
  }, 40_000);

  it('rejects a stale schemaVersion with 422, naming both versions, enqueuing nothing', async () => {
    const before = await countRows();
    const response = await request(app.getHttpServer())
      .post('/api/admin/courses/import/dry-run')
      .set(as(tokens.owner))
      .send({ ...payload(), schemaVersion: '0.0.1' })
      .expect(422);

    expect(response.body.errorCode).toBe(errorCodes.IMPORT_SCHEMA_VERSION_MISMATCH);
    expect(response.body.issues).toHaveLength(1);
    expect(response.body.issues[0].message).toContain(SCHEMA_VERSION);
    expect(await countRows()).toEqual(before);
  });

  it('reports every invalid field with its JSON path', async () => {
    const broken = payload() as any;
    broken.category.slug = 'Not A Slug';
    broken.course.levelOrder = 0;
    broken.chapters[0].lessons[0].title = '';

    const response = await request(app.getHttpServer())
      .post('/api/admin/courses/import/dry-run')
      .set(as(tokens.owner))
      .send(broken)
      .expect(422);

    expect(response.body.errorCode).toBe(errorCodes.IMPORT_PAYLOAD_INVALID);
    expect(
      response.body.issues.map((issue: { path: string }) => issue.path).sort(),
    ).toEqual(['category.slug', 'chapters[0].lessons[0].title', 'course.levelOrder']);
  });

  it('refuses an admin — import is owner-only under §3', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/admin/courses/import/dry-run')
      .set(as(tokens.admin))
      .send(payload())
      .expect(403);

    expect(response.body.errorCode).toBe(errorCodes.FORBIDDEN_ROLE);
  });

  it('refuses a learner', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/courses/import/dry-run')
      .set(as(tokens.learner))
      .send(payload())
      .expect(403);
  });

  it('answers 401, not 403, when unauthenticated', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/courses/import/dry-run')
      .send(payload())
      .expect(401);
  });
});

describe('the prompt template and schema downloads (FR-IMP-03)', () => {
  it('serves the template as a download, declaring the shipped version', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/import-template')
      .set(as(tokens.owner))
      .expect(200);

    expect(response.headers['content-disposition']).toContain('owner-prompt-template.md');
    expect(response.text).toContain(`schemaVersion: ${SCHEMA_VERSION}`);
  });

  it('serves the JSON schema generated from the validating module', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/import-schema')
      .set(as(tokens.owner))
      .expect(200);

    expect(response.body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(response.body.jsonSchema.required).toContain('chapters');
  });

  it('refuses an admin on both', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/import-template')
      .set(as(tokens.admin))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/admin/import-schema')
      .set(as(tokens.admin))
      .expect(403);
  });
});

/**
 * The commit path. These run after the dry-run block on purpose: they are the
 * first thing in this file to write, and the dry-run assertions above depend on
 * the category and course not yet existing.
 *
 * They also share one course and run in order, each building on the last, so the
 * re-import cases exercise a tree that a previous import actually produced.
 */
describe('POST /courses/import', () => {
  const courseSlug = `${categorySlug}-n5`;

  async function commit(body: unknown, token: string): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .post('/api/admin/courses/import')
      .set(as(token))
      .send(body as object)
      .expect(202);
    return awaitJob(response.body.jobId as string, token);
  }

  const tree = () =>
    prisma.course.findUnique({
      where: { slug: courseSlug },
      include: {
        chapters: {
          where: { deletedAt: null },
          orderBy: { chapterOrder: 'asc' },
          include: { lessons: { where: { deletedAt: null }, orderBy: { lessonOrder: 'asc' } } },
        },
      },
    });

  it('creates the whole skeleton on a first import', async () => {
    const event = await commit(payload(), tokens.owner);
    expect(event['jobStatus']).toBe('succeeded');

    const course = await tree();
    expect(course).not.toBeNull();
    expect(course!.slug).toBe(courseSlug);
    expect(course!.importedByUserId).not.toBeNull();
    expect(course!.chapters.map((c) => c.title)).toEqual(['Hiragana', 'Katakana']);
    expect(course!.chapters[0]!.lessons.map((l) => l.title)).toEqual([
      'The A-row',
      'The KA-row',
    ]);
  }, 30_000);

  it('creates every lesson empty, with no lesson_contents row (FR-IMP-01)', async () => {
    const course = await tree();
    const lessonIds = course!.chapters.flatMap((c) => c.lessons.map((l) => l.id));

    expect(course!.chapters.every((c) => c.lessons.every((l) => l.contentStatus === 'empty'))).toBe(
      true,
    );
    expect(await prisma.lessonContent.count({ where: { lessonId: { in: lessonIds } } })).toBe(0);
  });

  it('records the job against the category, and drives it to succeeded', async () => {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: categorySlug } });
    const row = await prisma.generationJob.findFirstOrThrow({
      where: { targetEntityId: category.id, jobType: 'import_course_outline' },
      orderBy: { createdAt: 'desc' },
    });

    expect(row.jobStatus).toBe('succeeded');
    expect(row.startedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect(row.attemptCount).toBe(1);
  });

  it('is idempotent: re-importing the identical payload duplicates nothing', async () => {
    const before = await tree();
    const event = await commit(payload(), tokens.owner);

    const result = event['result'] as Record<string, any>;
    expect(result.counts.chaptersCreated).toBe(0);
    expect(result.counts.lessonsCreated).toBe(0);

    const after = await tree();
    expect(after!.chapters).toHaveLength(before!.chapters.length);
    expect(after!.chapters.map((c) => c.id)).toEqual(before!.chapters.map((c) => c.id));
  }, 30_000);

  it('updates a renamed chapter and a reordered lesson in place, keeping ids', async () => {
    const before = await tree();
    const chapterId = before!.chapters[0]!.id;
    const [aRow, kaRow] = before!.chapters[0]!.lessons;

    const edited = payload() as any;
    edited.chapters[0].title = 'Hiragana basics';
    edited.chapters[0].lessons = [
      { lessonOrder: 1, title: 'The KA-row', keyPoints: ['ka ki ku ke ko'] },
      { lessonOrder: 2, title: 'The A-row', keyPoints: ['a i u e o'], estimatedMinutes: 15 },
    ];
    await commit(edited, tokens.owner);

    const after = await tree();
    expect(after!.chapters[0]!.id).toBe(chapterId);
    expect(after!.chapters[0]!.title).toBe('Hiragana basics');
    expect(after!.chapters[0]!.lessons.map((l) => [l.id, l.lessonOrder])).toEqual([
      [kaRow!.id, 1],
      [aRow!.id, 2],
    ]);
  }, 30_000);

  it('reverses chapter order in one import without violating idx_chapters_order', async () => {
    const reversed = payload() as any;
    reversed.chapters[0].title = 'Hiragana basics';
    reversed.chapters[0].chapterOrder = 2;
    reversed.chapters[1].chapterOrder = 1;

    const event = await commit(reversed, tokens.owner);
    expect(event['jobStatus']).toBe('succeeded');

    const after = await tree();
    expect(after!.chapters.map((c) => [c.title, c.chapterOrder])).toEqual([
      ['Katakana', 1],
      ['Hiragana basics', 2],
    ]);
  }, 30_000);

  it('soft-deletes a dropped lesson that is empty, keeping the row', async () => {
    // A lesson can only be *dropped* if nothing takes its order slot: replacing
    // the lesson at order 1 with a different title is, by design, a rename.
    // So this drops the trailing lesson and leaves the rest of the payload alone.
    const before = await tree();
    const hiragana = before!.chapters.find((c) => c.title === 'Hiragana basics')!;
    const kept = hiragana.lessons[0]!;
    const doomed = hiragana.lessons[1]!;

    // Titles come from the tree rather than being hardcoded: earlier tests in
    // this file reorder these lessons, and a hardcoded title would silently
    // match the survivor instead of the one meant to be dropped.
    const dropped = payload() as any;
    dropped.chapters[0].title = 'Hiragana basics';
    dropped.chapters[0].chapterOrder = 2;
    dropped.chapters[0].lessons = [{ lessonOrder: 1, title: kept.title }];
    dropped.chapters[1].chapterOrder = 1;

    const event = await commit(dropped, tokens.owner);
    expect((event['result'] as any).counts.lessonsDeleted).toBe(1);

    const row = await prisma.lesson.findUniqueOrThrow({ where: { id: doomed.id } });
    expect(row.deletedAt).not.toBeNull();
    // Deleted rows keep the order they had, not a parked negative.
    expect(row.lessonOrder).toBe(doomed.lessonOrder);
  }, 30_000);

  it('never deletes a dropped lesson carrying draft content, and applies the rest', async () => {
    // Give the chapter a second lesson, then put draft content on it.
    const seeded = payload() as any;
    seeded.chapters[0].title = 'Hiragana basics';
    seeded.chapters[0].chapterOrder = 2;
    seeded.chapters[0].lessons = [
      { lessonOrder: 1, title: 'The KA-row' },
      { lessonOrder: 2, title: 'Half-written lesson' },
    ];
    seeded.chapters[1].chapterOrder = 1;
    await commit(seeded, tokens.owner);

    const withLesson = await tree();
    const protectedLesson = withLesson!.chapters
      .find((c) => c.title === 'Hiragana basics')!
      .lessons.find((l) => l.title === 'Half-written lesson')!;

    await prisma.lesson.update({
      where: { id: protectedLesson.id },
      data: { contentStatus: 'drafting' },
    });
    await prisma.lessonContent.create({
      data: { lessonId: protectedLesson.id, draftContentMarkdown: '# work in progress' },
    });

    // Now drop it, and rename the other chapter in the same payload.
    const dropped = payload() as any;
    dropped.chapters[0].title = 'Hiragana basics';
    dropped.chapters[0].chapterOrder = 2;
    dropped.chapters[0].lessons = [{ lessonOrder: 1, title: 'The KA-row' }];
    dropped.chapters[1].chapterOrder = 1;
    dropped.chapters[1].title = 'Katakana and loanwords';

    const event = await commit(dropped, tokens.owner);
    const result = event['result'] as Record<string, any>;

    expect(result.conflicts.map((c: { lessonId?: string }) => c.lessonId)).toContain(
      protectedLesson.id,
    );
    expect(result.counts.lessonsDeleted).toBe(0);

    const survivor = await prisma.lesson.findUniqueOrThrow({ where: { id: protectedLesson.id } });
    expect(survivor.deletedAt).toBeNull();

    // The rest of that same import still applied — a conflict never blocks it.
    const after = await tree();
    expect(after!.chapters.map((c) => c.title)).toContain('Katakana and loanwords');
  }, 40_000);

  it('flags a published course as having unpublished changes (§4.3)', async () => {
    await prisma.course.update({
      where: { slug: courseSlug },
      data: { publicationStatus: 'published', hasUnpublishedChanges: false },
    });

    const edited = payload() as any;
    edited.course.title = 'Japanese N5 — revised';
    edited.chapters[0].title = 'Hiragana basics';
    edited.chapters[0].chapterOrder = 2;
    edited.chapters[0].lessons = [{ lessonOrder: 1, title: 'The KA-row' }];
    edited.chapters[1].chapterOrder = 1;
    edited.chapters[1].title = 'Katakana and loanwords';

    const event = await commit(edited, tokens.owner);
    expect((event['result'] as any).hasUnpublishedChanges).toBe(true);

    const course = await prisma.course.findUniqueOrThrow({ where: { slug: courseSlug } });
    expect(course.hasUnpublishedChanges).toBe(true);
    expect(course.title).toBe('Japanese N5 — revised');

    await prisma.course.update({
      where: { slug: courseSlug },
      data: { publicationStatus: 'draft' },
    });
  }, 30_000);

  it('a dry run against the existing tree still writes nothing', async () => {
    const before = await countRows();

    const dropEverything = payload() as any;
    dropEverything.chapters = [
      { chapterOrder: 1, title: 'Only chapter', lessons: [{ lessonOrder: 1, title: 'Only lesson' }] },
    ];
    const event = await dryRun(dropEverything, tokens.owner);

    // The plan is substantive — updates and conflicts, not a no-op. (Nothing is
    // deleted here because the surviving chapter holds the draft-content lesson,
    // which protects the whole chapter.)
    const counts = (event['result'] as any).counts;
    expect(counts.chaptersUpdated + counts.lessonsUpdated + counts.conflicts).toBeGreaterThan(0);

    // And none of it is applied.
    expect(await countRows()).toEqual(before);
  }, 30_000);

  it('refuses an admin and a learner', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/courses/import')
      .set(as(tokens.admin))
      .send(payload())
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/courses/import')
      .set(as(tokens.learner))
      .send(payload())
      .expect(403);
  });

  it('writes neither a category nor a job row when the payload is invalid', async () => {
    const before = await countRows();
    await request(app.getHttpServer())
      .post('/api/admin/courses/import')
      .set(as(tokens.owner))
      .send({ ...payload(), schemaVersion: 'nope' })
      .expect(422);

    expect(await countRows()).toEqual(before);
  });
});
