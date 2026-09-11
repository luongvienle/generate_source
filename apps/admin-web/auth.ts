import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { getPrismaClient } from '@knowledge-explorer/database';

/**
 * Auth.js with database sessions (spec decision, P0).
 *
 * Database sessions rather than a JWT because FR-AUTH-01 requires that
 * disabling an admin block their next call immediately. The API resolves role
 * and is_active from these rows on every request; this app only mints them.
 *
 * Delivery is dev-mode: the sign-in link is written to the log. §7.5's
 * transactional email provider is still an open decision owned by P8, so no
 * mail transport is configured and nothing leaves the process.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(getPrismaClient()),
  session: { strategy: 'database' },
  pages: { signIn: '/signin' },
  providers: [
    {
      id: 'email',
      type: 'email',
      name: 'Email',
      from: 'noreply@knowledge-explorer.local',
      maxAge: 24 * 60 * 60,
      options: {},
      async sendVerificationRequest({ identifier, url }) {
        // Mirrors apps/api LogEmailProvider. Replaced wholesale in P8.
        console.log(`[email] sign-in link for ${identifier}: ${url}`);
      },
    },
  ],
});
