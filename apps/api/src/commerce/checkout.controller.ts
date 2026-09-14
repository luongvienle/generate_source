import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { errorCodes } from '@knowledge-explorer/shared';
import { LearnerSessionGuard } from '../auth/learner-session.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import type { RequestWithSession } from '../auth/session-context';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../public/catalog.service';
import {
  CheckoutService,
  type CheckoutRedirectView,
  type OrderListView,
  type OrderView,
  type QuoteView,
} from './checkout.service';

/**
 * §9.4's `POST /checkout`, plus the three learner reads FR-COM-02 is not
 * reachable without: the confirm page's quote, the order history, and the one
 * order the return page polls.
 *
 * `buyAccessReadListenTrackProgress` belongs to `learner` alone in §3, so an
 * owner or admin cannot buy. In practice they receive 401 first: this guard reads
 * learner-web's cookie, and admin-web's has a different name.
 */

/** Normalized and shape-checked by the discount service; an ill-formed code is simply not found. */
const discountCode = z.string().trim().min(1).max(64).optional();

const quoteQuerySchema = z.strictObject({
  productId: z.uuid(),
  discountCode,
});

const checkoutSchema = z.strictObject({
  productId: z.uuid(),
  discountCode,
});

const pageQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const orderIdSchema = z.uuid();

@Controller()
@UseGuards(LearnerSessionGuard, RolesGuard)
export class CheckoutController {
  constructor(@Inject(CheckoutService) private readonly checkoutService: CheckoutService) {}

  @Get('checkout/quote')
  @RequirePermission('buyAccessReadListenTrackProgress')
  quote(@Query() query: unknown, @Req() request: RequestWithSession): Promise<QuoteView> {
    const parsed = quoteQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });
    return this.checkoutService.quote(
      this.userId(request),
      parsed.data.productId,
      parsed.data.discountCode,
    );
  }

  @Post('checkout')
  @HttpCode(201)
  @RequirePermission('buyAccessReadListenTrackProgress')
  checkout(@Body() body: unknown, @Req() request: RequestWithSession): Promise<CheckoutRedirectView> {
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });
    return this.checkoutService.checkout(
      this.userId(request),
      parsed.data.productId,
      parsed.data.discountCode,
    );
  }

  @Get('me/orders')
  @RequirePermission('buyAccessReadListenTrackProgress')
  myOrders(@Query() query: unknown, @Req() request: RequestWithSession): Promise<OrderListView> {
    const parsed = pageQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });
    return this.checkoutService.myOrders(this.userId(request), parsed.data.page, parsed.data.pageSize);
  }

  @Get('me/orders/:orderId')
  @RequirePermission('buyAccessReadListenTrackProgress')
  myOrder(@Param('orderId') orderId: string, @Req() request: RequestWithSession): Promise<OrderView> {
    // A malformed id would reach Postgres as an invalid uuid and surface as a 500.
    if (!orderIdSchema.safeParse(orderId).success) {
      throw new NotFoundException({ errorCode: errorCodes.ORDER_NOT_FOUND });
    }
    return this.checkoutService.myOrder(this.userId(request), orderId);
  }

  private userId(request: RequestWithSession): string {
    const userId = request.sessionContext?.userId;
    // The guard populates this before the handler runs; a missing context here
    // would be a wiring fault rather than an anonymous caller.
    if (!userId) throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    return userId;
  }
}
