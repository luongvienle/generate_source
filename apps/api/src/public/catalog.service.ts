import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { errorCodes, structurePayloadSchema, type StructurePayload } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §9.4's catalog: `/categories`, `/categories/:slug`, `/courses`,
 * `/courses/:slug`.
 *
 * THE PUBLISHED FILTER IS THE WHOLE CONTRACT. §4.3 promises learners never see
 * half-edited content, and on this surface that reduces to one predicate —
 * `publication_status = 'published'` — applied everywhere a course is listed or
 * resolved. The single exception is FR-CAT-02's "in development" levels on a
 * category page, which name an unpublished course's TITLE and LEVEL LABEL and
 * nothing else; see `categoryBySlug`.
 *
 * No draft column is selected anywhere in this file.
 */

const PUBLISHED = 'published';

/** FR-CAT-01: "Results are paginated." */
const DEFAULT_PAGE_SIZE = 12;
export const MAX_PAGE_SIZE = 50;

export interface PriceView {
  readonly productId: string;
  readonly productType: string;
  readonly displayName: string;
  /**
   * Decimal(12,2) as a string.
   *
   * Money is never a JavaScript number: 12 significant digits do not survive a
   * float, and the column is Decimal precisely so they do not have to.
   */
  readonly priceAmount: string;
  readonly currencyCode: string;
  readonly accessDurationDays: number;
}

export interface CourseCardView {
  readonly slug: string;
  readonly title: string;
  readonly levelLabel: string;
  readonly levelOrder: number;
  readonly overviewSummary: string | null;
  readonly coverImageUrl: string | null;
  readonly estimatedTotalMinutes: number | null;
  readonly pricingType: string;
  readonly categorySlug: string;
  readonly categoryName: string;
}

export interface CategoryCardView {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly coverImageUrl: string | null;
  readonly publishedCourseCount: number;
}

/** FR-CAT-02: every level, with the unpublished ones marked and unlinked. */
export interface CategoryLevelView {
  readonly title: string;
  readonly levelLabel: string;
  readonly levelOrder: number;
  readonly isPublished: boolean;
  /** Null for a level still in development — there is nothing to link to. */
  readonly slug: string | null;
}

export interface CategoryPageView {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly coverImageUrl: string | null;
  readonly levels: readonly CategoryLevelView[];
  readonly bundleOffer: PriceView | null;
}

export interface CoursePageView {
  readonly slug: string;
  readonly title: string;
  readonly levelLabel: string;
  readonly overviewSummary: string | null;
  readonly prerequisites: unknown;
  readonly learningObjectives: unknown;
  readonly estimatedTotalMinutes: number | null;
  readonly coverImageUrl: string | null;
  readonly languageCode: string;
  readonly pricingType: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  readonly structure: StructurePayload | null;
  readonly singleCourseOffer: PriceView | null;
  readonly bundleOffer: PriceView | null;
}

export interface CatalogPageView {
  readonly courses: readonly CourseCardView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

const toPriceView = (product: {
  id: string;
  productType: string;
  displayName: string;
  priceAmount: { toString(): string };
  currencyCode: string;
  accessDurationDays: number;
}): PriceView => ({
  productId: product.id,
  productType: product.productType,
  displayName: product.displayName,
  priceAmount: product.priceAmount.toString(),
  currencyCode: product.currencyCode,
  accessDurationDays: product.accessDurationDays,
});

const productSelect = {
  id: true,
  productType: true,
  displayName: true,
  priceAmount: true,
  currencyCode: true,
  accessDurationDays: true,
} as const;

@Injectable()
export class CatalogService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** FR-CAT-01's grouping level: categories with a count of what is buyable. */
  async categories(): Promise<readonly CategoryCardView[]> {
    const rows = await this.prisma.client.category.findMany({
      orderBy: { displayOrder: 'asc' },
      select: {
        slug: true,
        displayName: true,
        description: true,
        coverImageUrl: true,
        _count: { select: { courses: { where: { publicationStatus: PUBLISHED } } } },
      },
    });

    // A category with nothing published is not a catalog entry. Its levels are
    // all "in development", so listing it would advertise an empty shelf.
    return rows
      .filter((row) => row._count.courses > 0)
      .map((row) => ({
        slug: row.slug,
        displayName: row.displayName,
        description: row.description,
        coverImageUrl: row.coverImageUrl,
        publishedCourseCount: row._count.courses,
      }));
  }

  /**
   * FR-CAT-02's category page.
   *
   * This is the ONE place an unpublished course is named to a learner, and §5.8
   * is explicit about it: "Unpublished levels are shown as 'in development' with
   * no link." Only `title`, `levelLabel` and `levelOrder` are read for those
   * rows — no overview, no cover, no slug, and nothing that would resolve to
   * content.
   */
  async categoryBySlug(slug: string): Promise<CategoryPageView> {
    const category = await this.prisma.client.category.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        displayName: true,
        description: true,
        coverImageUrl: true,
        courses: {
          orderBy: { levelOrder: 'asc' },
          select: { slug: true, title: true, levelLabel: true, levelOrder: true, publicationStatus: true },
        },
      },
    });
    if (!category) throw new NotFoundException({ errorCode: 'CATEGORY_NOT_FOUND' });

    const bundle = await this.prisma.client.product.findFirst({
      where: { categoryId: category.id, productType: 'category_bundle', isActive: true },
      select: productSelect,
    });

    return {
      slug: category.slug,
      displayName: category.displayName,
      description: category.description,
      coverImageUrl: category.coverImageUrl,
      levels: category.courses
        // `archived` is hidden everywhere (§4.2), including here: it is not a
        // level in development, it is a level that is gone.
        .filter((course) => course.publicationStatus !== 'archived')
        .map((course) => {
          const isPublished = course.publicationStatus === PUBLISHED;
          return {
            title: course.title,
            levelLabel: course.levelLabel,
            levelOrder: course.levelOrder,
            isPublished,
            slug: isPublished ? course.slug : null,
          };
        }),
      bundleOffer: bundle ? toPriceView(bundle) : null,
    };
  }

  /**
   * FR-CAT-01's catalog listing.
   *
   * Search is case-insensitive substring matching across the three fields §5.8
   * names — course title, category name, overview summary. Not full-text:
   * Postgres ships no Vietnamese text-search configuration, so `simple` would
   * stem nothing and reduce to roughly this anyway, at the cost of a migration
   * and a generated column. Revisit when the catalog outgrows a few hundred rows.
   */
  async courses(options: {
    search?: string;
    categorySlug?: string;
    page: number;
    pageSize: number;
  }): Promise<CatalogPageView> {
    const term = options.search?.trim();
    const where = {
      publicationStatus: PUBLISHED,
      ...(options.categorySlug ? { category: { slug: options.categorySlug } } : {}),
      ...(term
        ? {
            OR: [
              { title: { contains: term, mode: 'insensitive' as const } },
              { overviewSummary: { contains: term, mode: 'insensitive' as const } },
              { category: { displayName: { contains: term, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.client.course.count({ where }),
      this.prisma.client.course.findMany({
        where,
        orderBy: [{ category: { displayOrder: 'asc' } }, { levelOrder: 'asc' }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
        select: {
          slug: true,
          title: true,
          levelLabel: true,
          levelOrder: true,
          overviewSummary: true,
          coverImageUrl: true,
          estimatedTotalMinutes: true,
          pricingType: true,
          category: { select: { slug: true, displayName: true } },
        },
      }),
    ]);

    return {
      courses: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        levelLabel: row.levelLabel,
        levelOrder: row.levelOrder,
        overviewSummary: row.overviewSummary,
        coverImageUrl: row.coverImageUrl,
        estimatedTotalMinutes: row.estimatedTotalMinutes,
        pricingType: row.pricingType,
        categorySlug: row.category.slug,
        categoryName: row.category.displayName,
      })),
      total,
      page: options.page,
      pageSize: options.pageSize,
    };
  }

  /**
   * FR-CAT-03's course page.
   *
   * Metadata comes from `courses` and the table of contents from the SNAPSHOT,
   * per §9.4. They are deliberately different sources: P6 kept course metadata
   * out of `structure_payload` so the two copies cannot drift between publishes,
   * and §4.3 keeps the snapshot small regardless of lesson count.
   *
   * A course that is not published 404s rather than 403s — a draft course's slug
   * is not public information, so the two cases are indistinguishable from
   * outside.
   */
  async courseBySlug(slug: string): Promise<CoursePageView> {
    const course = await this.prisma.client.course.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        title: true,
        levelLabel: true,
        overviewSummary: true,
        prerequisites: true,
        learningObjectives: true,
        estimatedTotalMinutes: true,
        coverImageUrl: true,
        languageCode: true,
        pricingType: true,
        publicationStatus: true,
        categoryId: true,
        category: { select: { slug: true, displayName: true } },
        publishedStructure: { select: { structurePayload: true } },
      },
    });
    if (!course || course.publicationStatus !== PUBLISHED) {
      throw new NotFoundException({ errorCode: errorCodes.COURSE_NOT_PUBLISHED });
    }

    const [single, bundle] = await Promise.all([
      this.prisma.client.product.findFirst({
        where: { courseId: course.id, productType: 'single_course', isActive: true },
        select: productSelect,
      }),
      this.prisma.client.product.findFirst({
        where: { categoryId: course.categoryId, productType: 'category_bundle', isActive: true },
        select: productSelect,
      }),
    ]);

    const parsed = course.publishedStructure
      ? structurePayloadSchema.safeParse(course.publishedStructure.structurePayload)
      : null;

    return {
      slug: course.slug,
      title: course.title,
      levelLabel: course.levelLabel,
      overviewSummary: course.overviewSummary,
      prerequisites: course.prerequisites,
      learningObjectives: course.learningObjectives,
      estimatedTotalMinutes: course.estimatedTotalMinutes,
      coverImageUrl: course.coverImageUrl,
      languageCode: course.languageCode,
      pricingType: course.pricingType,
      categorySlug: course.category.slug,
      categoryName: course.category.displayName,
      structure: parsed?.success ? parsed.data : null,
      singleCourseOffer: single ? toPriceView(single) : null,
      bundleOffer: bundle ? toPriceView(bundle) : null,
    };
  }

  /** Every published slug, for `generateStaticParams` (NFR-01). */
  async publishedCourseSlugs(): Promise<readonly string[]> {
    const rows = await this.prisma.client.course.findMany({
      where: { publicationStatus: PUBLISHED },
      select: { slug: true },
    });
    return rows.map((row) => row.slug);
  }
}

export { DEFAULT_PAGE_SIZE };
