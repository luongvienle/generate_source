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
import { errorCodes } from '@knowledge-explorer/shared';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../public/catalog.service';
import {
  DiscountCodesService,
  type DiscountCodeListView,
  type DiscountCodeView,
} from './discount-codes.service';

/**
 * The owner's discount codes (specs/p8a-commerce/spec.md). Not in §9.
 *
 * §3 has no "manage discount codes" row, and P8a adds none: a discount is
 * setting a price, so these endpoints declare `createProductsAndSetPrices`, the
 * way P5 reused an existing action for voice configuration.
 */

const INT4_MAX = 2_147_483_647;

/** A picked day, or `null` to clear it. Real-calendar validity is the service's. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

const createSchema = z.strictObject({
  // Normalized and pattern-checked in the service, which owns the stored shape.
  code: z.string().trim().min(1).max(64),
  percentOff: z.int().min(1).max(100),
  appliesToAllProducts: z.boolean().optional(),
  productIds: z.array(z.uuid()).max(500).optional(),
  startsOn: calendarDate,
  endsOn: calendarDate,
  maxRedemptions: z.int().min(1).max(INT4_MAX).nullable().optional(),
  oncePerLearner: z.boolean().optional(),
  newPurchasesOnly: z.boolean().optional(),
});

/**
 * `code`, `percentOff`, `productIds` and `appliesToAllProducts` are deliberately
 * absent, so `strictObject` refuses them: they are fixed at creation.
 */
const updateSchema = z
  .strictObject({
    startsOn: calendarDate,
    endsOn: calendarDate,
    maxRedemptions: z.int().min(1).max(INT4_MAX).nullable().optional(),
    oncePerLearner: z.boolean().optional(),
    newPurchasesOnly: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'nothing to change' });

const pageQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const codeIdSchema = z.uuid();

const invalidBody = (error: z.ZodError) =>
  new BadRequestException({
    errorCode: 'INVALID_BODY',
    issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });

@Controller('admin/discount-codes')
@UseGuards(SessionGuard, RolesGuard)
export class DiscountCodesController {
  constructor(@Inject(DiscountCodesService) private readonly codes: DiscountCodesService) {}

  @Get()
  @RequirePermission('createProductsAndSetPrices')
  list(@Query() query: unknown): Promise<DiscountCodeListView> {
    const parsed = pageQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });
    return this.codes.list(parsed.data.page, parsed.data.pageSize);
  }

  @Post()
  @RequirePermission('createProductsAndSetPrices')
  create(@Body() body: unknown, @Req() request: RequestWithSession): Promise<DiscountCodeView> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error);

    const userId = request.sessionContext?.userId;
    // The guard populates this before the handler runs.
    if (!userId) throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    return this.codes.create(parsed.data, userId);
  }

  @Patch(':codeId')
  @RequirePermission('createProductsAndSetPrices')
  update(@Param('codeId') codeId: string, @Body() body: unknown): Promise<DiscountCodeView> {
    // A malformed id would reach Postgres as an invalid uuid and surface as a 500.
    if (!codeIdSchema.safeParse(codeId).success) {
      throw new NotFoundException({ errorCode: errorCodes.DISCOUNT_CODE_NOT_FOUND });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error);
    return this.codes.update(codeId, parsed.data);
  }
}
