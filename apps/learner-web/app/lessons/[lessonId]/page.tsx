import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, isNotEntitled, isNotFound } from '../../../lib/api';
import { isSignedIn, serverApiFetch } from '../../../lib/server-api';
import type { LessonReadView } from '../../../lib/reader-types';
import { LessonReader } from '../../../components/lesson-reader';
import { Paywall } from '../../../components/paywall';

/**
 * FR-LRN-01: read a lesson.
 *
 * Rendered per request rather than statically, because the SAME URL returns
 * different things to different people: §7.3 decides on the caller's grants,
 * and a cached copy of an entitled response served to a stranger would be the
 * leak E-01 exists to prevent. The course and catalog pages are the cacheable
 * ones; this one never is.
 */
export const dynamic = 'force-dynamic';

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;

  // The learner's own cookie must be forwarded explicitly: a server fetch has
  // no cookie jar, so without this every reader would be an anonymous one.
  const signedIn = await isSignedIn();

  let lesson: LessonReadView;
  try {
    lesson = await serverApiFetch<LessonReadView>(`/lessons/${lessonId}`, { cache: 'no-store' });
  } catch (error) {
    /**
     * The refusal carries the course slug and title and nothing else, so the
     * paywall renders from it without a second request — and the lesson's words
     * never reach this process, let alone the browser.
     */
    if (isNotEntitled(error)) {
      const failure = (error as ApiError).failure;
      return (
        <Paywall
          courseSlug={failure.courseSlug ?? ''}
          courseTitle={failure.courseTitle ?? 'Khoá học'}
        />
      );
    }
    if (isNotFound(error)) notFound();
    throw error;
  }

  /**
   * Restores the completion control and the resume position on first paint.
   * A failure here costs the learner their place, not the lesson, so it falls
   * back to "no progress yet" rather than failing the page.
   */
  const initialProgress = signedIn
    ? await serverApiFetch<{
        completed: boolean;
        scrollPercentage: number;
        audioPositionMs: number;
      }>(`/lessons/${lessonId}/progress`, { cache: 'no-store' }).catch(() => null)
    : null;

  return (
    <main className="reading-main">
      <nav className="text-sm text-neutral-500">
        <Link href={`/courses/${lesson.courseSlug}`} className="hover:underline">
          {lesson.courseTitle}
        </Link>{' '}
        · {lesson.chapterTitle}
      </nav>

      <h1 className="mt-2 text-2xl font-semibold" data-testid="lesson-title">
        {lesson.title}
      </h1>
      {lesson.isFreePreview ? (
        <p className="mt-2 inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
          Học thử miễn phí
        </p>
      ) : null}

      <LessonReader lesson={lesson} isSignedIn={signedIn} initialProgress={initialProgress} />

      <nav className="mt-10 flex flex-wrap justify-between gap-4 border-t border-neutral-200 pt-4">
        {lesson.previous ? (
          <Link
            href={`/lessons/${lesson.previous.lessonId}`}
            className="hover:underline"
            data-testid="lesson-previous"
          >
            ← {lesson.previous.title}
          </Link>
        ) : (
          <span />
        )}
        {lesson.next ? (
          <Link
            href={`/lessons/${lesson.next.lessonId}`}
            className="text-right hover:underline"
            data-testid="lesson-next"
          >
            {lesson.next.title} →
          </Link>
        ) : null}
      </nav>
    </main>
  );
}
