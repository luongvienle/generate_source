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
 *
 * `publishing` COUNTS AS PUBLISHED (P6). The window between taking the lock and
 * the job finishing is exactly when a non-owner edit would corrupt the snapshot:
 * the worker copies every lesson body into the published track inside one
 * transaction, and an admin saving a draft mid-run would have their change
 * either half-copied or silently missed, with hasUnpublishedChanges left
 * claiming the opposite. The owner is NOT locked out — R-01 exists to keep
 * non-owners out of live courses, and the run's own transaction is what makes
 * the snapshot consistent.
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

    if (target.publicationStatus === 'published' || target.publicationStatus === 'publishing') {
      throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_COURSE_PUBLISHED });
    }
    return true;
  }
}
