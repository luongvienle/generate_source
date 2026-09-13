import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AssignmentGuard } from '../auth/assignment.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { editorOf } from './lesson-content.controller';
import { NarrationService } from './narration.service';
import { AudioService } from './audio.service';

/** §9.3's PUT does two things: edit segments, and approve. Either may be absent. */
const updateBodySchema = z
  .strictObject({
    /**
     * The scriptChecksum the tab loaded. A mismatch means another admin saved in
     * between, and the write is refused rather than silently overwriting them —
     * the same shape P2 gave the content editor.
     */
    scriptChecksum: z.string().min(1),
    segments: z
      .array(z.strictObject({ blockId: z.string().min(1), narrationText: z.string() }))
      .optional(),
    approve: z.boolean().optional(),
  })
  .refine((value) => value.segments !== undefined || value.approve !== undefined, {
    message: 'no changes supplied',
  });

/**
 * §9.3 narration endpoints.
 *
 * GUARDS ARE SPLIT BY METHOD, for the reason lesson-content.controller.ts and
 * images.controller.ts both document: the rule guards refuse regardless of HTTP
 * method, and an admin must still be able to READ the narration of a lesson they
 * cannot write — the tab renders read-only and explains itself. So the controller
 * declares only session and role, and each write adds the two rule guards itself.
 */
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
export class NarrationController {
  constructor(
    @Inject(NarrationService) private readonly narration: NarrationService,
    @Inject(AudioService) private readonly audio: AudioService,
  ) {}

  /**
   * §9.3 lists only the two writes. An editor cannot render a screen it cannot
   * read, which is the justification P2 and P3 both used for adding their own
   * content and images GETs.
   */
  @Get('lessons/:lessonId/narration-script')
  @RequirePermission('generateAndEditNarrationScript')
  async read(@Param('lessonId') lessonId: string, @Req() request: RequestWithSession) {
    return this.narration.read(lessonId, editorOf(request));
  }

  /**
   * §6.5 freshness, both links.
   *
   * COMPOSED FROM TWO SERVICES rather than one. P4 shipped the content→script
   * link and left no `audio` key at all — not a permanently null one, which
   * would have taught every client to skip it and left P5 unable to distinguish
   * "no audio yet" from "not implemented". P5 adds the key here, and `null`
   * now means exactly one thing: this lesson has no lesson_audios row.
   *
   * The permission stays `generateAndEditNarrationScript`: the endpoint is the
   * narration tab's, and §3 gives both admin roles both actions, so adding an
   * audio-shaped key widens no one's access.
   */
  @Get('lessons/:lessonId/staleness')
  @RequirePermission('generateAndEditNarrationScript')
  async staleness(@Param('lessonId') lessonId: string) {
    const [script, audio] = await Promise.all([
      this.narration.staleness(lessonId),
      this.audio.stalenessFor(lessonId),
    ]);
    return { ...script, audio };
  }

  /**
   * NFR-04: 202 and a jobId, never a request that waits on the provider. The tab
   * follows the run over the SSE stream from there.
   *
   * No body: §6.3's input is derived entirely from stored state.
   */
  @Post('lessons/:lessonId/narration-script')
  @HttpCode(202)
  @RequirePermission('generateAndEditNarrationScript')
  @UseGuards(PublishedLockGuard, AssignmentGuard)
  async generate(@Param('lessonId') lessonId: string, @Req() request: RequestWithSession) {
    return this.narration.requestGeneration(lessonId, editorOf(request));
  }

  @Put('lessons/:lessonId/narration-script')
  @RequirePermission('generateAndEditNarrationScript')
  @UseGuards(PublishedLockGuard, AssignmentGuard)
  async update(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
    @Req() request: RequestWithSession,
  ) {
    const parsed = updateBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    return this.narration.update(lessonId, parsed.data, editorOf(request));
  }
}
