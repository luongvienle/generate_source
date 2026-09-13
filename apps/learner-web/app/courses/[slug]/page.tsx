import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, isNotFound } from '../../../lib/api';
import { asStringList, formatPrice, type CoursePageView } from '../../../lib/catalog-types';

/**
 * FR-CAT-03: the course page.
 *
 * NFR-01: statically generated over every published slug and incrementally
 * revalidated, with the publish job pushing an on-demand revalidation so a
 * publish is visible immediately rather than after this window.
 *
 * `dynamicParams` stays on (the default): a course published after the last
 * build must render on first request rather than 404 until a rebuild.
 */
export const revalidate = 300;

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  try {
    const catalog = await apiFetch<{ courses: { slug: string }[] }>('/courses?pageSize=50', {
      cache: 'no-store',
    });
    return catalog.courses.map((course) => ({ slug: course.slug }));
  } catch {
    // A build with no API reachable pre-renders nothing and falls back to
    // on-demand rendering. Failing the build here would make the learner app
    // undeployable whenever the API happened to be down.
    return [];
  }
}

export default async function CoursePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let course: CoursePageView;
  try {
    course = await apiFetch<CoursePageView>(`/courses/${slug}`, { revalidateSeconds: 300 });
  } catch (error) {
    // A draft, unpublished or archived course 404s here exactly as a
    // non-existent one does — §4.3 keeps the draft track invisible, and a
    // distinguishable response would leak that the slug exists.
    if (isNotFound(error)) notFound();
    throw error;
  }

  const objectives = asStringList(course.learningObjectives);
  const prerequisites = asStringList(course.prerequisites);

  return (
    <main className="wide-main">
      <p className="text-xs uppercase tracking-wide text-neutral-500">
        <Link href={`/categories/${course.categorySlug}`} className="hover:underline">
          {course.categoryName}
        </Link>{' '}
        · {course.levelLabel}
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{course.title}</h1>
      {course.overviewSummary ? (
        <p className="mt-3 text-neutral-700">{course.overviewSummary}</p>
      ) : null}

      {objectives.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-medium">Mục tiêu</h2>
          <ul className="mt-2 list-disc pl-5 text-neutral-700">
            {objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {prerequisites.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-medium">Yêu cầu trước khi học</h2>
          <ul className="mt-2 list-disc pl-5 text-neutral-700">
            {prerequisites.map((prerequisite) => (
              <li key={prerequisite}>{prerequisite}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        The price block queries the real products table and renders only when an
        active row exists. P8 inserts products and this appears with no change
        here; a paid course with no product shows the locked note below instead.
      */}
      {course.singleCourseOffer || course.bundleOffer ? (
        <section className="mt-6 space-y-3" data-testid="price-block">
          {course.singleCourseOffer ? (
            <div className="rounded border border-neutral-300 p-4">
              <h2 className="font-medium">{course.singleCourseOffer.displayName}</h2>
              <p className="mt-1 text-lg">{formatPrice(course.singleCourseOffer)}</p>
              <p className="mt-1 text-sm text-neutral-600">
                {course.singleCourseOffer.accessDurationDays} ngày truy cập
              </p>
            </div>
          ) : null}
          {course.bundleOffer ? (
            <div className="rounded border border-neutral-300 p-4" data-testid="bundle-offer">
              <h2 className="font-medium">{course.bundleOffer.displayName}</h2>
              <p className="mt-1 text-lg">{formatPrice(course.bundleOffer)}</p>
              <p className="mt-1 text-sm text-neutral-600">
                Trọn bộ {course.categoryName} · {course.bundleOffer.accessDurationDays} ngày truy cập
              </p>
            </div>
          ) : null}
        </section>
      ) : course.pricingType === 'paid' ? (
        <p className="mt-6 rounded border border-neutral-200 p-4 text-sm text-neutral-600" data-testid="not-for-sale">
          Khoá học này chưa mở bán.
        </p>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">Nội dung khoá học</h2>
      {course.structure ? (
        <ol className="mt-3 space-y-6" data-testid="course-toc">
          {course.structure.chapters.map((chapter) => (
            <li key={chapter.chapterId}>
              <h3 className="font-medium">{chapter.title}</h3>
              {chapter.description ? (
                <p className="mt-1 text-sm text-neutral-600">{chapter.description}</p>
              ) : null}
              <ol className="mt-2 space-y-1">
                {chapter.lessons.map((lesson) => (
                  <li key={lesson.lessonId} className="flex flex-wrap items-baseline gap-2">
                    <Link
                      href={`/lessons/${lesson.lessonId}`}
                      className="hover:underline"
                      data-testid="toc-lesson-link"
                    >
                      {lesson.title}
                    </Link>
                    {lesson.isFreePreview ? (
                      <span
                        className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
                        data-testid="free-preview-badge"
                      >
                        Học thử miễn phí
                      </span>
                    ) : null}
                    {lesson.hasAudio ? (
                      <span className="text-xs text-neutral-500">· có audio</span>
                    ) : null}
                    {lesson.estimatedMinutes ? (
                      <span className="text-xs text-neutral-500">· {lesson.estimatedMinutes} phút</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-neutral-600">Nội dung đang được cập nhật.</p>
      )}
    </main>
  );
}
