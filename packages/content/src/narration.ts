import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { normalizeBlockText } from './block-identity';
import { blockChecksum, canonicalJson } from './checksum';
import type { AudioStatus, ScriptStatus } from '@knowledge-explorer/shared';
import type { Block } from './types';

/**
 * §6.3 narration segments: the shape stored in `narration_scripts.script_segments`.
 *
 * §8 gives that column no structure, so this module is the only definition of
 * it. It lives beside the block checksums rather than in packages/shared for two
 * reasons: it must hash with the same `normalizeBlockText` and the same
 * @noble/hashes primitive checksum.ts uses, and the admin review tab renders it
 * in the browser — so it is bound by the isomorphism constraint and
 * test/isomorphic.spec.ts covers it for free.
 */

export interface NarrationSegment {
  readonly blockId: string;
  /**
   * 0-based, and redundant with array order. Stored anyway because P5 writes it
   * into `audio_segments.segment_order`, which is UNIQUE per audio row —
   * deriving it from array position there would make P5 depend on JSON array
   * ordering surviving a round trip through Prisma's Json type.
   */
  readonly segmentOrder: number;
  readonly narrationText: string;
  /**
   * SHA-256 of the normalized narration text. THIS IS THE FIELD P5 DIFFS.
   *
   * FR-AUDIO-01 re-synthesizes only stale segments, and §8 gives `lesson_audios`
   * only a whole-script `source_script_checksum` while `audio_segments` has no
   * checksum column at all. Without a per-segment hash there is no evidence
   * anywhere in the schema for WHICH segment moved, and FR-AUDIO-01 cannot be
   * implemented. The JSONB is P4's to shape, so this costs no migration.
   */
  readonly segmentChecksum: string;
  /** The §6.5 link to the block this was generated from; see narrationStaleness. */
  readonly sourceBlockChecksum: string;
  /** A human has rewritten this since it was generated (FR-SCRIPT-04). */
  readonly isEdited: boolean;
}

/**
 * An envelope rather than a bare array, because §6.3's response carries
 * `totalEstimatedSeconds` alongside the segments and §8 gives it no column.
 *
 * The estimate is the model's, summed across chunks, and is shown to an admin as
 * an approximate runtime. P5 never reads it — it measures real durations with
 * ffmpeg. It is an estimate stored as an estimate.
 */
export interface NarrationScriptSegments {
  readonly segments: readonly NarrationSegment[];
  readonly totalEstimatedSeconds: number | null;
}

export const narrationSegmentSchema = z.strictObject({
  blockId: z.string().min(1),
  segmentOrder: z.number().int().min(0),
  narrationText: z.string(),
  segmentChecksum: z.string().min(1),
  sourceBlockChecksum: z.string().min(1),
  isEdited: z.boolean(),
});

export const narrationScriptSegmentsSchema = z.strictObject({
  segments: z.array(narrationSegmentSchema),
  totalEstimatedSeconds: z.number().int().nonnegative().nullable(),
});

export const emptyScriptSegments: NarrationScriptSegments = {
  segments: [],
  totalEstimatedSeconds: null,
};

/**
 * §8 stores the envelope as JSONB and Prisma hands it back as `unknown`.
 * Mirrors readBlockList: a row that does not parse reads as empty rather than
 * throwing, so one malformed row cannot take down the lesson list.
 */
export const readScriptSegments = (value: unknown): NarrationScriptSegments => {
  const parsed = narrationScriptSegmentsSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyScriptSegments;
};

/** SHA-256 of the whitespace-normalized narration text, hex. */
export function segmentChecksum(narrationText: string): string {
  return bytesToHex(sha256(utf8ToBytes(normalizeBlockText(narrationText))));
}

/**
 * The §6.5 `script_checksum`: SHA-256 over the ordered (blockId, segmentChecksum)
 * pairs, so it moves when any segment's text moves AND when two segments are
 * transposed. This is what `lesson_audios.source_script_checksum` will point at.
 */
export function scriptChecksum(segments: readonly NarrationSegment[]): string {
  const canonical = canonicalJson(
    segments.map((segment) => [segment.blockId, segment.segmentChecksum]),
  );
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/** Builds a segment, computing both checksums, so no caller assembles one by hand. */
export function buildSegment(input: {
  readonly block: Block;
  readonly segmentOrder: number;
  readonly narrationText: string;
  readonly isEdited: boolean;
}): NarrationSegment {
  return {
    blockId: input.block.blockId,
    segmentOrder: input.segmentOrder,
    narrationText: input.narrationText,
    segmentChecksum: segmentChecksum(input.narrationText),
    sourceBlockChecksum: blockChecksum(input.block),
    isEdited: input.isEdited,
  };
}

/**
 * FR-IMG-03 completeness, as one predicate.
 *
 * FR-SCRIPT-03 writes a figure's narration from the caption and the alt text and
 * from nothing else, so an empty caption here is a paid call that produces a
 * paragraph describing nothing, which P5 then voices. The rule lives here rather
 * than in apps/api because the worker re-checks it in a different process and a
 * second copy would be free to drift.
 */
export type FigureInputField = 'selectedImage' | 'captionText' | 'alternativeText';

export interface FigureNarrationInput {
  readonly hasSelected: boolean;
  readonly captionText: string;
  readonly alternativeText: string;
}

export interface IncompleteFigure {
  readonly blockId: string;
  readonly figureNumber: number | null;
  readonly missing: readonly FigureInputField[];
}

const isFilled = (value: string): boolean => value.trim().length > 0;

export function figureInputGaps(input: FigureNarrationInput): readonly FigureInputField[] {
  const missing: FigureInputField[] = [];
  if (!input.hasSelected) missing.push('selectedImage');
  if (!isFilled(input.captionText)) missing.push('captionText');
  if (!isFilled(input.alternativeText)) missing.push('alternativeText');
  return missing;
}

export const isFigureInputComplete = (input: FigureNarrationInput): boolean =>
  figureInputGaps(input).length === 0;

/**
 * Every figure block that cannot yet be narrated, in document order.
 *
 * A figure block with no entry in the lookup has no image row at all, which is
 * the same gap as an unselected one.
 */
export function figuresMissingNarrationInput(
  blocks: readonly Block[],
  inputByBlockId: ReadonlyMap<string, FigureNarrationInput>,
): readonly IncompleteFigure[] {
  const gaps: IncompleteFigure[] = [];

  for (const block of blocks) {
    if (block.blockType !== 'figure') continue;

    const input = inputByBlockId.get(block.blockId) ?? {
      hasSelected: false,
      captionText: '',
      alternativeText: '',
    };
    const missing = figureInputGaps(input);
    if (missing.length > 0) {
      gaps.push({ blockId: block.blockId, figureNumber: block.figureNumber ?? null, missing });
    }
  }

  return gaps;
}

/**
 * §6.5 staleness detail, per block.
 *
 * THESE THREE SETS DO NOT DECIDE WHETHER A SCRIPT IS STALE. §6.5 defines that
 * as `source_content_checksum` differing from the lesson's current
 * `draft_content_checksum`, and the API computes it that way. These sets are the
 * detail behind it: which rows to badge, and which segments P5 must re-synthesize.
 *
 * They can legitimately all be empty while the script is stale. Moving two
 * paragraphs without editing either changes the list checksum — array order is
 * part of it — while every block's own checksum is unchanged. The reconciliation
 * below repairs that case by reordering rather than regenerating, which is why
 * no set reports it. Do not derive staleness from these.
 */
export interface NarrationStaleness {
  /** Block and segment both exist; the block's content moved under it. */
  readonly changedBlockIds: readonly string[];
  /** Block exists with no segment — added since the script was generated. */
  readonly missingBlockIds: readonly string[];
  /** Segment exists whose block is gone — deleted since. */
  readonly orphanedSegmentBlockIds: readonly string[];
}

export function narrationStaleness(
  blocks: readonly Block[],
  segments: readonly NarrationSegment[],
): NarrationStaleness {
  const segmentByBlockId = new Map(segments.map((segment) => [segment.blockId, segment]));
  const blockIds = new Set(blocks.map((block) => block.blockId));

  const changedBlockIds: string[] = [];
  const missingBlockIds: string[] = [];

  for (const block of blocks) {
    const segment = segmentByBlockId.get(block.blockId);
    if (!segment) {
      missingBlockIds.push(block.blockId);
      continue;
    }
    if (segment.sourceBlockChecksum !== blockChecksum(block)) {
      changedBlockIds.push(block.blockId);
    }
  }

  return {
    changedBlockIds,
    missingBlockIds,
    orphanedSegmentBlockIds: segments
      .filter((segment) => !blockIds.has(segment.blockId))
      .map((segment) => segment.blockId),
  };
}

export interface ReconcileResult {
  /** In block-list order, one per block, with segmentOrder reassigned. */
  readonly segments: readonly NarrationSegment[];
  /** Segments carried over untouched, including any hand-edited text. */
  readonly preservedBlockIds: readonly string[];
  /** Previous segments whose block no longer exists. */
  readonly droppedBlockIds: readonly string[];
}

/**
 * Regeneration preserves an admin's edits on blocks that did not change.
 *
 * A block whose checksum still matches its segment's `sourceBlockChecksum` keeps
 * that segment verbatim — hand-edited text and `isEdited` included. Everything
 * else takes the newly generated text. A previous segment whose block is gone is
 * dropped.
 *
 * `segmentOrder` is REASSIGNED from block position even on a preserved segment,
 * so moving a paragraph reorders its narration without regenerating it.
 *
 * Approval is not this function's business: the caller clears it on every run,
 * including a run where every segment was preserved, because a run writes
 * machine text that no human has read.
 */
export function reconcileSegments(input: {
  readonly previous: readonly NarrationSegment[];
  readonly generated: ReadonlyMap<string, string>;
  readonly blocks: readonly Block[];
}): ReconcileResult {
  const previousByBlockId = new Map(input.previous.map((segment) => [segment.blockId, segment]));
  const blockIds = new Set(input.blocks.map((block) => block.blockId));

  const segments: NarrationSegment[] = [];
  const preservedBlockIds: string[] = [];

  input.blocks.forEach((block, index) => {
    const previous = previousByBlockId.get(block.blockId);

    if (previous && previous.sourceBlockChecksum === blockChecksum(block)) {
      segments.push({ ...previous, segmentOrder: index });
      preservedBlockIds.push(block.blockId);
      return;
    }

    const narrationText = input.generated.get(block.blockId);
    if (narrationText === undefined) {
      // The run orchestrator asserts its stitched output against the same block
      // list before this is ever called, so reaching here is a bug in that
      // assertion rather than a bad model response. Fail loudly.
      throw new Error(`reconcileSegments: no generated text for block ${block.blockId}`);
    }

    segments.push(buildSegment({ block, segmentOrder: index, narrationText, isEdited: false }));
  });

  return {
    segments,
    preservedBlockIds,
    droppedBlockIds: input.previous
      .filter((segment) => !blockIds.has(segment.blockId))
      .map((segment) => segment.blockId),
  };
}

/**
 * §6.5 computed statuses — `stale` exists here and NEVER in the database.
 *
 * These two functions are the whole of §6.5's second and third links. They lived
 * in apps/api's narration and audio services until P6, which needed them in two
 * places at once: the API serves them on read, and the publish worker re-checks
 * them before writing the published track. apps/api and apps/worker never import
 * each other, so the rule moved to the package both already depend on — beside
 * `narrationStaleness`, which is the first link and was always here.
 *
 * They are pure functions over plain rows, which is what lets the publish
 * checklist evaluate a whole course from batch-loaded data rather than calling a
 * per-lesson service method forty times.
 */

export type ComputedScriptStatus = ScriptStatus | null;
export type ComputedAudioStatus = AudioStatus | null;

/**
 * §6.5: a script is stale when its source checksum differs from the lesson's
 * current content checksum.
 *
 * `failed` OUTRANKS `stale` — a failed row is not `ready`, and the failure is the
 * more actionable fact. That falls out of only promoting `ready`, rather than
 * being a special case.
 */
export function computeScriptStatus(
  stored: string | null,
  sourceContentChecksum: string | null,
  contentChecksum: string | null,
): ComputedScriptStatus {
  if (stored === null) return null;
  if (stored !== 'ready') return stored as ScriptStatus;
  return sourceContentChecksum === contentChecksum ? 'ready' : 'stale';
}

/**
 * §6.5's script→audio link.
 *
 * `stale` when a stored `ready` no longer matches the script's current checksum —
 * OR when the course's configured voice has moved on. The voice clause is what
 * FR-AUDIO-03's "stored with each audio row so a voice change is detectable" is
 * FOR; detection with no consequence would be a column nobody reads. `failed`
 * outranks `stale`, because a failed run is the more actionable fact.
 */
export function computeAudioStatus(
  audio: { audioStatus: string; sourceScriptChecksum: string; voiceIdentifier: string },
  currentScriptChecksum: string | null,
  configuredVoiceIdentifier: string,
): ComputedAudioStatus {
  if (audio.audioStatus !== 'ready') return audio.audioStatus as AudioStatus;

  const scriptMoved =
    currentScriptChecksum !== null && audio.sourceScriptChecksum !== currentScriptChecksum;
  const voiceMoved = audio.voiceIdentifier !== configuredVoiceIdentifier;

  return scriptMoved || voiceMoved ? 'stale' : 'ready';
}
