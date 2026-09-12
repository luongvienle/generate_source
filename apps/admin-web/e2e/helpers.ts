import { createHash, randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { getPrismaClient } from '@knowledge-explorer/database';

/**
 * Shared browser-suite helpers.
 *
 * Sign-in goes through a real Auth.js magic link rather than a forged cookie, so
 * the suite exercises the same path a person does — including the token hashing
 * that `scripts/verify-magic-link.sh` guards.
 */

const prisma = getPrismaClient();

/**
 * Consumes a real Auth.js magic link: the token is stored as
 * sha256(raw + AUTH_SECRET), which is what Auth.js itself does.
 *
 * `landingTestId` is awaited after the redirect, so the caller knows the session
 * is live before it does anything else.
 */
export async function signIn(
  page: Page,
  email: string,
  callbackUrl: string,
  landingTestId: string,
): Promise<void> {
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
      `&callbackUrl=${encodeURIComponent(callbackUrl)}`,
  );
  await expect(page.getByTestId(landingTestId)).toBeVisible();
}
