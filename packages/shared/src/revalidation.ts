/**
 * NFR-01's on-demand revalidation call, shared by the two callers that make it.
 *
 * `apps/api` fires it for unpublish and archive, which are synchronous
 * transitions with no job behind them; `apps/worker` fires it after a publish
 * commits. §11 forbids either app importing the other, so the call lives here
 * rather than being written twice and drifting.
 *
 * BEST EFFORT, ALWAYS. Every failure mode — no URL configured, no secret,
 * learner-web down, a non-2xx, a timeout — resolves to `false` and never
 * throws. By the time this runs the publish transaction has committed and the
 * course IS published; turning a cache miss into a failed publish would be a
 * strictly worse outcome, and the pages' revalidate interval already bounds how
 * long a stale page can survive.
 */

export interface RevalidationTarget {
  readonly courseSlug?: string | null;
  readonly categorySlug?: string | null;
}

/** How long to wait before giving up. A publish must not hang on a cache. */
const REVALIDATE_TIMEOUT_MS = 5_000;

export async function revalidateLearnerPages(target: RevalidationTarget): Promise<boolean> {
  const baseUrl = process.env['LEARNER_WEB_URL'];
  const secret = process.env['REVALIDATE_SECRET'];
  if (!baseUrl || !secret) return false;
  if (!target.courseSlug && !target.categorySlug) return false;

  try {
    const response = await fetch(`${baseUrl}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
      body: JSON.stringify({
        courseSlug: target.courseSlug ?? null,
        categorySlug: target.categorySlug ?? null,
      }),
      signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
