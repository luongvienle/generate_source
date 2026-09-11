import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errorCodes, isAllowed, type PermissionAction } from '@knowledge-explorer/shared';
import { PERMISSION_ACTION_KEY } from './roles.decorator';
import type { RequestWithSession } from './session-context';

/**
 * Enforces the §3 matrix, deny-by-default.
 *
 * Forgetting @RequirePermission on a new endpoint locks everyone out rather
 * than letting everyone in, so the failure mode of an oversight is a support
 * ticket instead of a breach.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<PermissionAction | undefined>(
      PERMISSION_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!action) {
      throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_NO_POLICY });
    }

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = request.sessionContext;
    if (!session) {
      throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    }

    if (!isAllowed(action, session.userRole)) {
      throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_ROLE });
    }
    return true;
  }
}
