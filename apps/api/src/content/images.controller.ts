import {
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  HttpStatus,
  Inject,
  PayloadTooLargeException,
  Param,
  Patch,
  Post,
  HttpCode,
  Req,
  UnprocessableEntityException,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { errorCodes } from '@knowledge-explorer/shared';
import { MAX_UPLOAD_BYTES } from '@knowledge-explorer/storage';
import {
  DEFAULT_CANDIDATE_COUNT,
  MAX_CANDIDATE_COUNT,
  MIN_CANDIDATE_COUNT,
} from '@knowledge-explorer/ai';
import { AssignmentGuard } from '../auth/assignment.guard';
import { PublishedLockGuard } from '../auth/published-lock.guard';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import type { RequestWithSession } from '../auth/session-context';
import { editorOf } from './lesson-content.controller';
import { ImagesService } from './images.service';

/** Just enough of the HTTP response to answer. `express` is not a declared dependency. */
interface JsonResponse {
  status(code: number): JsonResponse;
  json(body: unknown): unknown;
}

/**
 * Multer enforces the 5 MB ceiling inside the interceptor, so an oversize body
 * is refused before it is fully buffered. Nest's own multer bridge then turns
 * `LIMIT_FILE_SIZE` into a PayloadTooLargeException — a bare 413 whose body
 * carries no errorCode.
 *
 * That is remapped here onto the same 422 and the same errorCode the byte-level
 * check produces. 413 is the more conventional status, but a caller must not
 * have to branch on two different answers for one condition, and
 * conventions.md requires every error to carry a machine-readable code.
 */
@Catch(PayloadTooLargeException)
export class UploadTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<JsonResponse>()
      .status(HttpStatus.UNPROCESSABLE_ENTITY)
      .json({ errorCode: errorCodes.IMAGE_TOO_LARGE });
  }
}

/**
 * Only the bytes.
 *
 * `mimetype` and `originalname` are deliberately absent from this type although
 * multer supplies both: FR-IMG-02 decides the type from content, and a field
 * that cannot be named cannot be trusted by accident.
 */
interface UploadedBytes {
  readonly buffer: Buffer;
}

const uploadBodySchema = z.object({ blockReferenceId: z.string().min(1) });

/** §6.2's request payload. FR-IMG-01 bounds candidateCount at 2-4. */
const generateBodySchema = z.strictObject({
  blockReferenceId: z.string().min(1),
  imagePromptText: z.string().min(1),
  candidateCount: z
    .number()
    .int()
    .min(MIN_CANDIDATE_COUNT)
    .max(MAX_CANDIDATE_COUNT)
    .optional()
    .default(DEFAULT_CANDIDATE_COUNT),
});

const patchBodySchema = z
  .strictObject({
    isSelected: z.boolean().optional(),
    captionText: z.string().optional(),
    alternativeText: z.string().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'no changes supplied' });

/**
 * §9.3 image endpoints.
 *
 * GUARDS ARE SPLIT BY METHOD, for the reason lesson-content.controller.ts
 * documents: the rule guards refuse regardless of HTTP method, and an admin
 * must still be able to READ the images of a lesson they cannot write — the
 * drawer renders read-only and explains itself. So the controller declares only
 * session and role, and each write adds the two rule guards itself.
 */
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
export class ImagesController {
  constructor(@Inject(ImagesService) private readonly images: ImagesService) {}

  @Get('lessons/:lessonId/images')
  @RequirePermission('generateAndSelectImages')
  async read(@Param('lessonId') lessonId: string, @Req() request: RequestWithSession) {
    return this.images.read(lessonId, editorOf(request));
  }

  @Post('lessons/:lessonId/images/upload')
  @RequirePermission('generateAndSelectImages')
  @UseGuards(PublishedLockGuard, AssignmentGuard)
  @UseFilters(UploadTooLargeFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @Param('lessonId') lessonId: string,
    @UploadedFile() file: UploadedBytes | undefined,
    @Body() body: unknown,
    @Req() request: RequestWithSession,
  ) {
    const parsed = uploadBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });
    if (!file) {
      throw new UnprocessableEntityException({ errorCode: errorCodes.IMAGE_TYPE_UNSUPPORTED });
    }

    return this.images.upload(
      lessonId,
      parsed.data.blockReferenceId,
      Uint8Array.from(file.buffer),
      editorOf(request),
    );
  }

  /**
   * NFR-04: 202 and a jobId, never a request that waits on the provider. The
   * drawer follows the job over the SSE stream from there.
   */
  @Post('lessons/:lessonId/images/generate')
  @HttpCode(202)
  @RequirePermission('generateAndSelectImages')
  @UseGuards(PublishedLockGuard, AssignmentGuard)
  async generate(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
    @Req() request: RequestWithSession,
  ) {
    const parsed = generateBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    return this.images.requestGeneration(lessonId, parsed.data, editorOf(request));
  }

  /**
   * The route carries no lessonId, so WriteTargetResolver resolves this one
   * through the image's own lesson — without that branch both rule guards would
   * stand aside and this write would be unguarded.
   */
  @Patch('images/:imageId')
  @RequirePermission('generateAndSelectImages')
  @UseGuards(PublishedLockGuard, AssignmentGuard)
  async patch(@Param('imageId') imageId: string, @Body() body: unknown) {
    const parsed = patchBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ errorCode: 'INVALID_BODY' });

    return this.images.patch(imageId, parsed.data);
  }
}
