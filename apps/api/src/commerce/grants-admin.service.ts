import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  isBeforeTodayInVietnam,
  isCalendarDate,
  isGrantActive,
  vietnamDayEnd,
} from '@knowledge-explorer/commerce';
import { errorCodes, type AccessSource, type ScopeType } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * FR-COM-04 — the owner grants and revokes access by hand
 * (specs/p8a-commerce/spec.md, "Manual grants").
 *
 * ACTIVITY IS DECIDED BY `isGrantActive`, NEVER BY A QUERY. The list filters on
 * `revoked_at` — identity, not activity — and computes each row's `isActive` in
 * TypeScript through §7.3's one predicate. A SQL comparison of `expires_at`
 * against now here would put the grace-period arithmetic in a second place, which
 * is exactly what P7 built packages/commerce to prevent.
 */

export interface GrantView {
  readonly grantId: string;
  readonly learnerId: string;
  readonly learnerEmail: string;
  readonly scopeType: ScopeType;
  readonly courseId: string | null;
  readonly categoryId: string | null;
  /** The course title or category name the grant covers. */
  readonly scopeName: string;
  readonly accessSource: AccessSource;
  readonly expiresAt: string | null;
  readonly gracePeriodDays: number;
  readonly renewalCount: number;
  readonly revokedAt: string | null;
  /** `isGrantActive(row, now)`: false once revoked, or past expiry plus grace. */
  readonly isActive: boolean;
  readonly grantedByEmail: string | null;
  readonly sourceProductName: string | null;
  readonly createdAt: string;
}

export interface GrantListView {
  readonly items: readonly GrantView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface GrantListQuery {
  /** `live` is un-revoked, active or not. Filtered on `revoked_at` only. */
  readonly status: 'live' | 'revoked' | 'all';
  readonly learnerEmail?: string | undefined;
  readonly courseId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

interface GrantTerms {
  readonly learnerEmail: string;
  /** `YYYY-MM-DD` in Asia/Ho_Chi_Minh, or null for perpetual. */
  readonly expiresOn: string | null;
  readonly gracePeriodDays: number;
}

export type CreateGrantInput =
  | (GrantTerms & { readonly scopeType: 'course'; readonly courseId: string })
  | (GrantTerms & { readonly scopeType: 'category'; readonly categoryId: string });

const GRANT_SELECT = {
  id: true,
  userId: true,
  scopeType: true,
  scopeCourseId: true,
  scopeCategoryId: true,
  accessSource: true,
  expiresAt: true,
  gracePeriodDays: true,
  renewalCount: true,
  revokedAt: true,
  createdAt: true,
  user: { select: { email: true } },
  grantedByUser: { select: { email: true } },
  sourceProduct: { select: { displayName: true } },
  scopeCourse: { select: { title: true } },
  scopeCategory: { select: { displayName: true } },
} as const;

type GrantRow = {
  id: string;
  userId: string;
  scopeType: string;
  scopeCourseId: string | null;
  scopeCategoryId: string | null;
  accessSource: string;
  expiresAt: Date | null;
  gracePeriodDays: number;
  renewalCount: number;
  revokedAt: Date | null;
  createdAt: Date;
  user: { email: string };
  grantedByUser: { email: string } | null;
  sourceProduct: { displayName: string } | null;
  scopeCourse: { title: string } | null;
  scopeCategory: { displayName: string } | null;
};

function toGrantView(row: GrantRow, now: Date): GrantView {
  return {
    grantId: row.id,
    learnerId: row.userId,
    learnerEmail: row.user.email,
    scopeType: row.scopeType as ScopeType,
    courseId: row.scopeCourseId,
    categoryId: row.scopeCategoryId,
    scopeName: row.scopeCourse?.title ?? row.scopeCategory?.displayName ?? '',
    accessSource: row.accessSource as AccessSource,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    gracePeriodDays: row.gracePeriodDays,
    renewalCount: row.renewalCount,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    isActive: isGrantActive(row, now),
    grantedByEmail: row.grantedByUser?.email ?? null,
    sourceProductName: row.sourceProduct?.displayName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'P2002';

@Injectable()
export class GrantsAdminService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * FR-COM-04: "Owner grants access directly, scoped to a course or a category,
   * with an expiry date or no expiry at all."
   *
   * Every refusal is checked before anything is written. NO ACCOUNT IS CREATED
   * for an unknown email — the learner signs up in learner-web first — and a
   * grant to an owner or admin account is refused rather than stored inert.
   */
  async create(input: CreateGrantInput, grantedByUserId: string): Promise<GrantView> {
    const now = new Date();

    const learner = await this.prisma.client.user.findFirst({
      where: { email: { equals: input.learnerEmail.trim(), mode: 'insensitive' } },
      select: { id: true, userRole: true },
    });
    if (!learner) throw new NotFoundException({ errorCode: errorCodes.USER_NOT_FOUND });
    if (learner.userRole !== 'learner') {
      throw new UnprocessableEntityException({ errorCode: errorCodes.GRANT_TARGET_NOT_LEARNER });
    }

    if (input.scopeType === 'course') {
      const course = await this.prisma.client.course.findUnique({
        where: { id: input.courseId },
        select: { id: true },
      });
      if (!course) throw new NotFoundException({ errorCode: errorCodes.COURSE_NOT_FOUND });
    } else {
      const category = await this.prisma.client.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true },
      });
      if (!category) throw new NotFoundException({ errorCode: errorCodes.CATEGORY_NOT_FOUND });
    }

    let expiresAt: Date | null = null;
    if (input.expiresOn !== null) {
      if (!isCalendarDate(input.expiresOn)) {
        throw new BadRequestException({ errorCode: 'INVALID_BODY' });
      }
      // Today is allowed: a grant that ends tonight in Vietnam is still a grant.
      if (isBeforeTodayInVietnam(input.expiresOn, now)) {
        throw new BadRequestException({ errorCode: errorCodes.GRANT_EXPIRY_IN_PAST });
      }
      expiresAt = vietnamDayEnd(input.expiresOn);
    }

    const scope =
      input.scopeType === 'course'
        ? { scopeType: 'course', scopeCourseId: input.courseId }
        : { scopeType: 'category', scopeCategoryId: input.categoryId };

    await this.refuseIfLive(learner.id, scope);

    let row: GrantRow;
    try {
      row = await this.prisma.client.accessGrant.create({
        data: {
          userId: learner.id,
          ...scope,
          accessSource: 'granted_by_owner',
          grantedByUserId,
          // §7.2: NULL expiry is "owner-granted perpetual access", and this is the
          // only writer of one.
          expiresAt,
          gracePeriodDays: input.gracePeriodDays,
        },
        select: GRANT_SELECT,
      });
    } catch (error) {
      // A concurrent grant won §8's partial unique index.
      if (isUniqueViolation(error)) await this.refuseIfLive(learner.id, scope);
      throw error;
    }

    return toGrantView(row, now);
  }

  /**
   * FR-COM-04: "revocation takes effect on the next request". `hasAccessToLesson`
   * checks `revoked_at` first and caches nothing, so writing the column is the
   * whole mechanism. A signed media URL minted earlier survives up to its TTL —
   * E-03's bound.
   *
   * Idempotent: revoking a revoked grant is a 204 that leaves the original
   * `revoked_at` alone. There is no un-revoke; a new grant inserts a new row.
   */
  async revoke(grantId: string): Promise<void> {
    const grant = await this.prisma.client.accessGrant.findUnique({
      where: { id: grantId },
      select: { revokedAt: true },
    });
    if (!grant) throw new NotFoundException({ errorCode: errorCodes.GRANT_NOT_FOUND });
    if (grant.revokedAt) return;

    await this.prisma.client.accessGrant.updateMany({
      // The null guard keeps two concurrent revokes from overwriting the first time.
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async list(query: GrantListQuery): Promise<GrantListView> {
    const now = new Date();
    const where = {
      ...(query.status === 'live' ? { revokedAt: null } : {}),
      ...(query.status === 'revoked' ? { revokedAt: { not: null } } : {}),
      ...(query.learnerEmail
        ? { user: { email: { contains: query.learnerEmail, mode: 'insensitive' as const } } }
        : {}),
      ...(query.courseId ? { scopeCourseId: query.courseId } : {}),
      ...(query.categoryId ? { scopeCategoryId: query.categoryId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.client.accessGrant.findMany({
        where,
        select: GRANT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.client.accessGrant.count({ where }),
    ]);

    return {
      items: rows.map((row) => toGrantView(row, now)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async refuseIfLive(
    userId: string,
    scope: { scopeType: string; scopeCourseId?: string; scopeCategoryId?: string },
  ): Promise<void> {
    const live = await this.prisma.client.accessGrant.findFirst({
      where: { userId, revokedAt: null, ...scope },
      select: { id: true, accessSource: true, expiresAt: true },
    });
    if (live) {
      throw new ConflictException({
        errorCode: errorCodes.GRANT_ALREADY_EXISTS,
        grant: {
          grantId: live.id,
          accessSource: live.accessSource,
          expiresAt: live.expiresAt?.toISOString() ?? null,
        },
      });
    }
  }
}
