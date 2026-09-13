import { userRoleSchema } from '@knowledge-explorer/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestWithSession, SessionContext } from './session-context';

/**
 * Identity for §9.4's public endpoints, where being signed out is an ordinary
 * state rather than an error.
 *
 * SessionGuard rejects an absent or invalid session; that is right for
 * `/api/admin/*` and wrong here. §7.3 permits anonymous reading of free content
 * — `hasAccessToCourse` returns true for a free course without consulting
 * `userId` at all — so the catalog and the reader must resolve "nobody" and
 * carry on rather than refuse.
 *
 * It still shares SessionGuard's one non-negotiable property: identity comes
 * from the `sessions` table on every request and never from client input.
 */

/**
 * The learner app's session cookie, which is NOT one of the four names
 * `readSessionToken` accepts.
 *
 * The two Next apps run on the same host in development, and cookies ignore
 * port, so a shared name would have each app overwriting the other's session.
 * Giving learner-web its own name fixes that — but it also means this function
 * must read ONLY that name. Adding it to `SESSION_COOKIE_NAMES` instead would
 * make a request carrying both cookies resolve to whichever appeared first in
 * the `Cookie` header, so a signed-in owner browsing the learner app would
 * resolve as themselves or as nobody depending on header order.
 *
 * Reading them separately also delivers §3 for free: `buyAccessReadListenTrack
 * Progress` is a learner-only action, and an owner signed into admin-web
 * carries no learner cookie, so the learner app correctly sees a visitor.
 */
const LEARNER_SESSION_COOKIE_NAMES = [
  'authjs.learner-session-token',
  '__Secure-authjs.learner-session-token',
];

export function readLearnerSessionToken(request: RequestWithSession): string | undefined {
  const header = request.headers['cookie'];
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return undefined;

  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    if (LEARNER_SESSION_COOKIE_NAMES.includes(name)) {
      return decodeURIComponent(pair.slice(index + 1).trim()) || undefined;
    }
  }
  return undefined;
}

/**
 * Resolves the learner behind a request, or `null`.
 *
 * NEVER THROWS. Every reason a session might not resolve — no cookie, unknown
 * token, expired row, disabled account, unrecognised role — produces anonymous
 * rather than an error, because on a public endpoint each of those is a visitor
 * and §7.3 already knows what a visitor may read. A disabled account degrading
 * to public access is the deliberate reading: it loses the account's
 * entitlements without losing the free catalog.
 */
export async function resolveOptionalSession(
  prisma: PrismaService,
  request: RequestWithSession,
): Promise<SessionContext | null> {
  const token = readLearnerSessionToken(request);
  if (!token) return null;

  const session = await prisma.client.session.findUnique({
    where: { sessionToken: token },
    include: { user: true },
  });
  if (!session || session.expires.getTime() <= Date.now()) return null;
  if (!session.user.isActive) return null;

  const role = userRoleSchema.safeParse(session.user.userRole);
  if (!role.success) return null;

  return { userId: session.user.id, userRole: role.data, isActive: true };
}

/** The user id alone, which is all §7.3's resolvers take. */
export async function resolveOptionalUserId(
  prisma: PrismaService,
  request: RequestWithSession,
): Promise<string | null> {
  return (await resolveOptionalSession(prisma, request))?.userId ?? null;
}
