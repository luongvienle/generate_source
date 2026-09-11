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
import { readSessionToken, type RequestWithSession } from './session-context';

/**
 * Resolves the caller from the `sessions` table on every request.
 *
 * A database read per request is the point, not an oversight: FR-AUTH-01
 * requires that disabling an admin block their next call immediately, which a
 * self-contained token cannot do without a revocation lookup anyway.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();

    // Never trust a caller-supplied identity. Anything already on the request
    // object is discarded before the database is consulted.
    request.sessionContext = undefined;

    const token = readSessionToken(request);
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
      // An unrecognised role in the database is a data fault, not a permission
      // to be guessed at. Fail closed.
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
