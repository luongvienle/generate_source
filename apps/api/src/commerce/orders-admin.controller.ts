import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { orderStatusSchema } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../public/catalog.service';
import { ORDER_SELECT, toOrderView, type OrderView } from './checkout.service';

/**
 * The owner's read-only order list (specs/p8a-commerce/spec.md). Not in §9.
 *
 * Without it, a refund issued outside the app has no in-app trail for the owner
 * to revoke against, and an order failed on an amount mismatch is visible only
 * in a log.
 *
 * §3 has no "view orders" row: this reuses `grantOrRevokeAccessManually`,
 * because reading orders is how the owner decides grants and revocations.
 *
 * `raw_webhook_payload` is never serialized. It is provider data, stored for
 * forensics, and has no business in a list a browser renders.
 */

export interface AdminOrderView extends OrderView {
  readonly learnerEmail: string;
  readonly providerName: string;
  readonly providerOrderReference: string;
}

export interface AdminOrderListView {
  readonly items: readonly AdminOrderView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

const listQuerySchema = z.strictObject({
  status: z.union([orderStatusSchema, z.literal('all')]).default('all'),
  learnerEmail: z.string().trim().min(1).max(320).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

@Controller('admin/orders')
@UseGuards(SessionGuard, RolesGuard)
export class OrdersAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('grantOrRevokeAccessManually')
  async list(@Query() query: unknown): Promise<AdminOrderListView> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });
    const { status, learnerEmail, page, pageSize } = parsed.data;

    const where = {
      ...(status === 'all' ? {} : { orderStatus: status }),
      ...(learnerEmail
        ? { user: { email: { contains: learnerEmail, mode: 'insensitive' as const } } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.client.paymentOrder.findMany({
        where,
        select: {
          ...ORDER_SELECT,
          providerName: true,
          providerOrderReference: true,
          user: { select: { email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.paymentOrder.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        ...toOrderView(row),
        learnerEmail: row.user.email,
        providerName: row.providerName,
        providerOrderReference: row.providerOrderReference,
      })),
      total,
      page,
      pageSize,
    };
  }
}
