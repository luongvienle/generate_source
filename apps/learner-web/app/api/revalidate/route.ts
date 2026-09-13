import { revalidatePath } from 'next/cache';

/**
 * NFR-01's on-demand revalidation hook — the seam P6 left open.
 *
 * Called by the publish worker after a publish commits, and by apps/api when a
 * course is unpublished or archived. Both are best-effort: a failure here never
 * fails a publish, and the pages' own revalidate interval is the backstop.
 *
 * WHY UNPUBLISH MATTERS AS MUCH AS PUBLISH. A publish that takes five minutes
 * to appear is a delay; an unpublished course that keeps serving its cached
 * page is a course still being read after it was withdrawn. The api path exists
 * precisely because unpublish and archive are synchronous transitions with no
 * job behind them.
 *
 * Idempotent: revalidating a path that is already fresh is a no-op, so a
 * retried or duplicated call costs nothing.
 */

export async function POST(request: Request): Promise<Response> {
  const secret = process.env['REVALIDATE_SECRET'];
  if (!secret) {
    // Fail closed. A deployment that forgot the secret must not accept
    // unauthenticated cache-busting from anyone who finds the route.
    return Response.json({ error: 'revalidation is not configured' }, { status: 503 });
  }

  if (request.headers.get('x-revalidate-secret') !== secret) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { courseSlug?: unknown; categorySlug?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const revalidated: string[] = [];

  if (typeof body.courseSlug === 'string' && body.courseSlug.length > 0) {
    revalidatePath(`/courses/${body.courseSlug}`);
    revalidated.push(`/courses/${body.courseSlug}`);
  }

  // The category page lists levels and flips one from "in development" to a
  // link, so it is stale after a publish too.
  if (typeof body.categorySlug === 'string' && body.categorySlug.length > 0) {
    revalidatePath(`/categories/${body.categorySlug}`);
    revalidated.push(`/categories/${body.categorySlug}`);
  }

  return Response.json({ revalidated });
}
