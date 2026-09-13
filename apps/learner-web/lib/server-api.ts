import { cookies } from 'next/headers';
import { apiFetch, type FetchOptions } from './api';

/**
 * Calls §9.4 from a server component, carrying the learner's session.
 *
 * A server-side `fetch` has no ambient cookie jar — `credentials: 'include'`
 * means nothing here — so the session cookie has to be forwarded by hand. Miss
 * this and every server-rendered page silently believes the visitor is signed
 * out, which looks exactly like a working anonymous experience and is the
 * hardest version of this bug to notice.
 *
 * Only the LEARNER cookie is forwarded. The API ignores admin-web's name on
 * these endpoints anyway, but sending it would be passing an admin session to a
 * learner surface for no reason.
 */
const LEARNER_COOKIE_NAMES = [
  'authjs.learner-session-token',
  '__Secure-authjs.learner-session-token',
];

export async function learnerCookieHeader(): Promise<string | null> {
  const store = await cookies();
  const pairs = LEARNER_COOKIE_NAMES.map((name) => {
    const value = store.get(name)?.value;
    return value ? `${name}=${value}` : null;
  }).filter((pair): pair is string => pair !== null);

  return pairs.length > 0 ? pairs.join('; ') : null;
}

export async function isSignedIn(): Promise<boolean> {
  return (await learnerCookieHeader()) !== null;
}

/** `apiFetch` with the learner's cookie attached, when there is one. */
export async function serverApiFetch<T>(path: string, init: FetchOptions = {}): Promise<T> {
  const cookie = await learnerCookieHeader();
  return apiFetch<T>(path, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
}
