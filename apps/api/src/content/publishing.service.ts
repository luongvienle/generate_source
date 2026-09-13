import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  allowedTransitionsFrom,
  canTransition,
  errorCodes,
  type PublicationStatus,
} from '@knowledge-explorer/shared';
import { evaluatePublishChecklist, type PublishChecklist } from '@knowledge-explorer/content';
import {
  createQueuedJob,
  loadPublishChecklistInput,
  markJobAttemptFailed,
} from '@knowledge-explorer/database';
import { PrismaService } from '../prisma/prisma.service';
import type { PublishCourseJobData } from '@knowledge-explorer/shared';
import { PublishQueue, PUBLISH_JOB_ID_PREFIX } from '../jobs/publish.queue';
import { AudioService } from './audio.service';

/**
 * §5.7 publishing: the §4.2 lifecycle, the FR-PUB-01 checklist, and the job that
 * writes §4.3's published track.
 *
 * Every status change goes through `transition` and therefore through §4.2's
 * table in packages/shared/src/publication.ts. No method here compares statuses
 * by hand; an edge that is not in the table cannot be taken.
 */

export interface CourseStatusView {
  readonly courseId: string;
  readonly publicationStatus: PublicationStatus;
  readonly hasUnpublishedChanges: boolean;
  readonly publishedAt: string | null;
  readonly publishedVersionNumber: number | null;
  readonly allowedTransitions: readonly PublicationStatus[];
}

@Injectable()
export class PublishingService {
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AudioService) private readonly audio: AudioService,
    @Inject(PublishQueue) private readonly queue: PublishQueue,
  ) {}

  /**
   * FR-PUB-01. §9.2 places this under the OWNER endpoints, so it is owner-only
   * at the controller even though an admin would find it useful — §9.2 outranks
   * convenience.
   *
   * The loading is batched in packages/database and the verdict is computed in
   * packages/content, so the publish worker reaches the identical answer without
   * importing anything from this app.
   */
  async checklist(courseId: string): Promise<PublishChecklist> {
    const course = await this.prisma.client.course.findUnique({
      where: { id: courseId },
      select: { voiceIdentifier: true, voiceProviderName: true },
    });
    if (!course) throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });

    const { voiceIdentifier } = this.audio.resolveVoice(course);
    const input = await loadPublishChecklistInput(this.prisma.client, courseId, voiceIdentifier);
    if (!input) throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });

    return evaluatePublishChecklist(input);
  }

  /**
   * Moves a course along §4.2, refusing anything that is not an edge.
   *
   * The 409 names the current status and everything reachable from it, so a
   * client that raced another admin can tell what happened without a second
   * request.
   */
  async transition(courseId: string, to: PublicationStatus): Promise<CourseStatusView> {
    const course = await this.loadCourse(courseId);
    const from = course.publicationStatus as PublicationStatus;

    if (!canTransition(from, to)) {
      throw new ConflictException({
        errorCode: errorCodes.INVALID_PUBLICATION_TRANSITION,
        currentStatus: from,
        requestedStatus: to,
        allowedTransitions: allowedTransitionsFrom(from),
      });
    }

    await this.prisma.client.course.update({
      where: { id: courseId },
      data: { publicationStatus: to, updatedAt: new Date() },
    });

    return this.status(courseId);
  }

  /** The publication state a panel needs, including what it may do next. */
  async status(courseId: string): Promise<CourseStatusView> {
    const course = await this.loadCourse(courseId);
    const structure = await this.prisma.client.publishedCourseStructure.findUnique({
      where: { courseId },
      select: { publishedVersionNumber: true },
    });
    const publicationStatus = course.publicationStatus as PublicationStatus;

    return {
      courseId,
      publicationStatus,
      hasUnpublishedChanges: course.hasUnpublishedChanges,
      publishedAt: course.publishedAt?.toISOString() ?? null,
      publishedVersionNumber: structure?.publishedVersionNumber ?? null,
      allowedTransitions: allowedTransitionsFrom(publicationStatus),
    };
  }

  /**
   * FR-PUB-02: enqueue a publish run, after every refusal §5.7 names.
   *
   * ORDER MATTERS. The checklist runs FIRST and returns 422 with the whole list,
   * so an owner gets an immediate, actionable rejection rather than a job that
   * fails seconds later over SSE. It is not the authoritative check — the worker
   * re-runs it, because a lesson edited between this 202 and the run starting
   * must not reach learners unchecked — but it is the one a person sees.
   */
  async requestPublish(
    courseId: string,
    editor: { userId: string },
  ): Promise<{ jobId: string; generationJobId: string }> {
    const course = await this.loadCourse(courseId);
    const previousStatus = course.publicationStatus as PublicationStatus;

    if (previousStatus === 'publishing') {
      throw new ConflictException({
        errorCode: errorCodes.PUBLISH_IN_FLIGHT,
        jobId: await this.inFlightJobId(courseId),
      });
    }

    if (!canTransition(previousStatus, 'publishing')) {
      throw new ConflictException({
        errorCode: errorCodes.INVALID_PUBLICATION_TRANSITION,
        currentStatus: previousStatus,
        requestedStatus: 'publishing',
        allowedTransitions: allowedTransitionsFrom(previousStatus),
      });
    }

    const checklist = await this.checklist(courseId);
    if (!checklist.passed) {
      throw new UnprocessableEntityException({
        errorCode: errorCodes.PUBLISH_CHECKLIST_FAILED,
        checklist,
      });
    }

    /**
     * The job row and the `publishing` lock share a transaction, so they cannot
     * disagree. THE ENQUEUE IS DELIBERATELY OUTSIDE IT: Redis is not enlisted in
     * a Postgres transaction, so an enqueue inside one that then failed would
     * roll back a job BullMQ had already accepted. The compensating catch below
     * is the house pattern, and here it must also RESTORE THE PREVIOUS STATUS —
     * `publishing` is a lock R-01 honours, so a failed enqueue that left it set
     * would lock every admin out of the course with no run to clear it.
     */
    const job = await this.prisma.client.$transaction(async (tx) => {
      const created = await createQueuedJob(
        tx.generationJob,
        { jobType: 'publish_course', targetEntityId: courseId },
        this.logger,
      );
      await tx.course.update({
        where: { id: courseId },
        data: { publicationStatus: 'publishing', updatedAt: new Date() },
      });
      return created;
    });

    try {
      const data: PublishCourseJobData = {
        generationJobId: job.id,
        courseId,
        createdByUserId: editor.userId,
        previousStatus,
      };
      const jobId = await this.queue.enqueuePublish(data);
      return { jobId, generationJobId: job.id };
    } catch (error) {
      await this.prisma.client.course.update({
        where: { id: courseId },
        data: { publicationStatus: previousStatus, updatedAt: new Date() },
      });
      await markJobAttemptFailed(this.prisma.client.generationJob, job.id, {
        attemptCount: 0,
        errorMessage: `could not enqueue: ${error instanceof Error ? error.message : String(error)}`,
        isFinalAttempt: true,
      });
      throw new InternalServerErrorException({ errorCode: 'PUBLISH_ENQUEUE_FAILED' });
    }
  }

  /**
   * The in-flight run's QUALIFIED BullMQ id, so the 409 tells the panel what to
   * attach to. Recovered by searching the queue, because `generation_jobs` has
   * no column for a BullMQ id and §8 is not being migrated for one.
   *
   * Returns null when the lock is set but no job exists — the orphaned-lock case
   * P4 and P5 both record, which P6 shares and does not close.
   */
  private async inFlightJobId(courseId: string): Promise<string | null> {
    const jobs = await this.queue.queue.getJobs(['waiting', 'active', 'delayed', 'paused']);
    const mine = jobs.find(
      (job) => (job.data as PublishCourseJobData | undefined)?.courseId === courseId,
    );
    return mine?.id ? `${PUBLISH_JOB_ID_PREFIX}${mine.id}` : null;
  }

  private async loadCourse(courseId: string) {
    const course = await this.prisma.client.course.findUnique({
      where: { id: courseId },
      select: { id: true, publicationStatus: true, hasUnpublishedChanges: true, publishedAt: true },
    });
    if (!course) throw new NotFoundException({ errorCode: 'COURSE_NOT_FOUND' });
    return course;
  }
}
