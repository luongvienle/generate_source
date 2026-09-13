import type { StructurePayload } from '@knowledge-explorer/shared';

/**
 * The §9.4 response shapes this app reads.
 *
 * Written out rather than imported from `apps/api`: §11 makes the API a
 * separate deployable and no app imports another. They mirror
 * `apps/api/src/public/catalog.service.ts`, and the browser suite is what keeps
 * the two honest — a field renamed on one side fails a rendering assertion on
 * the other rather than a type check.
 */

export interface PriceView {
  productId: string;
  productType: string;
  displayName: string;
  /** Decimal(12,2) as a string. Never parse it into a number. */
  priceAmount: string;
  currencyCode: string;
  accessDurationDays: number;
}

export interface CourseCardView {
  slug: string;
  title: string;
  levelLabel: string;
  levelOrder: number;
  overviewSummary: string | null;
  coverImageUrl: string | null;
  estimatedTotalMinutes: number | null;
  pricingType: string;
  categorySlug: string;
  categoryName: string;
}

export interface CatalogPageView {
  courses: CourseCardView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CategoryCardView {
  slug: string;
  displayName: string;
  description: string | null;
  coverImageUrl: string | null;
  publishedCourseCount: number;
}

export interface CategoryLevelView {
  title: string;
  levelLabel: string;
  levelOrder: number;
  isPublished: boolean;
  /** Null while the level is in development — there is nothing to link to. */
  slug: string | null;
}

export interface CategoryPageView {
  slug: string;
  displayName: string;
  description: string | null;
  coverImageUrl: string | null;
  levels: CategoryLevelView[];
  bundleOffer: PriceView | null;
}

export interface CoursePageView {
  slug: string;
  title: string;
  levelLabel: string;
  overviewSummary: string | null;
  prerequisites: unknown;
  learningObjectives: unknown;
  estimatedTotalMinutes: number | null;
  coverImageUrl: string | null;
  languageCode: string;
  pricingType: string;
  categorySlug: string;
  categoryName: string;
  structure: StructurePayload | null;
  singleCourseOffer: PriceView | null;
  bundleOffer: PriceView | null;
}

/** §8 stores prerequisites and objectives as JSONB; both are string arrays. */
export const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Money for display. Decimal(12,2) arrives as a string and stays one — the
 * formatter reads it, nothing parses it into a float.
 */
export const formatPrice = (price: PriceView): string =>
  `${new Intl.NumberFormat('vi-VN').format(Number(price.priceAmount))} ${price.currencyCode}`;
