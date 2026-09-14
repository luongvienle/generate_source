import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, isNotFound } from '../../../lib/api';
import { formatPrice, type CategoryPageView } from '../../../lib/catalog-types';

/**
 * FR-CAT-02: the category landing page.
 *
 * NFR-01: statically generated and incrementally revalidated. The publish job
 * pushes an on-demand revalidation for the course's category as well as the
 * course, so this window is the backstop rather than the mechanism.
 */
export const revalidate = 300;

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  try {
    const categories = await apiFetch<{ slug: string }[]>('/categories', { cache: 'no-store' });
    return categories.map((category) => ({ slug: category.slug }));
  } catch {
    // As on the course page: a build with no API reachable pre-renders nothing
    // and falls back to on-demand rendering rather than failing the build.
    return [];
  }
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let category: CategoryPageView;
  try {
    category = await apiFetch<CategoryPageView>(`/categories/${slug}`, { revalidateSeconds: 300 });
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }

  return (
    <main className="wide-main">
      <h1 className="text-2xl font-semibold">{category.displayName}</h1>
      {category.description ? (
        <p className="mt-2 text-neutral-600">{category.description}</p>
      ) : null}

      {/*
        FR-CAT-02: "if a bundle product exists, the bundle offer". The block is
        absent rather than a placeholder when none does. The buy link carries no
        per-learner state, so this page stays ISR.
      */}
      {category.bundleOffer ? (
        <section className="mt-6 rounded border border-neutral-300 p-4" data-testid="bundle-offer">
          <h2 className="font-medium">{category.bundleOffer.displayName}</h2>
          <p className="mt-1 text-lg">{formatPrice(category.bundleOffer)}</p>
          <p className="mt-1 text-sm text-neutral-600">
            Trọn bộ {category.displayName} · {category.bundleOffer.accessDurationDays} ngày truy cập
          </p>
          <Link
            href={`/checkout/${category.bundleOffer.productId}`}
            className="mt-3 inline-block rounded bg-neutral-900 px-4 py-2 text-sm text-white"
            data-testid="buy-bundle"
          >
            Mua trọn bộ
          </Link>
        </section>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">Các cấp độ</h2>
      <ol className="mt-3 space-y-3" data-testid="category-levels">
        {category.levels.map((level) => (
          <li
            key={`${level.levelOrder}-${level.levelLabel}`}
            className="rounded border border-neutral-200 p-4"
            data-testid={level.isPublished ? 'level-published' : 'level-in-development'}
          >
            <p className="text-xs uppercase tracking-wide text-neutral-500">{level.levelLabel}</p>
            {/*
              §5.8: "Unpublished levels are shown as 'in development' with no
              link." The API sends no slug for those, so there is nothing to
              link to even by accident.
            */}
            {level.isPublished && level.slug ? (
              <h3 className="mt-1 text-lg">
                <Link href={`/courses/${level.slug}`} className="hover:underline">
                  {level.title}
                </Link>
              </h3>
            ) : (
              <h3 className="mt-1 text-lg text-neutral-500">
                {level.title}{' '}
                <span className="text-sm font-normal">· đang xây dựng</span>
              </h3>
            )}
          </li>
        ))}
      </ol>
    </main>
  );
}
