import { Controller, Inject, Param, Req, Sse, UseGuards } from '@nestjs/common';
import { concatMap, from, interval, map, startWith, switchMap, takeWhile } from 'rxjs';
import type { Observable } from 'rxjs';
import type { JobStatus, JobType, UserRole } from '@knowledge-explorer/shared';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { PrismaService } from '../prisma/prisma.service';
import { isLessonTargeted, mayWatch } from './job-permissions';

/** Fast enough to feel live, cheap enough to poll a handful of rows. */
const POLL_INTERVAL_MS = 250;

/**
 * §9.3 GET /courses/:courseId/stream.
 *
 * P1 deferred this on the grounds that a per-course view needs more than one
 * producer; `generate_image` is the second, so it lands here.
 *
 * It reports the DURABLE RECORD — generation_jobs rows — rather than BullMQ
 * jobs, because "what is happening on this course" is a question about the
 * course, not about a queue. That is why its event is CourseJobSnapshot and not
 * the per-job stream's JobSnapshot: there is no BullMQ job id in play, and
 * pretending otherwise would put two different id spaces behind one field.
 */
export interface CourseJobSnapshot {
  readonly generationJobId: string;
  readonly jobType: JobType;
  readonly jobStatus: JobStatus;
  readonly attemptCount: number;
  readonly targetEntityId: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorMessage: string | null;
}

const isTerminalStatus = (status: JobStatus): boolean =>
  status === 'succeeded' || status === 'failed';

@Controller('admin/courses')
@UseGuards(SessionGuard, RolesGuard)
export class CourseStreamController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Every generation_jobs row whose target resolves to this course.
   *
   * The resolution is per job type because §8 gives target_entity_id a
   * different meaning for each: an image job targets a lesson, an import job
   * targets the category the course lives in, and P6's publish job will target
   * the course itself.
   */
  private async rowsForCourse(
    courseId: string,
    session: { userId: string; userRole: UserRole },
  ): Promise<readonly CourseJobSnapshot[]> {
    const course = await this.prisma.client.course.findUnique({
      where: { id: courseId },
      select: { categoryId: true },
    });
    if (!course) return [];

    const lessons = await this.prisma.client.lesson.findMany({
      where: { chapter: { courseId } },
      select: { id: true, assignedAdminId: true },
    });
    const assignmentByLesson = new Map(lessons.map((l) => [l.id, l.assignedAdminId]));

    const rows = await this.prisma.client.generationJob.findMany({
      where: { targetEntityId: { in: [...assignmentByLesson.keys(), courseId, course.categoryId] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    /**
     * EMIT ONLY WHAT THIS CALLER COULD WATCH JOB BY JOB. The endpoint declares
     * the broader of the mapped actions so an admin can reach it at all; each
     * row is then put through the same §3 action and the same R-02 check the
     * per-job stream applies. An admin therefore sees their own image jobs on
     * this course and never the owner's import job.
     */
    return rows
      .filter((row) => {
        const jobType = row.jobType as JobType;
        if (!mayWatch(jobType, session.userRole)) return false;
        if (session.userRole === 'admin_owner') return true;
        if (!isLessonTargeted(jobType)) return true;

        const assignedAdminId = assignmentByLesson.get(row.targetEntityId);
        return assignedAdminId === null || assignedAdminId === session.userId;
      })
      .map((row) => ({
        generationJobId: row.id,
        jobType: row.jobType as JobType,
        jobStatus: row.jobStatus as JobStatus,
        attemptCount: row.attemptCount,
        targetEntityId: row.targetEntityId,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        errorMessage: row.errorMessage,
      }));
  }

  @Sse(':courseId/stream')
  @RequirePermission('generateAndSelectImages')
  stream(
    @Param('courseId') courseId: string,
    @Req() request: RequestWithSession,
  ): Observable<{ data: CourseJobSnapshot }> {
    const session = request.sessionContext;
    if (!session) return from([]);

    /**
     * Rows already reported, by id, with the status they were last reported
     * at. A row is re-emitted only when its status moves, and a row that was
     * outstanding stays tracked until it reaches a terminal state — otherwise a
     * job that finished between two polls would never report that it had.
     */
    const reportedStatus = new Map<string, JobStatus>();

    return interval(POLL_INTERVAL_MS).pipe(
      startWith(0),
      switchMap(() => from(this.rowsForCourse(courseId, session))),
      map((rows) => {
        const relevant = rows.filter(
          (row) => !isTerminalStatus(row.jobStatus) || reportedStatus.has(row.generationJobId),
        );
        const changed = relevant.filter(
          (row) => reportedStatus.get(row.generationJobId) !== row.jobStatus,
        );
        for (const row of relevant) reportedStatus.set(row.generationJobId, row.jobStatus);

        return {
          changed,
          outstanding: relevant.some((row) => !isTerminalStatus(row.jobStatus)),
        };
      }),
      // `true` makes takeWhile inclusive, so the tick that carries the final
      // terminal transitions is emitted before the stream completes.
      takeWhile((tick) => tick.outstanding, true),
      concatMap((tick) => from(tick.changed.map((data) => ({ data })))),
    );
  }
}
