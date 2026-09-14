import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  commerceWarningCodes,
  errorCodes,
  revalidateLearnerPages,
  type ProductType,
} from '@knowledge-explorer/shared';
import type { PrismaClient } from '@knowledge-explorer/database';
import { PrismaService } from '../prisma/prisma.service';
import { fromHundredths, toHundredths } from './money';

/**
 * FR-COM-01 — the owner's products (specs/p8a-commerce/spec.md, "Products").
 *
 * `courses.pricing_type` is the access policy and price lives here, never in
 * two places (§7.1). At most one active product per course and one per category
 * is §8's partial unique index; this service reports it as a 409 rather than
 * letting a P2002 surface as a 500.
 */

/** Picker options are bounded and searchable: the development database holds thousands of courses. */
export const MAX_TARGET_OPTIONS = 50;

const PUBLISHED = 'published';
const SINGLE_COURSE: ProductType = 'single_course';
const CATEGORY_BUNDLE: ProductType = 'category_bundle';

export interface ProductTargetView {
  readonly scopeType: 'course' | 'category';
  readonly courseId: string | null;
  readonly courseTitle: string | null;
  readonly courseSlug: string | null;
  readonly coursePublicationStatus: string | null;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly categorySlug: string;
}

export interface ProductView {
  readonly productId: string;
  readonly productType: ProductType;
  readonly displayName: string;
  /** Decimal(12,2) as a string; never a JavaScript number. */
  readonly priceAmount: string;
  readonly currencyCode: string;
  readonly accessDurationDays: number;
  readonly gracePeriodDays: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly target: ProductTargetView;
}

export interface PriceCheckView {
  readonly bundlePriceAmount: string;
  readonly sumOfSinglePriceAmounts: string;
  readonly isBelowSum: boolean;
  readonly includedCourses: ReadonlyArray<{ courseId: string; title: string; priceAmount: string }>;
  readonly coursesWithoutSingleProduct: ReadonlyArray<{ courseId: string; title: string }>;
}

export interface NotForSaleCourse {
  readonly courseId: string;
  readonly title: string;
  readonly slug: string;
}

export type ProductWarning =
  | { readonly code: typeof commerceWarningCodes.BUNDLE_PRICE_NOT_BELOW_SUM; readonly priceCheck: PriceCheckView }
  | { readonly code: typeof commerceWarningCodes.COURSE_NOT_FOR_SALE; readonly courses: readonly NotForSaleCourse[] };

/** FR-COM-01: "Saving warns, without blocking" — so a save always returns the product. */
export interface ProductSaveView {
  readonly product: ProductView;
  readonly warnings: readonly ProductWarning[];
}

export interface CourseOption {
  readonly id: string;
  readonly title: string;
  readonly levelLabel: string;
  readonly publicationStatus: string;
  readonly categoryName: string;
}

export interface CategoryOption {
  readonly id: string;
  readonly displayName: string;
  readonly slug: string;
}

export interface ProductListView {
  readonly items: readonly ProductView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly courseOptions: readonly CourseOption[];
  readonly categoryOptions: readonly CategoryOption[];
}

export interface ProductListQuery {
  readonly courseId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly includeInactive: boolean;
  readonly targetSearch?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

interface ProductTerms {
  readonly displayName: string;
  readonly priceAmount: string;
  readonly accessDurationDays: number;
  readonly gracePeriodDays: number;
}

/** §9.2's four editable fields. Type, target and display name are fixed at creation. */
export interface UpdateProductInput {
  readonly priceAmount?: string | undefined;
  readonly accessDurationDays?: number | undefined;
  readonly gracePeriodDays?: number | undefined;
  readonly isActive?: boolean | undefined;
}

export type CreateProductInput =
  | (ProductTerms & { readonly productType: 'single_course'; readonly courseId: string })
  | (ProductTerms & { readonly productType: 'category_bundle'; readonly categoryId: string });

const CATEGORY_SELECT = { select: { id: true, displayName: true, slug: true } } as const;

const PRODUCT_SELECT = {
  id: true,
  productType: true,
  displayName: true,
  priceAmount: true,
  currencyCode: true,
  accessDurationDays: true,
  gracePeriodDays: true,
  isActive: true,
  createdAt: true,
  courseId: true,
  categoryId: true,
  course: {
    select: { id: true, title: true, slug: true, publicationStatus: true, category: CATEGORY_SELECT },
  },
  category: CATEGORY_SELECT,
} as const;

type ProductRow = {
  id: string;
  productType: string;
  displayName: string;
  priceAmount: { toString(): string };
  currencyCode: string;
  accessDurationDays: number;
  gracePeriodDays: number;
  isActive: boolean;
  createdAt: Date;
  courseId: string | null;
  categoryId: string | null;
  course: {
    id: string;
    title: string;
    slug: string;
    publicationStatus: string;
    category: { id: string; displayName: string; slug: string };
  } | null;
  category: { id: string; displayName: string; slug: string } | null;
};

export function toProductView(row: ProductRow): ProductView {
  // The CHECK constraint guarantees exactly one of course and category is set.
  const category = row.course ? row.course.category : row.category!;
  return {
    productId: row.id,
    productType: row.productType as ProductType,
    displayName: row.displayName,
    priceAmount: row.priceAmount.toString(),
    currencyCode: row.currencyCode,
    accessDurationDays: row.accessDurationDays,
    gracePeriodDays: row.gracePeriodDays,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    target: {
      scopeType: row.course ? 'course' : 'category',
      courseId: row.course?.id ?? null,
      courseTitle: row.course?.title ?? null,
      courseSlug: row.course?.slug ?? null,
      coursePublicationStatus: row.course?.publicationStatus ?? null,
      categoryId: category.id,
      categoryName: category.displayName,
      categorySlug: category.slug,
    },
  };
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'P2002';

@Injectable()
export class ProductsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(query: ProductListQuery): Promise<ProductListView> {
    const where = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      // A category's products are its bundle AND the single products of its courses.
      ...(query.categoryId
        ? { OR: [{ categoryId: query.categoryId }, { course: { categoryId: query.categoryId } }] }
        : {}),
    };
    const search = query.targetSearch;

    const [rows, total, courseOptions, categoryOptions] = await Promise.all([
      this.prisma.client.product.findMany({
        where,
        select: PRODUCT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.client.product.count({ where }),
      this.prisma.client.course.findMany({
        where: search ? { title: { contains: search, mode: 'insensitive' } } : {},
        select: {
          id: true,
          title: true,
          levelLabel: true,
          publicationStatus: true,
          category: { select: { displayName: true } },
        },
        // Newest first: the course being priced is usually the one just imported.
        orderBy: { createdAt: 'desc' },
        take: MAX_TARGET_OPTIONS,
      }),
      this.prisma.client.category.findMany({
        where: search ? { displayName: { contains: search, mode: 'insensitive' } } : {},
        select: { id: true, displayName: true, slug: true },
        // Categories carry no created_at; §8 orders them by display_order.
        orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }],
        take: MAX_TARGET_OPTIONS,
      }),
    ]);

    return {
      items: rows.map(toProductView),
      total,
      page: query.page,
      pageSize: query.pageSize,
      courseOptions: courseOptions.map((course) => ({
        id: course.id,
        title: course.title,
        levelLabel: course.levelLabel,
        publicationStatus: course.publicationStatus,
        categoryName: course.category.displayName,
      })),
      categoryOptions,
    };
  }

  async create(input: CreateProductInput, createdByUserId: string): Promise<ProductSaveView> {
    const target =
      input.productType === 'single_course'
        ? await this.requireCourse(input.courseId)
        : await this.requireCategory(input.categoryId);

    const targetWhere =
      input.productType === 'single_course'
        ? { productType: SINGLE_COURSE, courseId: input.courseId }
        : { productType: CATEGORY_BUNDLE, categoryId: input.categoryId };

    await this.refuseIfActive(targetWhere);

    let row: ProductRow;
    try {
      row = await this.prisma.client.product.create({
        data: {
          productType: input.productType,
          ...(input.productType === 'single_course'
            ? { courseId: input.courseId }
            : { categoryId: input.categoryId }),
          displayName: input.displayName,
          priceAmount: input.priceAmount,
          accessDurationDays: input.accessDurationDays,
          gracePeriodDays: input.gracePeriodDays,
          createdByUserId,
        },
        select: PRODUCT_SELECT,
      });
    } catch (error) {
      // Two owners saving at once: the partial unique index is the real guard and
      // the pre-check above only makes the common case readable.
      if (isUniqueViolation(error)) await this.refuseIfActive(targetWhere);
      throw error;
    }

    const warnings: ProductWarning[] = [];
    if (input.productType === CATEGORY_BUNDLE) {
      const priceCheck = await this.bundlePriceCheck(target.id, row.priceAmount.toString());
      if (!priceCheck.isBelowSum) {
        warnings.push({ code: commerceWarningCodes.BUNDLE_PRICE_NOT_BELOW_SUM, priceCheck });
      }
    }

    const product = toProductView(row);
    await this.revalidateFor(product);
    return { product, warnings };
  }

  /**
   * §9.2's PATCH: "Change price, duration, grace period, active flag" — and
   * nothing else. The controller refuses every other field.
   *
   * A change applies to later checkouts. Duration and grace are read from this
   * row when a webhook arrives, so a pending order paid after this edit receives
   * the new values; the order's amount does not change, and existing grants carry
   * their own `grace_period_days` and are untouched.
   *
   * COURSE_NOT_FOR_SALE IS A BEFORE/AFTER DIFF, in the same transaction as the
   * write. A product only affects its own category — a single product covers one
   * course, a bundle covers every course in it — so coverage is computed for that
   * category before and after, and only courses that moved from covered to
   * uncovered are named. A course that was already unsellable does not re-warn
   * on every later save.
   */
  async update(productId: string, input: UpdateProductInput): Promise<ProductSaveView> {
    const { row, lostCourses } = await this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({
        where: { id: productId },
        select: {
          productType: true,
          courseId: true,
          categoryId: true,
          isActive: true,
          course: { select: { categoryId: true } },
        },
      });
      if (!existing) throw new NotFoundException({ errorCode: errorCodes.PRODUCT_NOT_FOUND });

      // The CHECK constraint guarantees one of the two is set.
      const categoryId = existing.categoryId ?? existing.course!.categoryId;
      const before = await this.saleCoverage(tx, categoryId);

      if (input.isActive === true && !existing.isActive) {
        const other = await tx.product.findFirst({
          where: {
            id: { not: productId },
            isActive: true,
            productType: existing.productType,
            ...(existing.courseId
              ? { courseId: existing.courseId }
              : { categoryId: existing.categoryId }),
          },
          select: { id: true },
        });
        if (other) {
          throw new ConflictException({
            errorCode: errorCodes.PRODUCT_ALREADY_ACTIVE,
            productId: other.id,
          });
        }
      }

      let updated: ProductRow;
      try {
        updated = await tx.product.update({
          where: { id: productId },
          data: input,
          select: PRODUCT_SELECT,
        });
      } catch (error) {
        // A concurrent reactivation won the partial unique index. The
        // transaction is aborted, so the winner's id cannot be read here.
        if (isUniqueViolation(error)) {
          throw new ConflictException({ errorCode: errorCodes.PRODUCT_ALREADY_ACTIVE });
        }
        throw error;
      }

      const after = new Map(
        (await this.saleCoverage(tx, categoryId)).map((course) => [course.courseId, course.covered]),
      );
      const lost = before
        .filter((course) => course.covered && !after.get(course.courseId))
        .map(({ courseId, title, slug }) => ({ courseId, title, slug }));

      return { row: updated, lostCourses: lost };
    });

    const warnings: ProductWarning[] = [];
    if (lostCourses.length > 0) {
      warnings.push({ code: commerceWarningCodes.COURSE_NOT_FOR_SALE, courses: lostCourses });
    }
    if (row.productType === CATEGORY_BUNDLE && row.isActive && row.categoryId) {
      const priceCheck = await this.bundlePriceCheck(row.categoryId, row.priceAmount.toString());
      if (!priceCheck.isBelowSum) {
        warnings.push({ code: commerceWarningCodes.BUNDLE_PRICE_NOT_BELOW_SUM, priceCheck });
      }
    }

    const product = toProductView(row);
    await this.revalidateFor(product);
    return { product, warnings };
  }

  /**
   * Which published, paid courses in a category an active product covers: its
   * own single product, or the category's bundle. Free and unpublished courses
   * need no product and are never "not for sale".
   */
  private async saleCoverage(
    db: Pick<PrismaClient, 'course' | 'product'>,
    categoryId: string,
  ): Promise<Array<NotForSaleCourse & { covered: boolean }>> {
    const bundle = await db.product.findFirst({
      where: { categoryId, productType: CATEGORY_BUNDLE, isActive: true },
      select: { id: true },
    });
    const courses = await db.course.findMany({
      where: { categoryId, publicationStatus: PUBLISHED, pricingType: 'paid' },
      orderBy: { levelOrder: 'asc' },
      select: {
        id: true,
        title: true,
        slug: true,
        products: {
          where: { productType: SINGLE_COURSE, isActive: true },
          select: { id: true },
          take: 1,
        },
      },
    });
    return courses.map((course) => ({
      courseId: course.id,
      title: course.title,
      slug: course.slug,
      covered: bundle !== null || course.products.length > 0,
    }));
  }

  /** FR-COM-01's price-check, for a bundle. */
  async priceCheck(productId: string): Promise<PriceCheckView> {
    const product = await this.prisma.client.product.findUnique({
      where: { id: productId },
      select: { productType: true, categoryId: true, priceAmount: true },
    });
    if (!product) throw new NotFoundException({ errorCode: errorCodes.PRODUCT_NOT_FOUND });
    if (product.productType !== CATEGORY_BUNDLE || !product.categoryId) {
      throw new BadRequestException({ errorCode: errorCodes.PRICE_CHECK_NOT_BUNDLE });
    }
    return this.bundlePriceCheck(product.categoryId, product.priceAmount.toString());
  }

  /**
   * "When a bundle price is greater than or equal to the sum of its courses'
   * single prices" (FR-COM-01), over the category's PUBLISHED courses.
   *
   * A published course with no active single product is left out of the sum and
   * listed, rather than counted as zero or refusing the check: the owner sees
   * which course the comparison could not price. With nothing included the sum is
   * 0 and any price is "not below" it, which is the rule's arithmetic, not a
   * special case.
   */
  async bundlePriceCheck(categoryId: string, bundlePriceAmount: string): Promise<PriceCheckView> {
    const courses = await this.prisma.client.course.findMany({
      where: { categoryId, publicationStatus: PUBLISHED },
      orderBy: { levelOrder: 'asc' },
      select: {
        id: true,
        title: true,
        products: {
          where: { productType: SINGLE_COURSE, isActive: true },
          select: { priceAmount: true },
          take: 1,
        },
      },
    });

    let sum = BigInt(0);
    const includedCourses: Array<{ courseId: string; title: string; priceAmount: string }> = [];
    const coursesWithoutSingleProduct: Array<{ courseId: string; title: string }> = [];

    for (const course of courses) {
      const single = course.products[0];
      if (!single) {
        coursesWithoutSingleProduct.push({ courseId: course.id, title: course.title });
        continue;
      }
      sum += toHundredths(single.priceAmount);
      includedCourses.push({
        courseId: course.id,
        title: course.title,
        priceAmount: single.priceAmount.toString(),
      });
    }

    return {
      bundlePriceAmount: fromHundredths(toHundredths(bundlePriceAmount)),
      sumOfSinglePriceAmounts: fromHundredths(sum),
      isBelowSum: toHundredths(bundlePriceAmount) < sum,
      includedCourses,
      coursesWithoutSingleProduct,
    };
  }

  /**
   * A product write changes what the learner pages render, and both pages sit
   * behind a 300-second ISR window. This is P7's publish-hook rule applied to the
   * other thing those pages show.
   *
   * A single product appears on its course page; a bundle appears on its category
   * page AND on every published course page in that category. Best effort, as
   * everywhere: `revalidateLearnerPages` swallows every failure, and the save has
   * already been written.
   */
  async revalidateFor(product: ProductView): Promise<void> {
    if (product.target.scopeType === 'course') {
      await revalidateLearnerPages({
        courseSlug: product.target.courseSlug,
        categorySlug: product.target.categorySlug,
      });
      return;
    }

    const courses = await this.prisma.client.course.findMany({
      where: { categoryId: product.target.categoryId, publicationStatus: PUBLISHED },
      select: { slug: true },
    });
    await Promise.all([
      revalidateLearnerPages({ categorySlug: product.target.categorySlug }),
      ...courses.map((course) => revalidateLearnerPages({ courseSlug: course.slug })),
    ]);
  }

  private async refuseIfActive(where: {
    productType: ProductType;
    courseId?: string;
    categoryId?: string;
  }): Promise<void> {
    const existing = await this.prisma.client.product.findFirst({
      where: { ...where, isActive: true },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        errorCode: errorCodes.PRODUCT_ALREADY_ACTIVE,
        productId: existing.id,
      });
    }
  }

  private async requireCourse(courseId: string): Promise<{ id: string }> {
    const course = await this.prisma.client.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) throw new NotFoundException({ errorCode: errorCodes.COURSE_NOT_FOUND });
    return course;
  }

  private async requireCategory(categoryId: string): Promise<{ id: string }> {
    const category = await this.prisma.client.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException({ errorCode: errorCodes.CATEGORY_NOT_FOUND });
    return category;
  }
}
