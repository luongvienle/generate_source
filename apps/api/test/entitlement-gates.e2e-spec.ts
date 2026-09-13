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
 * §7.3 requirement E-01, which asks for exactly this file:
 *
 *   "`hasAccessToLesson` must gate BOTH `GET /lessons/:lessonId` and
 *    `GET /media/:mediaId/signed-url`. Missing either one leaks paid audio.
 *    A regression test covers both endpoints."
 *
 * Both endpoints, one file, the same five callers each — because the failure
 * this guards against is not "the check is wrong" but "the check is on one
 * endpoint and not the other", and only a test that walks both in step can see
 * that.
 *
 * It also holds the deliberate ABSENCE of the guard chain on these controllers.
 * Seven phases have taught every reader that a controller without
 * `@RequirePermission` is a bug; §9.4's public endpoints are the exception, and
 * `respondsToAnonymousCallers` below is what keeps someone from "fixing" it.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();

const DAY = 24 * 60 * 60 * 1000;

/**
 * The learner app's own cookie name.
 *
 * NOT `authjs.session-token`, which is admin-web's. The two Next apps share a
 * host in development and cookies ignore port, so each app has its own name and
 * the API reads them separately — see `readLearnerSessionToken`. A test that
 * signed a public request with the admin cookie would resolve as anonymous and
 * pass for the wrong reason, which is why this constant is spelled out here.
 */
const asLearner = (token: string) => ({ Cookie: `authjs.learner-session-token=${token}` });
const asAdminCookie = (token: string) => ({ Cookie: `authjs.session-token=${token}` });
const api = () => request(app.getHttpServer());

const BODY = '# Cách viết\n\nTiếng Nhật dùng ba hệ chữ.\n\nHiragana là một bảng âm tiết.\n';

let app: INestApplication;
let categoryId = '';
let levelOrder = 0;

interface SeededLesson {
  readonly lessonId: string;
  readonly mediaId: string;
}

interface SeededCourse {
  readonly courseId: string;
  readonly slug: string;
  /** A lesson that is NOT a free preview — the one entitlement must protect. */
  readonly gated: SeededLesson;
  /** A lesson flagged `isFreePreview`, readable by anyone per §7.3. */
  readonly preview: SeededLesson;
}

async function seedUser(local: string, userRole: string): Promise<[string, string]> {
  const user = await prisma.user.create({
    data: { email: `${local}-ent-${run}@example.test`, name: local, userRole },
    select: { id: true },
  });
  const sessionToken = `tok-ent-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return [user.id, sessionToken];
}

/**
 * A published course, written straight to the published track.
 *
 * P6's publish job is not run here: this suite asserts what the public
 * endpoints refuse, and driving a BullMQ job to seed a fixture would make an
 * entitlement failure indistinguishable from a publish failure.
 */
async function seedPublishedCourse(
  suffix: string,
  pricingType: string,
  publishedByUserId: string,
): Promise<SeededCourse> {
  levelOrder += 1;
  const slug = `ent-${run}-${suffix}`;
  const course = await prisma.course.create({
    data: {
      categoryId,
      slug,
      levelLabel: `L${levelOrder}`,
      levelOrder,
      title: `Khoá ${suffix}`,
      pricingType,
      publicationStatus: 'published',
      publishedAt: new Date(),
      coverImageUrl: 'https://cdn.example.test/cover.png',
      languageCode: 'vi',
    },
    select: { id: true },
  });

  const chapter = await prisma.chapter.create({
    data: { courseId: course.id, chapterOrder: 1, title: 'Chương 1' },
    select: { id: true },
  });

  const gated = await seedLesson(chapter.id, 1, false);
  const preview = await seedLesson(chapter.id, 2, true);

  await prisma.publishedCourseStructure.create({
    data: {
      courseId: course.id,
      publishedVersionNumber: 1,
      totalLessonCount: 2,
      publishedByUserId,
      publishedAt: new Date(),
      structurePayload: {
        courseId: course.id,
        publishedVersionNumber: 1,
        totalLessonCount: 2,
        chapters: [
          {
            chapterId: chapter.id,
            order: 1,
            title: 'Chương 1',
            description: null,
            lessons: [
              {
                lessonId: gated.lessonId,
                order: 1,
                title: 'Bài 1',
                estimatedMinutes: 10,
                isFreePreview: false,
                hasAudio: true,
                audioDurationSeconds: 12,
                figureCount: 0,
              },
              {
                lessonId: preview.lessonId,
                order: 2,
                title: 'Bài 2',
                estimatedMinutes: 10,
                isFreePreview: true,
                hasAudio: true,
                audioDurationSeconds: 12,
                figureCount: 0,
              },
            ],
          },
        ],
      } as object,
    },
  });

  return { courseId: course.id, slug, gated, preview };
}

/** One lesson with both tracks populated, a fresh script and ready audio. */
async function seedLesson(
  chapterId: string,
  lessonOrder: number,
  isFreePreview: boolean,
): Promise<SeededLesson> {
  const lesson = await prisma.lesson.create({
    data: {
      chapterId,
      lessonOrder,
      title: `Bài ${lessonOrder}`,
      estimatedMinutes: 10,
      isFreePreview,
      contentStatus: 'published',
    },
    select: { id: true },
  });

  const parsed = parseLessonMarkdown(BODY, null);
  if (!parsed.ok) throw new Error('seed markdown did not parse');
  const checksum = blockListChecksum(parsed.blockList);
  const blockList = parsed.blockList as unknown as object;

  await prisma.lessonContent.create({
    data: {
      lessonId: lesson.id,
      draftContentMarkdown: BODY,
      draftBlockList: blockList,
      draftContentChecksum: checksum,
      // §4.3's published half — what every assertion in this file reads.
      publishedContentMarkdown: BODY,
      publishedBlockList: blockList,
      publishedAt: new Date(),
      draftUpdatedAt: new Date(),
    },
  });

  const blocks = (parsed.blockList as unknown as { blocks: Block[] }).blocks;
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
      // The §6.5 chain the reader checks against the PUBLISHED block list.
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
      mergedAudioFileUrl: `lessons/${lesson.id}/audio/merged/seeded.mp3`,
      totalDurationSeconds: 12,
      totalCharacterCount: 120,
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
        endMillisecond: cursor + 1_000,
        sourceSegmentChecksum: segment.segmentChecksum,
      },
    });
    cursor += 1_000;
  }

  return { lessonId: lesson.id, mediaId: audio.id };
}

async function grantTo(
  userId: string,
  courseId: string,
  overrides: { expiresAt?: Date | null; revokedAt?: Date | null; gracePeriodDays?: number } = {},
): Promise<string> {
  const row = await prisma.accessGrant.create({
    data: {
      userId,
      scopeType: 'course',
      scopeCourseId: courseId,
      accessSource: 'granted_by_owner',
      expiresAt: overrides.expiresAt === undefined ? new Date(Date.now() + 30 * DAY) : overrides.expiresAt,
      gracePeriodDays: overrides.gracePeriodDays ?? 0,
      revokedAt: overrides.revokedAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

let paid: SeededCourse;
let free: SeededCourse;
const users: Record<string, { id: string; token: string }> = {};

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: `ent-cat-${run}`, displayName: 'Tiếng Nhật' },
    select: { id: true },
  });
  categoryId = category.id;

  for (const [key, role] of [
    ['entitled', 'learner'],
    ['stranger', 'learner'],
    ['expired', 'learner'],
    ['revoked', 'learner'],
    ['owner', 'admin_owner'],
    ['admin', 'admin'],
  ] as const) {
    const [id, token] = await seedUser(key, role);
    users[key] = { id, token };
  }

  // Courses after users: published_course_structures.published_by_user_id is
  // NOT NULL, so the snapshot cannot exist before the owner it credits.
  paid = await seedPublishedCourse('paid', 'paid', users['owner']!.id);
  free = await seedPublishedCourse('free', 'free', users['owner']!.id);

  await grantTo(users['entitled']!.id, paid.courseId);
  await grantTo(users['expired']!.id, paid.courseId, { expiresAt: new Date(Date.now() - DAY) });
  await grantTo(users['revoked']!.id, paid.courseId, { revokedAt: new Date() });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await prisma.accessGrant.deleteMany({
    where: { userId: { in: Object.values(users).map((user) => user.id) } },
  });
  await prisma.publishedCourseStructure.deleteMany({
    where: { courseId: { in: [paid.courseId, free.courseId] } },
  });
  await prisma.course.deleteMany({ where: { id: { in: [paid.courseId, free.courseId] } } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.session.deleteMany({
    where: { userId: { in: Object.values(users).map((user) => user.id) } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: Object.values(users).map((user) => user.id) } },
  });
});

/**
 * The two endpoints E-01 names, walked in step.
 *
 * Each case asserts BOTH, so an implementation that gates the reader and
 * forgets the media endpoint — the exact leak E-01 describes — fails here
 * rather than shipping.
 */
describe('E-01: hasAccessToLesson gates both endpoints', () => {
  const readLesson = (lessonId: string, headers?: Record<string, string>) =>
    headers ? api().get(`/api/lessons/${lessonId}`).set(headers) : api().get(`/api/lessons/${lessonId}`);

  const readMedia = (mediaId: string, headers?: Record<string, string>) =>
    headers
      ? api().get(`/api/media/${mediaId}/signed-url`).set(headers)
      : api().get(`/api/media/${mediaId}/signed-url`);

  it('refuses an anonymous caller on a paid lesson, on both', async () => {
    await readLesson(paid.gated.lessonId).expect(403);
    await readMedia(paid.gated.mediaId).expect(403);
  });

  it('refuses a signed-in learner holding no grant, on both', async () => {
    const headers = asLearner(users['stranger']!.token);
    const lesson = await readLesson(paid.gated.lessonId, headers).expect(403);
    expect((lesson.body as { errorCode: string }).errorCode).toBe('LESSON_NOT_ENTITLED');
    const media = await readMedia(paid.gated.mediaId, headers).expect(403);
    expect((media.body as { errorCode: string }).errorCode).toBe('LESSON_NOT_ENTITLED');
  });

  it('allows a learner holding an active grant, on both', async () => {
    const headers = asLearner(users['entitled']!.token);
    const lesson = await readLesson(paid.gated.lessonId, headers).expect(200);
    const body = lesson.body as { lessonId: string; blocks: unknown[]; audio: unknown };
    expect(body.lessonId).toBe(paid.gated.lessonId);
    // A 200 carrying nothing would satisfy the gate and still be broken, so the
    // allowed case asserts the content actually arrives.
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.audio).not.toBeNull();
    const media = await readMedia(paid.gated.mediaId, headers).expect(200);
    expect((media.body as { url: string }).url).toContain('http');
  });

  it('refuses a learner whose grant has expired, on both', async () => {
    // E-02: expiry is never materialized into a status column, so this refusal
    // is computed from expiresAt on this very request.
    const headers = asLearner(users['expired']!.token);
    await readLesson(paid.gated.lessonId, headers).expect(403);
    await readMedia(paid.gated.mediaId, headers).expect(403);
  });

  it('refuses a learner whose grant was revoked, on both', async () => {
    // FR-COM-04: revocation takes effect on the next request, and this grant's
    // expiresAt is still 30 days out.
    const headers = asLearner(users['revoked']!.token);
    await readLesson(paid.gated.lessonId, headers).expect(403);
    await readMedia(paid.gated.mediaId, headers).expect(403);
  });

  it('allows a free-preview lesson to anyone, on both', async () => {
    // §7.3 short-circuits on isFreePreview before any grant lookup, so this
    // holds for a paid course with no grant and no session at all.
    await readLesson(paid.preview.lessonId).expect(200);
    await readMedia(paid.preview.mediaId).expect(200);
  });

  it('allows any lesson of a free course to anyone, on both', async () => {
    await readLesson(free.gated.lessonId).expect(200);
    await readMedia(free.gated.mediaId).expect(200);
  });

  it('refuses an unknown media id before consulting entitlement', async () => {
    await readMedia('00000000-0000-0000-0000-000000000000', asLearner(users['entitled']!.token))
      .expect(404)
      .expect((response) => {
        expect((response.body as { errorCode: string }).errorCode).toBe('MEDIA_NOT_FOUND');
      });
  });
});

describe('the refusal body', () => {
  it('names the course so a paywall renders without a second request', async () => {
    const response = await readPaywall();
    expect(response.courseSlug).toBe(paid.slug);
    expect(response.courseTitle).toBe('Khoá paid');
  });

  it('carries no lesson content whatsoever', async () => {
    // The point of a 403 over a 200-with-a-flag: the words a learner has not
    // paid for never cross the wire, so no client bug can reveal them.
    const raw = JSON.stringify(await readPaywall());
    expect(raw).not.toContain('Hiragana');
    expect(raw).not.toContain('blocks');
    expect(raw).not.toContain('markdown');
  });

  const readPaywall = async (): Promise<Record<string, string>> => {
    const response = await api()
      .get(`/api/lessons/${paid.gated.lessonId}`)
      .set(asLearner(users['stranger']!.token))
      .expect(403);
    return response.body as Record<string, string>;
  };
});

/**
 * The guard chain's absence, held under test rather than left as a gap.
 *
 * This is the mirror of `UndeclaredPolicyFixtureController`: that one asserts an
 * endpoint with no declaration refuses everyone, and this one asserts §9.4's
 * public endpoints are the deliberate exception. Adding `@RequirePermission` to
 * the public controllers breaks this; removing the §7.3 call that stands in its
 * place breaks the suite above.
 */
describe('§9.4 public endpoints answer anonymous callers', () => {
  it('does not return FORBIDDEN_NO_POLICY or UNAUTHENTICATED', async () => {
    const response = await api().get(`/api/lessons/${free.gated.lessonId}`).expect(200);
    expect(response.body).not.toHaveProperty('errorCode');
  });

  it('ignores an admin-web session cookie on a public endpoint', async () => {
    // The two apps read different cookie names on purpose: an owner signed into
    // admin-web carries no learner cookie, so the learner app sees a visitor —
    // which is what §3 says, since buyAccessReadListenTrackProgress is a
    // learner-only action. Identity must not depend on Cookie header order.
    await api()
      .get(`/api/lessons/${paid.gated.lessonId}`)
      .set(asAdminCookie(users['owner']!.token))
      .expect(403);
  });

  it('treats a stale or unknown learner token as anonymous, never as an error', async () => {
    await api()
      .get(`/api/lessons/${free.gated.lessonId}`)
      .set(asLearner('not-a-real-session-token'))
      .expect(200);
  });
});
