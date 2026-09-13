import Link from 'next/link';
import { isSignedIn, serverApiFetch } from '../../../lib/server-api';

/**
 * §9.4's `/me/courses` — FR-LRN-02's resume and FR-LRN-03's progress.
 *
 * Per-learner, so never cached.
 */
export const dynamic = 'force-dynamic';

interface MyCourseView {
  courseSlug: string;
  courseTitle: string;
  levelLabel: string;
  categoryName: string;
  categorySlug: string;
  completedLessonCount: number;
  totalLessonCount: number;
  progressPercentage: number;
  expiresAt: string | null;
  daysRemaining: number | null;
  isExpired: boolean;
  resumeLessonId: string | null;
  resumeLessonTitle: string | null;
}

export default async function MyCoursesPage() {
  if (!(await isSignedIn())) {
    return (
      <main className="wide-main">
        <h1 className="text-2xl font-semibold">Khoá của tôi</h1>
        <p className="mt-4 text-neutral-700" data-testid="my-courses-signin">
          <Link href="/signin" className="underline">
            Đăng nhập
          </Link>{' '}
          để xem các khoá học bạn đã mua và tiến độ của bạn.
        </p>
      </main>
    );
  }

  const courses = await serverApiFetch<MyCourseView[]>('/me/courses', { cache: 'no-store' }).catch(
    () => [] as MyCourseView[],
  );

  return (
    <main className="wide-main">
      <h1 className="text-2xl font-semibold">Khoá của tôi</h1>

      {courses.length === 0 ? (
        <p className="mt-4 text-neutral-700" data-testid="my-courses-empty">
          Bạn chưa có khoá học nào.{' '}
          <Link href="/" className="underline">
            Xem danh mục khoá học
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-6 space-y-4" data-testid="my-courses-list">
          {courses.map((course) => (
            <li
              key={course.courseSlug}
              className="rounded border border-neutral-200 p-4"
              data-testid="my-course"
              data-course-slug={course.courseSlug}
              data-expired={course.isExpired ? 'true' : 'false'}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-xs uppercase tracking-wide text-neutral-500">
                  {course.categoryName} · {course.levelLabel}
                </p>
                {/*
                  §7.4: "An expired course stays visible in My courses with an
                  expired badge, its progress percentage, and a repurchase
                  action. It is not hidden." The progress below is the reason a
                  learner renews, so hiding the row would remove the argument.
                */}
                {course.isExpired ? (
                  <span
                    className="rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-800"
                    data-testid="expired-badge"
                  >
                    Đã hết hạn
                  </span>
                ) : course.daysRemaining !== null ? (
                  <span className="text-xs text-neutral-500">
                    Còn {course.daysRemaining} ngày
                  </span>
                ) : null}
              </div>

              <h2 className="mt-1 text-lg font-medium">
                <Link href={`/courses/${course.courseSlug}`} className="hover:underline">
                  {course.courseTitle}
                </Link>
              </h2>

              <p className="mt-2 text-sm text-neutral-600" data-testid="course-progress">
                Hoàn thành {course.completedLessonCount}/{course.totalLessonCount} bài ·{' '}
                {course.progressPercentage}%
              </p>
              <div
                className="mt-2 h-2 w-full overflow-hidden rounded bg-neutral-200"
                role="progressbar"
                aria-valuenow={course.progressPercentage}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full bg-neutral-800"
                  style={{ width: `${course.progressPercentage}%` }}
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-3">
                {course.isExpired ? (
                  /*
                    The repurchase action is the course page's price block,
                    which renders once an active product exists. P8 builds
                    checkout; until then this is the honest destination.
                  */
                  <Link
                    href={`/courses/${course.courseSlug}`}
                    className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
                    data-testid="repurchase"
                  >
                    Gia hạn truy cập
                  </Link>
                ) : course.resumeLessonId ? (
                  <Link
                    href={`/lessons/${course.resumeLessonId}`}
                    className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
                    data-testid="resume"
                  >
                    Tiếp tục: {course.resumeLessonTitle ?? 'bài đang học'}
                  </Link>
                ) : (
                  <Link
                    href={`/courses/${course.courseSlug}`}
                    className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
                    data-testid="start"
                  >
                    Bắt đầu học
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
