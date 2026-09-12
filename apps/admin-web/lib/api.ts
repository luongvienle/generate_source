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
  readonly reason?: string;
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
      reason: typeof body['reason'] === 'string' ? body['reason'] : undefined,
    });
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
