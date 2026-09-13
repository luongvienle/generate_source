import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { hasAccessToLesson } from '@knowledge-explorer/commerce';
import { errorCodes } from '@knowledge-explorer/shared';
import {
  OBJECT_STORAGE,
  PRESIGN_EXPIRY_SECONDS,
  type ObjectStorage,
} from '@knowledge-explorer/storage';
import { PrismaService } from '../prisma/prisma.service';
import { resolveOptionalUserId } from '../auth/optional-session';
import type { RequestWithSession } from '../auth/session-context';

/**
 * §9.4's `GET /media/:mediaId/signed-url` — the second half of E-01.
 *
 * "`hasAccessToLesson` must gate BOTH `GET /lessons/:lessonId` and
 * `GET /media/:mediaId/signed-url`. Missing either one leaks paid audio." This
 * file is the one that leaks, so it calls the same §7.3 resolver the reader
 * does and reaches it through the owning lesson.
 *
 * WHAT `:mediaId` IS. §8 defines no `media_assets` table, so the id had no
 * referent; P7 resolves it to `lesson_audios.id` and nothing else. Figure
 * images do not come through here — they arrive already presigned in the lesson
 * payload, which is entitlement-gated by the same resolver and saves a reader
 * with eight figures eight round trips before it can paint. Audio is the only
 * media a learner fetches separately, and it is the media E-01 names.
 *
 * See the guard-chain note on PublicLessonsController for why no
 * @RequirePermission appears here.
 */
@Controller()
export class PublicMediaController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Get('media/:mediaId/signed-url')
  async signedUrl(
    @Param('mediaId') mediaId: string,
    @Req() request: RequestWithSession,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const audio = await this.prisma.client.lessonAudio.findUnique({
      where: { id: mediaId },
      select: { lessonId: true, mergedAudioFileUrl: true, audioStatus: true },
    });
    if (!audio || audio.audioStatus !== 'ready') {
      throw new NotFoundException({ errorCode: errorCodes.MEDIA_NOT_FOUND });
    }

    const userId = await resolveOptionalUserId(this.prisma, request);
    if (!(await hasAccessToLesson(this.prisma.client, userId, audio.lessonId))) {
      throw new ForbiddenException({ errorCode: errorCodes.LESSON_NOT_ENTITLED });
    }

    /**
     * E-03: "Signed media URLs expire within minutes. A long-lived URL survives
     * the grant that produced it, so TTL is a correctness requirement, not an
     * optimization." The player re-mints through this endpoint when the URL
     * nears expiry, and every mint re-runs the check above — which is how a
     * grant revoked mid-listen stops the next request.
     */
    return {
      url: await this.storage.presignGet(audio.mergedAudioFileUrl, PRESIGN_EXPIRY_SECONDS),
      expiresInSeconds: PRESIGN_EXPIRY_SECONDS,
    };
  }
}
