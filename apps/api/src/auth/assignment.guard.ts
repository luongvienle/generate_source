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
 * Rule R-02: an admin may write only where they are the assigned admin, or
 * where no assignment exists. admin_owner has no such restriction.
 *
 * Enforcement is row-level, against the chapter's or lesson's own
 * assigned_admin_id. §3 phrases R-02 as "courses where they are assigned", but
 * §8 places assigned_admin_id on chapters and lessons and defines no
 * course-level assignment column, so row-level is the only reading the schema
 * supports. Whether an unassigned lesson should inherit its chapter's
 * assignment is unspecified; nothing is inferred here.
 */
@Injectable()
export class AssignmentGuard implements CanActivate {
  constructor(@Inject(WriteTargetResolver) private readonly targets: WriteTargetResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = request.sessionContext;
    if (!session) {
      throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    }

    if (session.userRole === 'admin_owner') return true;

    const target = await this.targets.resolve(request);
    if (!target) return true;

    if (target.assignedAdminId !== null && target.assignedAdminId !== session.userId) {
      throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_NOT_ASSIGNED });
    }
    return true;
  }
}
