import { BadRequestException, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  CatalogService,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type CatalogPageView,
  type CategoryCardView,
  type CategoryPageView,
  type CoursePageView,
} from './catalog.service';

/**
 * §9.4's catalog endpoints — anonymous, read-only, published-only.
 *
 * No guard and no `@RequirePermission`, for the reason spelled out on
 * PublicLessonsController: §9.4 describes a public surface, and
 * `entitlement-gates.e2e-spec.ts` holds that decision under test. Unlike the
 * reader, nothing here is entitlement-gated either — a catalog that required a
 * grant would have nothing to sell.
 */

/**
 * Query strings are strings. zod coerces the two numeric params rather than the
 * controller parsing them by hand, and `strictObject` refuses an unknown param
 * so a typo'd filter fails loudly instead of silently listing everything.
 */
const catalogQuerySchema = z.strictObject({
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  // Bounded: an unbounded pageSize is a way to ask the database for everything.
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

@Controller()
export class PublicCatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('categories')
  categories(): Promise<readonly CategoryCardView[]> {
    return this.catalog.categories();
  }

  @Get('categories/:slug')
  categoryBySlug(@Param('slug') slug: string): Promise<CategoryPageView> {
    return this.catalog.categoryBySlug(slug);
  }

  @Get('courses')
  courses(@Query() query: unknown): Promise<CatalogPageView> {
    const parsed = catalogQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });

    return this.catalog.courses({
      search: parsed.data.search,
      categorySlug: parsed.data.category,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  }

  @Get('courses/:slug')
  courseBySlug(@Param('slug') slug: string): Promise<CoursePageView> {
    return this.catalog.courseBySlug(slug);
  }
}
