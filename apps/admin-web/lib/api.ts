/**
 * The browser talks to apps/api directly, cross-origin, with the Auth.js session
 * cookie attached. The API echoes this origin in its CORS headers; '*' is
 * refused by the browser once credentials are involved.
 */
export const apiBaseUrl = (): string =>
  process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

export interface ApiFailure {
  readonly status: number;
  readonly errorCode?: string;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
  /** FR-EDIT-01: lesson-content validation locates each failure by line and column. */
  readonly errors?: ReadonlyArray<{ message: string; line: number; column: number }>;
  readonly reason?: string;
  /**
   * The whole parsed error body.
   *
   * The named fields above cover what every endpoint returns; an endpoint that
   * carries its own detail — P4's `figures` on SCRIPT_FIGURES_INCOMPLETE, its
   * `jobId` on SCRIPT_GENERATION_IN_FLIGHT — reads it from here rather than
   * growing this interface a field per endpoint.
   */
  readonly body?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.errorCode ?? `Request failed with ${failure.status}`);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}/api${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError({
      status: response.status,
      errorCode: typeof body['errorCode'] === 'string' ? body['errorCode'] : undefined,
      issues: Array.isArray(body['issues'])
        ? (body['issues'] as ReadonlyArray<{ path: string; message: string }>)
        : undefined,
      errors: Array.isArray(body['errors'])
        ? (body['errors'] as ReadonlyArray<{ message: string; line: number; column: number }>)
        : undefined,
      reason: typeof body['reason'] === 'string' ? body['reason'] : undefined,
      body,
    });
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Multipart upload, for FR-IMG-02.
 *
 * Deliberately does NOT go through apiFetch: that sets a JSON Content-Type, and
 * a multipart body must be left alone so the browser can add its own boundary.
 * Everything else — credentials, the error shape — is identical.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path.startsWith('/api') ? '' : '/api'}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError({
      status: response.status,
      errorCode: typeof body['errorCode'] === 'string' ? body['errorCode'] : undefined,
      body,
    });
  }

  return (await response.json()) as T;
}
