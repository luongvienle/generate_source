import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SUPPORTED_CURRENCY_CODE, VND_AMOUNT_PATTERN, errorCodes } from '@knowledge-explorer/shared';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../public/catalog.service';
import {
  ProductsService,
  type PriceCheckView,
  type ProductListView,
  type ProductSaveView,
} from './products.service';

/**
 * §9.2's product endpoints — FR-COM-01.
 *
 * Owner only: §3's `createProductsAndSetPrices` is true for `admin_owner` alone.
 * The endpoint declares the ACTION, never the role.
 *
 * `PublishedLockGuard` is absent and that is correct: R-01 forbids a non-owner
 * EDITING a published course, and pricing one is not an edit to its content —
 * besides which only the owner reaches this controller at all.
 */

/** `access_duration_days` and `grace_period_days` are INTEGER columns. */
const INT4_MAX = 2_147_483_647;

const productTerms = {
  displayName: z.string().trim().min(1).max(120),
  // Whole VND as digits: "1500.50" is refused, not rounded. VND has no minor unit.
  priceAmount: z.string().regex(VND_AMOUNT_PATTERN),
  accessDurationDays: z.int().min(1).max(INT4_MAX).default(365),
  gracePeriodDays: z.int().min(0).max(INT4_MAX).default(0),
  currencyCode: z.literal(SUPPORTED_CURRENCY_CODE).optional(),
};

/**
 * `renewalType` and `bundleInclusionPolicy` are deliberately absent, so
 * `strictObject` refuses them: §7.4 locks renewal to `manual` and §7.2 locks
 * bundles to `all_current_and_future`, and the column defaults write both.
 */
const createSchema = z.discriminatedUnion('productType', [
  z.strictObject({ productType: z.literal('single_course'), courseId: z.uuid(), ...productTerms }),
  z.strictObject({ productType: z.literal('category_bundle'), categoryId: z.uuid(), ...productTerms }),
]);

/**
 * §9.2: "Change price, duration, grace period, active flag". `productType`, the
 * target and `displayName` are fixed at creation, so `strictObject` refuses them
 * — to change what a product is, deactivate it and create another.
 */
const updateSchema = z
  .strictObject({
    priceAmount: productTerms.priceAmount.optional(),
    accessDurationDays: z.int().min(1).max(INT4_MAX).optional(),
    gracePeriodDays: z.int().min(0).max(INT4_MAX).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'nothing to change' });

const listQuerySchema = z.strictObject({
  courseId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
  /** Filters the target pickers, not the product list. */
  targetSearch: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const productIdSchema = z.uuid();

@Controller('admin/products')
@UseGuards(SessionGuard, RolesGuard)
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  @Get()
  @RequirePermission('createProductsAndSetPrices')
  list(@Query() query: unknown): Promise<ProductListView> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });
    return this.products.list(parsed.data);
  }

  @Post()
  @RequirePermission('createProductsAndSetPrices')
  create(@Body() body: unknown, @Req() request: RequestWithSession): Promise<ProductSaveView> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        errorCode: 'INVALID_BODY',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    // `currencyCode` is validated and dropped: the column default is the only value.
    const { currencyCode: _currency, ...input } = parsed.data;
    return this.products.create(input, this.userId(request));
  }

  @Patch(':productId')
  @RequirePermission('createProductsAndSetPrices')
  update(@Param('productId') productId: string, @Body() body: unknown): Promise<ProductSaveView> {
    this.requireProductId(productId);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        errorCode: 'INVALID_BODY',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return this.products.update(productId, parsed.data);
  }

  @Get(':productId/price-check')
  @RequirePermission('createProductsAndSetPrices')
  priceCheck(@Param('productId') productId: string): Promise<PriceCheckView> {
    this.requireProductId(productId);
    return this.products.priceCheck(productId);
  }

  /** A malformed id would reach Postgres as an invalid uuid and surface as a 500. */
  private requireProductId(productId: string): void {
    if (!productIdSchema.safeParse(productId).success) {
      throw new NotFoundException({ errorCode: errorCodes.PRODUCT_NOT_FOUND });
    }
  }

  private userId(request: RequestWithSession): string {
    const userId = request.sessionContext?.userId;
    // The guard populates this before the handler runs; a missing context here
    // would be a wiring fault rather than an anonymous caller.
    if (!userId) throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    return userId;
  }
}
