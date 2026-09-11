import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { errorCodes } from '@knowledge-explorer/shared';
import type { RequestWithSession } from './session-context';
import { WriteTargetResolver } from './target-resolver';

/**
 * Rule R-01: every write under /api/admin/* returns 403 when the target course
 * is published and the caller is not admin_owner.
 *
 * Enforced here, server-side, and deliberately not by hiding buttons.
 */
@Injectable()
export class PublishedLockGuard implements CanActivate {
  constructor(@Inject(WriteTargetResolver) private readonly targets: WriteTargetResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = request.sessionContext;
    if (!session) {
      throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    }

    // §3 grants the owner, and only the owner, edits to a published course.
    if (session.userRole === 'admin_owner') return true;

    const target = await this.targets.resolve(request);
    if (!target) return true;

    if (target.publicationStatus === 'published') {
      throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_COURSE_PUBLISHED });
    }
    return true;
  }
}
