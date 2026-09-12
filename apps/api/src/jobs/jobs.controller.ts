import { Controller, Inject, Param, Sse, UseGuards } from '@nestjs/common';
import { from, interval, map, startWith, switchMap, takeWhile, distinctUntilChanged } from 'rxjs';
import type { Observable } from 'rxjs';
import { errorCodes } from '@knowledge-explorer/shared';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { isTerminal, JobStatusService, type JobSnapshot } from './job-status.service';
import { JobWatchGuard } from './job-watch.guard';

/** Fast enough to feel live; a P1 import settles in well under a second. */
const POLL_INTERVAL_MS = 200;

/**
 * NFR-04: long-running operations report progress over server-sent events.
 *
 * §9.3 keys its stream by courseId, but a first import has no course until the
 * commit job creates one, so specs/p1-curriculum/spec.md adds this job-scoped
 * stream instead. It serves both kinds of job through JobSnapshot.
 *
 * Progress is polled from a snapshot rather than pushed from BullMQ's event bus.
 * That is deliberate: it is correct for a subscriber who arrives *after* the job
 * already finished, which the spec requires and which an event bus handles worst.
 *
 * §3 IS ENFORCED IN TWO STAGES. RolesGuard can only test the endpoint's one
 * declared action, and this stream now carries three job types with different actions
 * — so it declares one they share, `generateAndSelectImages`, and
 * JobWatchGuard then applies the specific job's own action and, for a
 * lesson-targeted job, R-02. An admin therefore reaches their own image job and
 * is still refused the owner's import job.
 */
@Controller('admin/jobs')
@UseGuards(SessionGuard, RolesGuard, JobWatchGuard)
export class JobsController {
  constructor(@Inject(JobStatusService) private readonly jobs: JobStatusService) {}

  @Sse(':jobId/stream')
  @RequirePermission('generateAndSelectImages')
  stream(@Param('jobId') jobId: string): Observable<{ data: JobSnapshot | { errorCode: string } }> {
    const unknown = { errorCode: errorCodes.JOB_NOT_FOUND, jobId };

    return interval(POLL_INTERVAL_MS).pipe(
      startWith(0),
      switchMap(() => from(this.jobs.snapshot(jobId))),
      map((snapshot) => snapshot ?? unknown),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      // `true` makes takeWhile inclusive, so the terminal snapshot is emitted
      // before the stream completes rather than being swallowed by the predicate.
      takeWhile((event) => !('errorCode' in event) && !isTerminal(event), true),
      map((data) => ({ data })),
    );
  }
}
