import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AssignmentGuard } from '../auth/assignment.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { editorOf } from './lesson-content.controller';
import { AudioService } from './audio.service';

/**
 * §9.3 audio endpoints (P5).
 *
 * GUARDS ARE SPLIT BY METHOD, as lesson-content, images and narration all do:
 * the rule guards refuse regardless of HTTP method, and an admin must still be
 * able to READ the audio state of a lesson they cannot write — the tab renders
 * read-only and explains itself. So the controller declares only session and
 * role, and the write adds the two rule guards itself.
 */
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
export class AudioController {
  constructor(@Inject(AudioService) private readonly audio: AudioService) {}

  /**
   * §9.3 lists only the write. A tab cannot render a screen it cannot read,
   * which is the justification P2, P3 and P4 each used for their own GET.
   */
  @Get('lessons/:lessonId/audio')
  @RequirePermission('generateAudio')
  async read(@Param('lessonId') lessonId: string, @Req() request: RequestWithSession) {
    return this.audio.read(lessonId, editorOf(request));
  }

  /**
   * NFR-04: 202 and a jobId, never a request that waits on a provider. The tab
   * follows the run over the SSE stream P1 built.
   *
   * No body: the input is the stored, approved narration script and the course's
   * configured voice.
   */
  @Post('lessons/:lessonId/audio')
  @HttpCode(202)
  @RequirePermission('generateAudio')
  @UseGuards(PublishedLockGuard, AssignmentGuard)
  async generate(@Param('lessonId') lessonId: string, @Req() request: RequestWithSession) {
    return this.audio.requestGeneration(lessonId, editorOf(request));
  }
}
