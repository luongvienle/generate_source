import { UnrecoverableError, type Job } from 'bullmq';
import type { PrismaClient } from '@knowledge-explorer/database';
import type { GenerateNarrationScriptJobData } from '@knowledge-explorer/shared';
import {
  NARRATION_CHUNK_BLOCK_COUNT,
  NARRATION_CHUNK_MAX_TRIES,
  NARRATION_RUN_MAX_CALLS,
  errorCodes,
} from '@knowledge-explorer/shared';
import {
  NARRATION_PROMPT_VERSION,
  runNarration,
  type LlmProvider,
  type NarrationInputBlock,
} from '@knowledge-explorer/ai';
import {
  figuresMissingNarrationInput,
  reconcileSegments,
  readScriptSegments,
  scriptChecksum,
  type Block,
  type BlockList,
  type FigureNarrationInput,
} from '@knowledge-explorer/content';

/**
 * FR-SCRIPT-01: turn one generate_narration_script job into a narration script.
 *
 * THE WRITE IS ALL OR NOTHING. Segments are held in memory for the whole run and
 * written in one transaction only after every chunk has validated and the
 * stitched list has been asserted against the block list. A failed run sets
 * script_status = 'failed' and leaves the segments, both checksums and the review
 * fields untouched — an admin's reviewed script is never replaced by a
 * half-written one. The spend on the chunks that did succeed is the price.
 *
 * WHAT THROWS AND WHAT DOES NOT:
 *   - A §6.3 violation that survived its retry ladder, or a precondition that no
 *     longer holds, throws UnrecoverableError: BullMQ will not retry it, and
 *     withJobLifecycle records the row as failed on this attempt.
 *   - A transport error propagates as an ordinary Error, so NFR-03's three
 *     attempts with exponential backoff apply — that is the right response to a
 *     timeout and the wrong one to a model that returned 24 of 25 segments.
 */

const emptyBlockList: BlockList = { blocks: [], nextBlockSeq: 1 };

const readBlockList = (value: unknown): BlockList =>
  value && typeof value === 'object' && 'blocks' in value && 'nextBlockSeq' in value
    ? (value as BlockList)
    : emptyBlockList;

/** §6.3's input projection. `markdown` is never sent; a figure carries its caption and alt. */
function toInputBlocks(
  blocks: readonly Block[],
  figureInputs: ReadonlyMap<string, FigureNarrationInput>,
): readonly NarrationInputBlock[] {
  return blocks.map((block): NarrationInputBlock => {
    const base = { blockId: block.blockId, blockType: block.blockType, text: block.text };

    if (block.blockType === 'figure') {
      const image = figureInputs.get(block.blockId);
      return {
        ...base,
        figureNumber: block.figureNumber ?? null,
        captionText: image?.captionText ?? null,
        alternativeText: image?.alternativeText ?? null,
      };
    }

    if (block.blockType === 'table') {
      return {
        ...base,
        tableNumber: block.tableNumber ?? null,
        captionText: block.captionText ?? null,
        ...(block.headers ? { headers: block.headers } : {}),
        ...(block.rows ? { rows: block.rows } : {}),
      };
    }

    return base;
  });
}

export function createNarrationProcessor(
  prisma: PrismaClient,
  provider: LlmProvider,
): (job: Job) => Promise<unknown> {
  return async (job: Job) => {
    const data = job.data as GenerateNarrationScriptJobData;
    const { lessonId } = data;

    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    /**
     * Clears the in-flight lock. Called on every terminal path INCLUDING a
     * transport failure on the last attempt — otherwise three timeouts would
     * leave script_status = 'generating' forever and the lesson could never be
     * regenerated from the UI.
     */
    const markFailed = async (): Promise<void> => {
      await prisma.narrationScript.updateMany({
        where: { lessonId },
        data: { scriptStatus: 'failed' },
      });
    };

    try {
      const lesson = await prisma.lesson.findFirst({
        where: { id: lessonId, deletedAt: null },
        select: {
          title: true,
          learningObjective: true,
          chapter: { select: { course: { select: { languageCode: true } } } },
        },
      });
      if (!lesson) throw new UnrecoverableError(`lesson ${lessonId} no longer exists`);

      const content = await prisma.lessonContent.findUnique({
        where: { lessonId },
        select: { draftBlockList: true, draftContentChecksum: true },
      });

      const blocks = readBlockList(content?.draftBlockList).blocks;
      if (blocks.length === 0) {
        throw new UnrecoverableError(errorCodes.SCRIPT_LESSON_EMPTY);
      }

      /**
       * `source_content_checksum` takes the STORED draft_content_checksum rather
       * than a fresh recomputation. That column is what §6.5 compares against on
       * read, and the content service writes it in the same transaction as the
       * block list — so storing anything else here would make every script
       * permanently stale against a value it should equal.
       */
      const sourceContentChecksum = content?.draftContentChecksum ?? '';

      const selected = await prisma.lessonImage.findMany({
        where: { lessonId, isSelected: true },
        select: { blockReferenceId: true, captionText: true, alternativeText: true },
      });
      const figureInputs = new Map<string, FigureNarrationInput>(
        selected.map((row) => [
          row.blockReferenceId,
          { hasSelected: true, captionText: row.captionText, alternativeText: row.alternativeText },
        ]),
      );

      // Re-checked here, not only at enqueue: the enqueue-time check exists to
      // answer synchronously and spend nothing, and this one closes the race
      // where a caption was emptied between enqueue and execution.
      const incomplete = figuresMissingNarrationInput(blocks, figureInputs);
      if (incomplete.length > 0) {
        throw new UnrecoverableError(
          `${errorCodes.SCRIPT_FIGURES_INCOMPLETE}: ${incomplete
            .map((figure) => `${figure.blockId}(${figure.missing.join(',')})`)
            .join(' ')}`,
        );
      }

      const run = await runNarration({
        blocks: toInputBlocks(blocks, figureInputs),
        lessonTitle: lesson.title,
        learningObjective: lesson.learningObjective,
        languageCode: lesson.chapter.course.languageCode,
        provider,
        constants: {
          chunkBlockCount: NARRATION_CHUNK_BLOCK_COUNT,
          chunkMaxTries: NARRATION_CHUNK_MAX_TRIES,
          runMaxCalls: NARRATION_RUN_MAX_CALLS,
        },
        // Only a VALIDATED chunk moves the counter, so a retry never rewinds it.
        onChunkDone: async (done, total) => {
          await job.updateProgress({ done, total });
        },
      });

      if (!run.ok) {
        await markFailed();
        throw new UnrecoverableError(describeRunFailure(run.failure));
      }

      const previous = readScriptSegments(
        (
          await prisma.narrationScript.findUnique({
            where: { lessonId },
            select: { scriptSegments: true },
          })
        )?.scriptSegments,
      ).segments;

      const reconciled = reconcileSegments({ previous, generated: run.segments, blocks });

      await prisma.narrationScript.update({
        where: { lessonId },
        data: {
          scriptSegments: {
            segments: reconciled.segments,
            totalEstimatedSeconds: run.totalEstimatedSeconds,
          } as unknown as object,
          scriptChecksum: scriptChecksum(reconciled.segments),
          sourceContentChecksum,
          scriptStatus: 'ready',
          generatorModelName: run.modelName,
          generatorPromptVersion: NARRATION_PROMPT_VERSION,
          inputTokenCount: run.inputTokenCount,
          outputTokenCount: run.outputTokenCount,
          // FR-SCRIPT-04: a RUN always clears approval, even when every segment
          // was preserved. A run writes machine text no human has read, which is
          // exactly what approval attests against. A hand edit, by contrast,
          // keeps it — see NarrationService.update.
          reviewedByUserId: null,
          reviewedAt: null,
        },
      });

      return {
        segmentCount: reconciled.segments.length,
        preserved: reconciled.preservedBlockIds.length,
        dropped: reconciled.droppedBlockIds.length,
        chunkCount: run.chunkCount,
        callCount: run.callCount,
      };
    } catch (error) {
      // A transport error on the last attempt is still terminal for the lesson:
      // without this the lock would survive every retry and wedge it.
      if (isFinalAttempt || error instanceof UnrecoverableError) await markFailed();
      throw error;
    }
  };
}

function describeRunFailure(failure: {
  reason: string;
  chunkIndex?: number;
  tries?: number;
  violation?: { kind: string };
  calls?: number;
  detail?: string;
}): string {
  switch (failure.reason) {
    case 'chunk-rejected':
      return `chunk ${String((failure.chunkIndex ?? 0) + 1)} rejected after ${String(failure.tries ?? 0)} tries (${failure.violation?.kind ?? 'unknown'})`;
    case 'call-ceiling':
      return `run exceeded the provider call ceiling at ${String(failure.calls ?? 0)} calls`;
    default:
      return `stitched output did not match the block list: ${failure.detail ?? ''}`;
  }
}
