import type { UserRole } from '@knowledge-explorer/shared';

/**
 * The caller's identity, resolved from the database on every request.
 *
 * FR-AUTH-02: role is read from the session, never from client input. Nothing
 * downstream of SessionGuard may reconstruct identity from headers, body or
 * query — this object is the only source.
 */
export interface SessionContext {
  readonly userId: string;
  readonly userRole: UserRole;
  readonly isActive: boolean;
}

/** The subset of the HTTP request this app touches, kept free of express types. */
export interface RequestWithSession {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly params: Record<string, string | undefined>;
  sessionContext?: SessionContext;
}

/**
 * Auth.js cookie names differ by major version and gain a __Secure- prefix over
 * HTTPS, so all four spellings are accepted.
 */
const SESSION_COOKIE_NAMES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
];

export function readSessionToken(request: RequestWithSession): string | undefined {
  const header = request.headers['cookie'];
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return undefined;

  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    if (SESSION_COOKIE_NAMES.includes(name)) {
      return decodeURIComponent(pair.slice(index + 1).trim()) || undefined;
    }
  }
  return undefined;
}
