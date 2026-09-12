import { blockTypeSchema, type BlockType } from '@knowledge-explorer/shared';

export type { BlockType };
export { blockTypeSchema };

/**
 * One entry of the §6.1 block list.
 *
 * `blockId` is minted from a shared counter (§6.1: "derived from a stable
 * counter persisted with the draft, not from content hashing"). The numeral in
 * it is a mint sequence and never a figure or table number — `fig8` may carry
 * `figureNumber: 1`. See FR-EDIT-02 and block-identity.ts.
 *
 * `markdown` is the block's exact source slice, which the renderer re-parses for
 * inline formatting; `text` is a plain-text flattening, which is what P4's
 * narration generator reads (§6.3).
 */
export interface Block {
  readonly blockId: string;
  readonly blockType: BlockType;
  readonly markdown: string;
  readonly text: string;
  /** heading only: 1–6. */
  readonly depth?: number;
  /** list only. */
  readonly ordered?: boolean;
  /** code only; null for a fence with no language. */
  readonly lang?: string | null;
  /** figure only: 1-based, counted within the lesson. */
  readonly figureNumber?: number;
  /** table only: 1-based, counted separately from figures. */
  readonly tableNumber?: number;
  /** table only, from the `::caption[…]` directive above it. */
  readonly captionText?: string | null;
  /** table only. Cells are markdown, rendered inline. */
  readonly headers?: readonly string[];
  /** table only. */
  readonly rows?: readonly (readonly string[])[];
}

/** A block before identity is assigned; see block-identity.ts. */
export type BlockDraft = Omit<Block, 'blockId'>;

/**
 * What `lesson_contents.draft_block_list` holds.
 *
 * `lessonTitle` is deliberately absent though §6.1's example shows it: §6.3
 * passes it to the narration generator separately, and storing it here would
 * make renaming a lesson change the checksum and mark every approved script
 * stale for a change no learner hears.
 */
export interface BlockList {
  readonly blocks: readonly Block[];
  /** The shared counter. Only ever advances, so a retired id is never reissued. */
  readonly nextBlockSeq: number;
}

/**
 * What P3 fills a figure block's slot with (§6.2, FR-IMG-03).
 *
 * `url` is short-lived and presigned; it is never persisted anywhere and never
 * equals `lesson_images.image_file_url`, which stores an object key. Caption and
 * alt text come from the SELECTED candidate — the only row either is read from.
 */
export interface FigureImage {
  readonly url: string;
  readonly captionText: string;
  readonly alternativeText: string;
}

/**
 * Keyed by `blockId`, never by figure number: the number moves when a figure is
 * inserted above, and the id does not (FR-EDIT-02).
 */
export type FigureImages = ReadonlyMap<string, FigureImage>;

/** FR-EDIT-01: every error is reported with its position, never just the first. */
export interface ParseError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export type ParseResult =
  | { readonly ok: true; readonly blockList: BlockList }
  | { readonly ok: false; readonly errors: readonly ParseError[] };

export const emptyBlockList: BlockList = { blocks: [], nextBlockSeq: 1 };
