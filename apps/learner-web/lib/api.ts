/**
 * The learner app's client for §9.4's public API.
 *
 * Mirrors `apps/admin-web/lib/api.ts` deliberately — same error shape, same
 * credentialed fetch — with one difference that matters: most calls here are
 * made WITHOUT a session and must succeed anyway. §7.3 permits anonymous
 * reading of free courses and free previews, so `credentials: 'include'` sends
 * the learner cookie when there is one and nothing when there is not, and the
 * API decides.
 */

export const apiBaseUrl = (): string =>
  process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

export interface ApiFailure {
  readonly status: number;
  readonly errorCode?: string;
  /** §7.3: a LESSON_NOT_ENTITLED body names the course so a paywall can render. */
  readonly courseSlug?: string;
  readonly courseTitle?: string;
  readonly body?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.errorCode ?? `Request failed with ${failure.status}`);
    this.name = 'ApiError';
  }
}

export interface FetchOptions extends RequestInit {
  /**
   * ISR: how long a statically generated page may serve this response before
   * revalidating. A publish also pushes an on-demand revalidation, so this is
   * the backstop rather than the mechanism (NFR-01).
   */
  readonly revalidateSeconds?: number;
}

export async function apiFetch<T>(path: string, init: FetchOptions = {}): Promise<T> {
  const { revalidateSeconds, ...rest } = init;
  const response = await fetch(`${apiBaseUrl()}/api${path}`, {
    ...rest,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
    ...(revalidateSeconds === undefined ? {} : { next: { revalidate: revalidateSeconds } }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError({
      status: response.status,
      errorCode: typeof body['errorCode'] === 'string' ? body['errorCode'] : undefined,
      courseSlug: typeof body['courseSlug'] === 'string' ? body['courseSlug'] : undefined,
      courseTitle: typeof body['courseTitle'] === 'string' ? body['courseTitle'] : undefined,
      body,
    });
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Narrows an unknown error to the entitlement refusal a paywall renders from. */
export const isNotEntitled = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.failure.errorCode === 'LESSON_NOT_ENTITLED';

export const isNotFound = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.failure.status === 404;
