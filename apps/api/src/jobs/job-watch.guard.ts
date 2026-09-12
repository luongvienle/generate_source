import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { errorCodes } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithSession } from '../auth/session-context';
import { JobStatusService } from './job-status.service';
import { isLessonTargeted, mayWatch } from './job-permissions';

/**
 * Narrows the job stream from "may watch jobs" to "may watch THIS job".
 *
 * RolesGuard can only test the endpoint's one declared action, and the stream
 * carries two job types with different §3 actions. This resolves the job first,
 * then applies the type's own action and — for a lesson-targeted job — R-02.
 *
 * A guard rather than a check inside the handler, because @Sse must return the
 * Observable synchronously; an async check in the handler would have to resolve
 * before the stream existed.
 */
@Injectable()
export class JobWatchGuard implements CanActivate {
  constructor(
    @Inject(JobStatusService) private readonly jobs: JobStatusService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = request.sessionContext;
    if (!session) throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });

    const jobId = request.params['jobId'];
    if (!jobId) return true;

    const snapshot = await this.jobs.snapshot(jobId);
    // An unknown job is NOT refused here. P1's contract is that the stream
    // opens and emits a JOB_NOT_FOUND event rather than 404ing, which is what
    // lets a client that subscribes late still get a terminal answer. There is
    // nothing to authorize and nothing to leak.
    if (!snapshot) return true;

    if (!mayWatch(snapshot.jobType, session.userRole)) {
      throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_ROLE });
    }

    // R-02: an admin may watch a lesson-targeted job only where they may write.
    if (session.userRole !== 'admin_owner' && isLessonTargeted(snapshot.jobType)) {
      const lesson = await this.prisma.client.lesson.findUnique({
        where: { id: snapshot.targetEntityId ?? '' },
        select: { assignedAdminId: true },
      });
      if (
        lesson &&
        lesson.assignedAdminId !== null &&
        lesson.assignedAdminId !== session.userId
      ) {
        throw new ForbiddenException({ errorCode: errorCodes.FORBIDDEN_NOT_ASSIGNED });
      }
    }

    return true;
  }
}
