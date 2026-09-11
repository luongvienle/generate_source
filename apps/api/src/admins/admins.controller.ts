import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationService } from '../auth/invitation.service';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';

const createAdminSchema = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().min(1).optional(),
});

const updateAdminSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one of displayName or isActive.',
  });

/** FR-AUTH-01. Owner-only by §3; enforced by the matrix, not by this comment. */
@Controller('admin/admins')
@UseGuards(SessionGuard, RolesGuard)
export class AdminsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
  ) {}

  @Post()
  @RequirePermission('manageAdminAccounts')
  async create(@Body() body: unknown, @Req() request: RequestWithSession) {
    const parsed = createAdminSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    const caller = request.sessionContext;
    try {
      const admin = await this.prisma.client.user.create({
        data: {
          email: parsed.data.emailAddress,
          name: parsed.data.displayName ?? null,
          userRole: 'admin',
          createdByUserId: caller?.userId ?? null,
        },
        select: { id: true, email: true, userRole: true, isActive: true },
      });
      await this.invitations.sendInvitation(admin.email);
      return admin;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({ errorCode: 'EMAIL_ALREADY_EXISTS' });
      }
      throw error;
    }
  }

  /**
   * Rename, disable or re-enable. FR-AUTH-01 forbids hard deletion while the
   * account is referenced, so there is deliberately no DELETE route.
   */
  @Patch(':userId')
  @RequirePermission('manageAdminAccounts')
  async update(@Param('userId') userId: string, @Body() body: unknown) {
    const parsed = updateAdminSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    const data: { name?: string; isActive?: boolean } = {};
    if (parsed.data.displayName !== undefined) data.name = parsed.data.displayName;
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;

    try {
      return await this.prisma.client.user.update({
        where: { id: userId },
        data,
        select: { id: true, email: true, userRole: true, isActive: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException({ errorCode: 'USER_NOT_FOUND' });
      }
      throw error;
    }
  }
}

/**
 * Deliberately declares no @RequirePermission.
 *
 * It exists so the deny-by-default property of RolesGuard is covered by a
 * permanent test rather than a hand-edit during review: every role must get a
 * 403 with FORBIDDEN_NO_POLICY here. Do not add a permission to it.
 */
@Controller('admin/policy-fixture')
@UseGuards(SessionGuard, RolesGuard)
export class UndeclaredPolicyFixtureController {
  @Get()
  read(): { unreachable: true } {
    return { unreachable: true };
  }
}
