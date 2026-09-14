import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../public/catalog.service';
import { GrantsAdminService, type GrantListView, type GrantView } from './grants-admin.service';

/**
 * §9.2's `POST /grants` and `DELETE /grants/:grantId` — FR-COM-04 — plus the
 * list that makes a `grantId` findable, which §9.2 does not name.
 *
 * Owner only, through §3's `grantOrRevokeAccessManually`.
 */

const INT4_MAX = 2_147_483_647;

const grantTerms = {
  learnerEmail: z.string().trim().min(3).max(320),
  // Format here; a real calendar date and "not before today" in the service.
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  gracePeriodDays: z.int().min(0).max(INT4_MAX).default(0),
};

const createSchema = z.discriminatedUnion('scopeType', [
  z.strictObject({ scopeType: z.literal('course'), courseId: z.uuid(), ...grantTerms }),
  z.strictObject({ scopeType: z.literal('category'), categoryId: z.uuid(), ...grantTerms }),
]);

const listQuerySchema = z.strictObject({
  status: z.enum(['live', 'revoked', 'all']).default('live'),
  learnerEmail: z.string().trim().min(1).max(320).optional(),
  courseId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const grantIdSchema = z.uuid();

@Controller('admin/grants')
@UseGuards(SessionGuard, RolesGuard)
export class GrantsAdminController {
  constructor(@Inject(GrantsAdminService) private readonly grants: GrantsAdminService) {}

  @Get()
  @RequirePermission('grantOrRevokeAccessManually')
  list(@Query() query: unknown): Promise<GrantListView> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_QUERY' });
    return this.grants.list(parsed.data);
  }

  @Post()
  @RequirePermission('grantOrRevokeAccessManually')
  create(@Body() body: unknown, @Req() request: RequestWithSession): Promise<GrantView> {
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

    const grantedByUserId = request.sessionContext?.userId;
    // The guard populates this before the handler runs.
    if (!grantedByUserId) {
      throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    }
    return this.grants.create(parsed.data, grantedByUserId);
  }

  @Delete(':grantId')
  @HttpCode(204)
  @RequirePermission('grantOrRevokeAccessManually')
  revoke(@Param('grantId') grantId: string): Promise<void> {
    // A malformed id would reach Postgres as an invalid uuid and surface as a 500.
    if (!grantIdSchema.safeParse(grantId).success) {
      throw new NotFoundException({ errorCode: errorCodes.GRANT_NOT_FOUND });
    }
    return this.grants.revoke(grantId);
  }
}
