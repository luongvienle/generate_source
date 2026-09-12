import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  figuresMissingNarrationInput,
  isFigureInputComplete,
  type Block,
  type FigureNarrationInput,
  type IncompleteFigure,
} from '@knowledge-explorer/content';
import { errorCodes, type ImageSource } from '@knowledge-explorer/shared';
import {
  OBJECT_STORAGE,
  mintImageKey,
  prepareUpload,
  type ImageMediaType,
  type ObjectStorage,
} from '@knowledge-explorer/storage';
import { composeImagePrompt } from '@knowledge-explorer/ai';
import { createQueuedJob, markJobAttemptFailed } from '@knowledge-explorer/database';
import { PrismaService } from '../prisma/prisma.service';
import { ImageQueue } from '../jobs/image.queue';
import { readBlockList, resolveEditability, type Editor } from './lesson-content.service';

/**
 * §5.4 lesson images: candidates, selection, caption and alt text.
 *
 * Two rules shape almost everything here:
 *
 * - **Nothing is ever deleted.** Rows whose figure block was removed from the
 *   markdown keep existing and simply stop being returned, and a regeneration
 *   appends rather than replacing. A lesson-body edit can never destroy
 *   generated work.
 * - **Caption and alt text describe the FIGURE, not the candidate**, even
 *   though §8 puts the columns on `lesson_images`. Selecting a different
 *   candidate carries both across, so an admin writes them once.
 */

export interface ImageCandidateView {
  readonly imageId: string;
  /** Short-lived and presigned. Never `lesson_images.image_file_url`, which is a key. */
  readonly url: string;
  readonly imageSource: ImageSource;
  readonly imagePromptText: string | null;
  readonly imageModelName: string | null;
  readonly imageProviderName: string | null;
  readonly isSelected: boolean;
  readonly createdAt: Date;
}

export interface FigureView {
  readonly blockId: string;
  readonly figureNumber: number | null;
  readonly candidates: readonly ImageCandidateView[];
  readonly selectedImageId: string | null;
  readonly captionText: string;
  readonly alternativeText: string;
  /** FR-IMG-03: one selected candidate, and both text fields non-empty. */
  readonly isComplete: boolean;
}

export interface LessonImagesView {
  readonly lessonId: string;
  readonly figures: readonly FigureView[];
  readonly isComplete: boolean;
  readonly canEdit: boolean;
  readonly readOnlyReason: string | null;
}

interface ImageRow {
  id: string;
  blockReferenceId: string;
  imageFileUrl: string;
  captionText: string;
  alternativeText: string;
  imageSource: string;
  imagePromptText: string | null;
  imageModelName: string | null;
  imageProviderName: string | null;
  isSelected: boolean;
  createdAt: Date;
}

interface LessonRow {
  id: string;
  contentStatus: string;
  assignedAdminId: string | null;
  chapter: { course: { id: string; publicationStatus: string } };
}

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ImageQueue) private readonly queue: ImageQueue,
  ) {}

  private async loadLesson(lessonId: string): Promise<LessonRow> {
    const lesson = await this.prisma.client.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      select: {
        id: true,
        contentStatus: true,
        assignedAdminId: true,
        chapter: { select: { course: { select: { id: true, publicationStatus: true } } } },
      },
    });
    if (!lesson) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
    return lesson;
  }

  /** The lesson's figure blocks, in document order, from the STORED block list. */
  private async figureBlocks(lessonId: string): Promise<readonly Block[]> {
    const content = await this.prisma.client.lessonContent.findUnique({
      where: { lessonId },
      select: { draftBlockList: true },
    });
    return readBlockList(content?.draftBlockList).blocks.filter(
      (block) => block.blockType === 'figure',
    );
  }

  /**
   * §6.2 requires exactly one selected candidate per block, so the figure's
   * caption and alt text are read from that row and from nowhere else.
   */
  private async toFigureView(block: Block, rows: readonly ImageRow[]): Promise<FigureView> {
    const mine = rows.filter((row) => row.blockReferenceId === block.blockId);
    const selected = mine.find((row) => row.isSelected);

    const candidates = await Promise.all(
      mine.map(async (row): Promise<ImageCandidateView> => {
        const { id, imageFileUrl, imageSource, ...rest } = row;
        return {
          imageId: id,
          url: await this.storage.presignGet(imageFileUrl),
          imageSource: imageSource as ImageSource,
          imagePromptText: rest.imagePromptText,
          imageModelName: rest.imageModelName,
          imageProviderName: rest.imageProviderName,
          isSelected: rest.isSelected,
          createdAt: rest.createdAt,
        };
      }),
    );

    const captionText = selected?.captionText ?? '';
    const alternativeText = selected?.alternativeText ?? '';

    return {
      blockId: block.blockId,
      figureNumber: block.figureNumber ?? null,
      candidates,
      selectedImageId: selected?.id ?? null,
      captionText,
      alternativeText,
      // FR-IMG-03, from the one shared predicate — P4's worker re-checks the
      // same rule in a different process and a second copy would be free to drift.
      isComplete: isFigureInputComplete({
        hasSelected: selected !== undefined,
        captionText,
        alternativeText,
      }),
    };
  }

  /**
   * Rows are read for the whole lesson and then matched to blocks, so a row
   * whose figure block no longer exists is simply never matched — the
   * keep-and-hide rule, with no query for orphans and no deletion anywhere.
   */
  async read(lessonId: string, editor: Editor): Promise<LessonImagesView> {
    const lesson = await this.loadLesson(lessonId);
    const blocks = await this.figureBlocks(lessonId);

    const rows = await this.prisma.client.lessonImage.findMany({
      where: { lessonId },
      // `id` breaks the tie DELIBERATELY. A generation writes its whole
      // candidate set in one createMany, so those rows share a createdAt to the
      // microsecond and ordering by it alone is unstable — the drawer would
      // reshuffle candidates between reads and "the second one" would stop
      // meaning anything.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const figures = await Promise.all(blocks.map((block) => this.toFigureView(block, rows)));

    return {
      lessonId,
      figures,
      isComplete: figures.every((figure) => figure.isComplete),
      ...resolveEditability(lesson, editor),
    };
  }

  /** One figure, for the response to a write that targeted it. */
  private async readFigure(lessonId: string, blockReferenceId: string): Promise<FigureView> {
    const blocks = await this.figureBlocks(lessonId);
    const block = blocks.find((candidate) => candidate.blockId === blockReferenceId);
    if (!block) {
      throw new UnprocessableEntityException({ errorCode: errorCodes.IMAGE_BLOCK_NOT_FOUND });
    }

    const rows = await this.prisma.client.lessonImage.findMany({
      where: { lessonId, blockReferenceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return this.toFigureView(block, rows);
  }

  /**
   * Every figure that cannot yet be narrated (FR-SCRIPT-03), for P4's enqueue-time
   * refusal.
   *
   * Deliberately NOT `read()`: that presigns a URL for every candidate of every
   * figure, which a precondition check has no use for. The completeness rule
   * itself is the shared predicate, so this cannot disagree with what the drawer
   * shows.
   */
  async incompleteFigures(lessonId: string): Promise<readonly IncompleteFigure[]> {
    const blocks = await this.figureBlocks(lessonId);
    const selected = await this.prisma.client.lessonImage.findMany({
      where: { lessonId, isSelected: true },
      select: { blockReferenceId: true, captionText: true, alternativeText: true },
    });

    const inputs = new Map<string, FigureNarrationInput>(
      selected.map((row) => [
        row.blockReferenceId,
        { hasSelected: true, captionText: row.captionText, alternativeText: row.alternativeText },
      ]),
    );

    return figuresMissingNarrationInput(blocks, inputs);
  }

  /** Refuses a blockReferenceId that is not a figure block in the stored list. */
  async assertFigureBlock(lessonId: string, blockReferenceId: string): Promise<Block> {
    const blocks = await this.figureBlocks(lessonId);
    const block = blocks.find((candidate) => candidate.blockId === blockReferenceId);
    if (!block) {
      throw new UnprocessableEntityException({ errorCode: errorCodes.IMAGE_BLOCK_NOT_FOUND });
    }
    return block;
  }

  /**
   * FR-IMG-02 manual upload. Synchronous: it calls nothing external, so NFR-04's
   * "no request waits on a provider" does not apply.
   *
   * The object is written BEFORE the row, so a row never points at bytes that
   * are not there. The reverse failure — an object with no row — is an orphan,
   * which is harmless and which P10 reclaims.
   */
  async upload(
    lessonId: string,
    blockReferenceId: string,
    bytes: Uint8Array,
    editor: Editor,
  ): Promise<FigureView> {
    await this.assertFigureBlock(lessonId, blockReferenceId);

    const prepared = prepareUpload(bytes);
    if (!prepared.ok) throw new UnprocessableEntityException({ errorCode: prepared.errorCode });

    const imageId = randomUUID();
    const key = mintImageKey({
      lessonId,
      blockReferenceId,
      imageId,
      contentType: prepared.contentType satisfies ImageMediaType,
    });

    await this.storage.put(key, prepared.bytes, prepared.contentType);

    await this.prisma.client.lessonImage.create({
      data: {
        id: imageId,
        lessonId,
        blockReferenceId,
        imageFileUrl: key,
        // §8 makes both NOT NULL, and a candidate has neither until it is
        // chosen. Empty string is the unwritten state the completeness check reads.
        captionText: '',
        alternativeText: '',
        imageSource: 'uploaded' satisfies ImageSource,
        isSelected: false,
        createdByUserId: editor.userId,
        // figure_number is deliberately left NULL: §6.1 assigns numbering during
        // block extraction "and nowhere else", and a copy here would go stale
        // the moment a figure is inserted above this one.
      },
    });

    return this.readFigure(lessonId, blockReferenceId);
  }

  /**
   * §9.3 PATCH /images/:imageId — select, and set caption and alt text.
   *
   * Selection clears every sibling in the same transaction, which is what holds
   * §6.2's one-selected invariant: §8 defines no partial unique index for it and
   * P3 opens no migration.
   */
  async patch(
    imageId: string,
    changes: {
      isSelected?: boolean | undefined;
      captionText?: string | undefined;
      alternativeText?: string | undefined;
    },
  ): Promise<FigureView> {
    const image = await this.prisma.client.lessonImage.findUnique({
      where: { id: imageId },
      select: { id: true, lessonId: true, blockReferenceId: true },
    });
    if (!image) throw new NotFoundException({ errorCode: errorCodes.IMAGE_NOT_FOUND });

    const { lessonId, blockReferenceId } = image;

    await this.prisma.client.$transaction(async (tx) => {
      let captionText = changes.captionText;
      let alternativeText = changes.alternativeText;

      if (changes.isSelected === true) {
        const previous = await tx.lessonImage.findFirst({
          where: { lessonId, blockReferenceId, isSelected: true },
          select: { id: true, captionText: true, alternativeText: true },
        });

        // Caption and alt follow the figure. An explicit value in this request
        // still wins, so the admin can select and retitle in one action.
        if (previous && previous.id !== imageId) {
          captionText ??= previous.captionText;
          alternativeText ??= previous.alternativeText;
        }

        await tx.lessonImage.updateMany({
          where: { lessonId, blockReferenceId, isSelected: true },
          data: { isSelected: false },
        });
      }

      await tx.lessonImage.update({
        where: { id: imageId },
        data: {
          ...(changes.isSelected === undefined ? {} : { isSelected: changes.isSelected }),
          ...(captionText === undefined ? {} : { captionText }),
          ...(alternativeText === undefined ? {} : { alternativeText }),
        },
      });
    });

    return this.readFigure(lessonId, blockReferenceId);
  }

  /**
   * FR-IMG-01: generate 2-4 candidates as a background job.
   *
   * NFR-04 forbids an HTTP request waiting on a provider, so this validates,
   * composes, records and enqueues — and returns 202. Everything that can be
   * refused is refused here, before a job exists: an unknown block writes no
   * row and enqueues nothing.
   *
   * The prompt is composed ONCE, at enqueue time, and travels with the job. A
   * retry therefore re-sends the prompt the admin actually requested rather
   * than recomposing against a template that may have been revised since.
   */
  async requestGeneration(
    lessonId: string,
    input: { blockReferenceId: string; imagePromptText: string; candidateCount: number },
    editor: Editor,
  ): Promise<{ jobId: string; generationJobId: string }> {
    await this.assertFigureBlock(lessonId, input.blockReferenceId);

    const lesson = await this.prisma.client.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      select: {
        title: true,
        chapter: { select: { course: { select: { languageCode: true } } } },
      },
    });
    if (!lesson) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });

    const composedPrompt = composeImagePrompt({
      adminPromptText: input.imagePromptText,
      lessonTitle: lesson.title,
      languageCode: lesson.chapter.course.languageCode,
    });

    // targetEntityId is the lesson: the column is a UUID and a blockId is not.
    // The block travels in the job payload instead.
    const job = await createQueuedJob(
      this.prisma.client.generationJob,
      { jobType: 'generate_image', targetEntityId: lessonId },
      this.logger,
    );

    try {
      const jobId = await this.queue.enqueueGenerate({
        generationJobId: job.id,
        lessonId,
        blockReferenceId: input.blockReferenceId,
        composedPrompt,
        candidateCount: input.candidateCount,
        createdByUserId: editor.userId,
      });
      return { jobId, generationJobId: job.id };
    } catch (error) {
      await markJobAttemptFailed(this.prisma.client.generationJob, job.id, {
        attemptCount: 0,
        errorMessage: `could not enqueue: ${error instanceof Error ? error.message : String(error)}`,
        isFinalAttempt: true,
      });
      throw new InternalServerErrorException({ errorCode: 'IMAGE_ENQUEUE_FAILED' });
    }
  }

  /**
   * NFR-05: image counts per lesson, aggregated per course.
   *
   * Derived from rows rather than a counter column: generation writes one row
   * per candidate, so the data NFR-05 asks for is already captured. Uploads are
   * excluded — they cost nothing. §9.2's endpoint that would expose this is
   * deferred to P10, because §3 has no permission row for viewing cost data.
   */
  async generatedImageCounts(
    courseId: string,
  ): Promise<{ courseId: string; total: number; perLesson: Record<string, number> }> {
    const grouped = await this.prisma.client.lessonImage.groupBy({
      by: ['lessonId'],
      where: {
        imageSource: 'ai_generated' satisfies ImageSource,
        lesson: { chapter: { courseId } },
      },
      _count: { _all: true },
    });

    const perLesson: Record<string, number> = {};
    for (const row of grouped) perLesson[row.lessonId] = row._count._all;

    return {
      courseId,
      total: grouped.reduce((sum, row) => sum + row._count._all, 0),
      perLesson,
    };
  }
}
