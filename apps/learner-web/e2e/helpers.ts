import { createHash, randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { getPrismaClient } from '@knowledge-explorer/database';

/**
 * Helpers for the learner browser suite.
 *
 * The course is authored and published through the ADMIN API, the way a real
 * one is, so the scenario proves the seam between the two apps rather than a
 * fixture the learner app happens to like. Only the pieces P8 owns — an access
 * grant — are written directly, because no endpoint creates one yet.
 */

const prisma = getPrismaClient();

export const API = 'http://localhost:3001';

export interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

/** An admin-web session, for driving the authoring API. */
export async function seedStaff(role: 'admin_owner' | 'admin', run: string): Promise<SeededUser> {
  const email = `${role}-e2e-${run}@example.test`;
  const user = await prisma.user.create({ data: { email, userRole: role }, select: { id: true } });
  const token = `e2e-${run}-${randomBytes(6).toString('hex')}`;
  await prisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return { id: user.id, email, token };
}

export const adminCookie = (token: string) => ({ Cookie: `authjs.session-token=${token}` });

/**
 * Signs a learner in through a REAL Auth.js magic link, the way
 * apps/admin-web/e2e/helpers.ts does.
 *
 * The token is stored as sha256(raw + AUTH_SECRET), which is Auth.js's own
 * scheme and CLAUDE.md invariant 3 — so this also exercises the hashing that
 * `scripts/verify-magic-link.sh` guards, on the learner app's instance.
 */
export async function signInAsLearner(page: Page, email: string): Promise<void> {
  const raw = randomBytes(32).toString('hex');
  const secret = process.env['AUTH_SECRET'] ?? '';

  await prisma.verificationToken.create({
    data: {
      identifier: email,
      token: createHash('sha256').update(`${raw}${secret}`).digest('hex'),
      expires: new Date(Date.now() + 10 * 60_000),
    },
  });

  await page.goto(
    `/api/auth/callback/email?token=${raw}&email=${encodeURIComponent(email)}` +
      `&callbackUrl=${encodeURIComponent('/me/courses')}`,
  );
  // Landing on My Courses proves the session cookie is live.
  await expect(page.getByRole('heading', { name: 'Khoá của tôi' })).toBeVisible();
}

/** P8 owns grant creation; until then the suite writes the row it would. */
export async function grantAccess(
  userId: string,
  courseId: string,
  options: { expiresAt?: Date | null; gracePeriodDays?: number } = {},
): Promise<string> {
  const grant = await prisma.accessGrant.create({
    data: {
      userId,
      scopeType: 'course',
      scopeCourseId: courseId,
      accessSource: 'purchase',
      expiresAt:
        options.expiresAt === undefined
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          : options.expiresAt,
      gracePeriodDays: options.gracePeriodDays ?? 0,
    },
    select: { id: true },
  });
  return grant.id;
}

export { prisma };

/**
 * Waits for a durable job to reach a terminal state.
 *
 * Polls `generation_jobs` rather than the API: §9.3 exposes job progress only as
 * an SSE stream (`GET /admin/jobs/:jobId/stream`), and consuming a stream to
 * learn one boolean would make this helper the most fragile thing in the suite.
 * The row is the same state machine `withJobLifecycle` drives, and P6's worker
 * tests read it the same way.
 */
export async function waitForJob(generationJobId: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.generationJob.findUnique({
      where: { id: generationJobId },
      select: { jobStatus: true, errorMessage: true },
    });
    if (job?.jobStatus === 'succeeded') return job.jobStatus;
    if (job?.jobStatus === 'failed') {
      throw new Error(`job ${generationJobId} failed: ${job.errorMessage ?? 'no error recorded'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`job ${generationJobId} did not finish within ${timeoutMs}ms`);
}
