import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { errorCodes, userRoleSchema } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithSession } from './session-context';
import { readLearnerSessionToken } from './optional-session';

/**
 * SessionGuard's twin for the learner app.
 *
 * Identical in every respect that matters — it discards any caller-supplied
 * identity, resolves the user from the `sessions` table on EVERY request
 * (FR-AUTH-01), and refuses an expired session or a disabled account — with one
 * difference: it reads learner-web's cookie name rather than admin-web's.
 *
 * WHY NOT JUST TEACH SessionGuard BOTH NAMES. Because `readSessionToken`
 * returns the first recognised cookie it meets while scanning the header, so a
 * request carrying both would resolve to whichever the browser happened to
 * serialise first, and identity would depend on `Cookie` header order. Reading
 * them separately keeps each app's session its own — and delivers §3 for free,
 * since an owner signed into admin-web carries no learner cookie and so cannot
 * reach a `buyAccessReadListenTrackProgress` endpoint at all.
 *
 * Asserted by `apps/api/test/learner-session.e2e-spec.ts`.
 */
@Injectable()
export class LearnerSessionGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();

    // Never trust a caller-supplied identity, exactly as SessionGuard does.
    request.sessionContext = undefined;

    const token = readLearnerSessionToken(request);
    if (!token) {
      throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    }

    const session = await this.prisma.client.session.findUnique({
      where: { sessionToken: token },
      include: { user: true },
    });

    if (!session || session.expires.getTime() <= Date.now()) {
      throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    }

    if (!session.user.isActive) {
      throw new ForbiddenException({ errorCode: errorCodes.ACCOUNT_DISABLED });
    }

    const role = userRoleSchema.safeParse(session.user.userRole);
    if (!role.success) {
      throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_ROLE });
    }

    request.sessionContext = {
      userId: session.user.id,
      userRole: role.data,
      isActive: session.user.isActive,
    };
    return true;
  }
}
