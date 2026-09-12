import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { buildJsonSchema, SCHEMA_VERSION, validateImportPayload } from '@knowledge-explorer/content';
import { createQueuedJob, markJobAttemptFailed } from '@knowledge-explorer/database';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { ImportQueue } from '../jobs/import.queue';

/**
 * §5.2 curriculum import. Owner-only under §3.
 *
 * Both write endpoints return 202 and enqueue: NFR-04 forbids an HTTP request
 * waiting on long-running work. Validation is synchronous and happens first, so
 * FR-IMP-01's "on failure the response lists every error with its JSON path and
 * nothing is written" holds without a job ever being created.
 */

/**
 * docs/ lives at the repository root while each app runs from its own directory.
 * Overridable so a test or a container image can point elsewhere.
 */
const docsRoot = (): string => process.env['DOCS_ROOT'] ?? resolve(process.cwd(), '../../docs');

@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
export class ImportController {
  constructor(
    @Inject(ImportQueue) private readonly queue: ImportQueue,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** FR-IMP-03: downloadable from the owner portal. */
  @Get('import-template')
  @RequirePermission('importCurriculumOutline')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="owner-prompt-template.md"')
  async template(): Promise<string> {
    return readFile(resolve(docsRoot(), 'owner-prompt-template.md'), 'utf8');
  }

  /** Generated from the same zod module that validates, so the two cannot disagree. */
  @Get('import-schema')
  @RequirePermission('importCurriculumOutline')
  schema(): { schemaVersion: string; jsonSchema: unknown } {
    return { schemaVersion: SCHEMA_VERSION, jsonSchema: buildJsonSchema() };
  }

  @Post('courses/import/dry-run')
  @RequirePermission('importCurriculumOutline')
  @HttpCode(202)
  async dryRun(@Body() body: unknown): Promise<{ jobId: string }> {
    const validated = validateImportPayload(body);
    if (!validated.ok) {
      throw new UnprocessableEntityException({
        errorCode: validated.errorCode,
        issues: validated.issues,
      });
    }

    return { jobId: await this.queue.enqueueDryRun({ payload: validated.payload }) };
  }

  /**
   * FR-IMP-01. Validation is synchronous, so a bad payload writes nothing.
   *
   * The category upsert and the generation_jobs row share one transaction
   * because §8 makes target_entity_id NOT NULL and a first import has no course
   * to point at — see specs/p1-curriculum/spec.md. Accepted consequence: a
   * commit that ultimately fails leaves the new category behind. The upsert is
   * idempotent, so a corrected re-import reuses it.
   *
   * Enqueueing happens AFTER the transaction commits: inside it, the worker
   * could pick the job up and find no row. If the enqueue then fails, the row is
   * marked failed rather than being left at `queued` forever.
   */
  @Post('courses/import')
  @RequirePermission('importCurriculumOutline')
  @HttpCode(202)
  async commit(
    @Body() body: unknown,
    @Req() request: RequestWithSession,
  ): Promise<{ jobId: string; generationJobId: string }> {
    const validated = validateImportPayload(body);
    if (!validated.ok) {
      throw new UnprocessableEntityException({
        errorCode: validated.errorCode,
        issues: validated.issues,
      });
    }
    const payload = validated.payload;

    const { generationJobId } = await this.prisma.client.$transaction(async (tx) => {
      const category = await tx.category.upsert({
        where: { slug: payload.category.slug },
        create: { slug: payload.category.slug, displayName: payload.category.displayName },
        // Only displayName: fields the payload does not carry are never overwritten.
        update: { displayName: payload.category.displayName },
        select: { id: true },
      });

      const job = await createQueuedJob(tx.generationJob, {
        jobType: 'import_course_outline',
        targetEntityId: category.id,
      });
      return { generationJobId: job.id };
    });

    try {
      const jobId = await this.queue.enqueueCommit({
        payload,
        generationJobId,
        importedByUserId: request.sessionContext?.userId ?? null,
      });
      return { jobId, generationJobId };
    } catch (error) {
      await markJobAttemptFailed(this.prisma.client.generationJob, generationJobId, {
        attemptCount: 0,
        errorMessage: `could not enqueue: ${error instanceof Error ? error.message : String(error)}`,
        isFinalAttempt: true,
      });
      throw new InternalServerErrorException({ errorCode: 'IMPORT_ENQUEUE_FAILED' });
    }
  }
}
