import { createHash, randomBytes } from 'node:crypto';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { config as loadEnv } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient } from '@knowledge-explorer/database';

loadEnv({ path: ['../../.env', '.env'] });

const prisma = getPrismaClient();
const adapter = PrismaAdapter(prisma);
const run = randomBytes(4).toString('hex');
const identifier = `t10-${run}@example.test`;

afterAll(async () => {
  await prisma.verificationToken.deleteMany({ where: { identifier } });
  await prisma.$disconnect();
});

/**
 * Single-use sign-in links (FR-AUTH-01).
 *
 * Exercised at the adapter level because the full HTTP flow needs a running
 * Next server; scripts/verify-magic-link.sh drives that end to end.
 */
describe('verification tokens are single-use', () => {
  it('returns the token on first use and nothing on the second', async () => {
    const token = createHash('sha256').update(`probe-${run}`).digest('hex');
    const expires = new Date(Date.now() + 60_000);

    await adapter.createVerificationToken!({ identifier, token, expires });

    const first = await adapter.useVerificationToken!({ identifier, token });
    expect(first, 'first use should return the token').not.toBeNull();
    expect(first?.identifier).toBe(identifier);

    const second = await adapter.useVerificationToken!({ identifier, token });
    expect(second, 'a consumed token must not be usable again').toBeNull();

    const remaining = await prisma.verificationToken.findMany({ where: { identifier } });
    expect(remaining).toEqual([]);
  });

  it('does not accept a token belonging to another identifier', async () => {
    const token = createHash('sha256').update(`cross-${run}`).digest('hex');
    await adapter.createVerificationToken!({
      identifier,
      token,
      expires: new Date(Date.now() + 60_000),
    });

    const wrongIdentifier = await adapter.useVerificationToken!({
      identifier: `other-${run}@example.test`,
      token,
    });
    expect(wrongIdentifier).toBeNull();

    // The real token still works, so the failed attempt consumed nothing.
    expect(await adapter.useVerificationToken!({ identifier, token })).not.toBeNull();
  });
});
