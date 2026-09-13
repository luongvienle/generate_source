import Link from 'next/link';

/**
 * What a learner sees instead of a lesson they hold no entitlement to.
 *
 * Built entirely from the `403 LESSON_NOT_ENTITLED` body — course slug and
 * title — so no second request is needed and, more importantly, no part of the
 * lesson ever reaches this component to be accidentally rendered.
 *
 * There is no purchase action here: `POST /checkout` is P8's. The link back to
 * the course page is where a price will appear once products exist, which is
 * the same block FR-CAT-03 already renders when one does.
 */
export function Paywall({ courseSlug, courseTitle }: { courseSlug: string; courseTitle: string }) {
  return (
    <main className="reading-main">
      <div className="rounded border border-neutral-300 p-6" data-testid="paywall">
        <h1 className="text-xl font-semibold">Bài học này cần quyền truy cập</h1>
        <p className="mt-3 text-neutral-700">
          Bài học thuộc khoá <strong>{courseTitle}</strong>. Bạn cần mua quyền truy cập khoá học để
          đọc và nghe nội dung này.
        </p>
        {courseSlug ? (
          <p className="mt-4">
            <Link
              href={`/courses/${courseSlug}`}
              className="inline-block rounded bg-neutral-900 px-4 py-2 text-white"
              data-testid="paywall-course-link"
            >
              Xem khoá học
            </Link>
          </p>
        ) : null}
        <p className="mt-4 text-sm text-neutral-600">
          Nếu bạn đã mua khoá học, hãy{' '}
          <Link href="/signin" className="underline">
            đăng nhập
          </Link>{' '}
          để tiếp tục.
        </p>
      </div>
    </main>
  );
}
