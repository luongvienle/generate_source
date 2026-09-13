import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { getPrismaClient } from '@knowledge-explorer/database';

/**
 * Point Auth.js at THIS app's origin before it initializes.
 *
 * The repository keeps one `.env` at the root and `AUTH_URL` in it is
 * admin-web's `http://localhost:3000`. Auth.js v5 builds its sign-in and
 * callback URLs from `AUTH_URL` and prefers it over an inferred host, so
 * without this override learner-web advertises admin-web's callback and every
 * sign-in 404s — `/api/auth/providers` reports port 3000 while the app serves
 * 3002, and the symptom is a Next 404 that looks like a missing route.
 *
 * Assigned here rather than in `next.config.ts` because this module is what
 * reads it: NextAuth captures the value when it is constructed below, and a
 * dev server that evaluates route handlers in another worker would not see a
 * mutation made in the config.
 */
process.env['AUTH_URL'] = process.env['LEARNER_AUTH_URL'] ?? 'http://localhost:3002';

/**
 * The learner app's Auth.js instance.
 *
 * Same adapter and same `sessions` table as admin-web, and database sessions
 * for the same reason (FR-AUTH-01: disabling an account must block the next
 * call; the API resolves identity from these rows on every request). What
 * differs is the cookie and the audience.
 *
 * THE COOKIE NAME IS DELIBERATELY NOT admin-web's. Both apps serve `localhost`
 * in development and cookies ignore port, so sharing `authjs.session-token`
 * would have each app silently overwriting the other's session — sign into the
 * learner app and the admin portal logs you out, and vice versa. The API reads
 * the two names separately (`readLearnerSessionToken` vs `readSessionToken`),
 * which also keeps identity from depending on `Cookie` header order when a
 * request carries both.
 *
 * SIGN-UP IS SELF-SERVE AND CREATES LEARNERS ONLY. New rows take the schema
 * default `user_role = 'learner'`; nothing in this app writes a role, so there
 * is no path from here to `admin` or `admin_owner`.
 *
 * Delivery is dev-mode logging, mirroring admin-web and `LogEmailProvider`.
 * §7.5's transactional provider is still P8's decision.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(getPrismaClient()),
  session: { strategy: 'database' },
  pages: { signIn: '/signin' },
  /**
   * Infer the base URL from the request rather than from `AUTH_URL`.
   *
   * The repository keeps ONE `.env` at the root, and `AUTH_URL` in it is
   * admin-web's `http://localhost:3000`. Auth.js v5 validates the callback
   * against that value, so without this every learner sign-in 404s at
   * `/api/auth/callback/email` — the route resolves, Auth.js declines it, and
   * the symptom is a Next 404 page that looks like a missing route rather than
   * a rejected host.
   *
   * Safe here because the host is not attacker-controlled in either
   * environment this runs in: behind a proxy it is the proxy's, and locally it
   * is the port the app was started on.
   */
  trustHost: true,
  cookies: {
    sessionToken: {
      name: 'authjs.learner-session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env['NODE_ENV'] === 'production',
      },
    },
  },
  providers: [
    {
      id: 'email',
      type: 'email',
      name: 'Email',
      from: 'noreply@knowledge-explorer.local',
      maxAge: 24 * 60 * 60,
      options: {},
      async sendVerificationRequest({ identifier, url }) {
        // Mirrors admin-web and apps/api LogEmailProvider. Replaced in P8.
        console.log(`[email] learner sign-in link for ${identifier}: ${url}`);
      },
    },
  ],
});
