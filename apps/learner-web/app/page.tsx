import Link from 'next/link';
import { apiFetch } from '../lib/api';
import type { CatalogPageView } from '../lib/catalog-types';

/**
 * FR-CAT-01: the catalog.
 *
 * NFR-01 wants published pages statically generated or incrementally
 * revalidated. This one takes search and page from the query string, so it
 * renders per request and leans on the API response's own revalidate window
 * instead — the course and lesson pages are the ones that are genuinely static
 * (see `courses/[slug]`), and they are the ones a publish revalidates.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 12;

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const search = typeof params['q'] === 'string' ? params['q'] : '';
  const page = Number(typeof params['page'] === 'string' ? params['page'] : '1') || 1;

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (search.trim()) query.set('search', search.trim());

  const catalog = await apiFetch<CatalogPageView>(`/courses?${query.toString()}`, {
    cache: 'no-store',
  });

  const lastPage = Math.max(1, Math.ceil(catalog.total / catalog.pageSize));

  return (
    <main className="wide-main">
      <h1 className="text-2xl font-semibold">Khoá học</h1>

      <form method="get" className="mt-4 flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Tìm theo tên khoá, chủ đề hoặc mô tả"
          aria-label="Tìm khoá học"
          data-testid="catalog-search"
          className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2"
        />
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
          Tìm
        </button>
      </form>

      {catalog.courses.length === 0 ? (
        <p className="mt-8 text-neutral-600" data-testid="catalog-empty">
          {search
            ? `Không tìm thấy khoá học nào cho “${search}”.`
            : 'Chưa có khoá học nào được xuất bản.'}
        </p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="catalog-list">
          {catalog.courses.map((course) => (
            <li key={course.slug} className="rounded border border-neutral-200 p-4">
              <p className="text-xs uppercase tracking-wide text-neutral-500">
                <Link href={`/categories/${course.categorySlug}`} className="hover:underline">
                  {course.categoryName}
                </Link>{' '}
                · {course.levelLabel}
              </p>
              <h2 className="mt-1 text-lg font-medium">
                <Link href={`/courses/${course.slug}`} data-testid="catalog-course-link">
                  {course.title}
                </Link>
              </h2>
              {course.overviewSummary ? (
                <p className="mt-2 text-sm text-neutral-600">{course.overviewSummary}</p>
              ) : null}
              <p className="mt-3 text-sm text-neutral-500">
                {course.pricingType === 'free' ? 'Miễn phí' : 'Trả phí'}
                {course.estimatedTotalMinutes ? ` · ${course.estimatedTotalMinutes} phút` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      {lastPage > 1 ? (
        <nav className="mt-8 flex items-center gap-4" aria-label="Phân trang">
          {page > 1 ? (
            <Link
              href={{ pathname: '/', query: { ...(search ? { q: search } : {}), page: page - 1 } }}
              className="hover:underline"
            >
              ← Trang trước
            </Link>
          ) : null}
          <span className="text-sm text-neutral-500">
            Trang {page} / {lastPage}
          </span>
          {page < lastPage ? (
            <Link
              href={{ pathname: '/', query: { ...(search ? { q: search } : {}), page: page + 1 } }}
              className="hover:underline"
            >
              Trang sau →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}
