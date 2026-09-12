import type { Block, BlockList } from '@knowledge-explorer/content';

/**
 * Maps a figure the admin clicked in the PREVIEW onto the blockId the SERVER
 * knows it by.
 *
 * This exists because the two are not the same thing. P2's preview parses the
 * live buffer with no previous block list, so the ids it renders are
 * display-only and need not match the stored ones (see lesson-editor.tsx). The
 * images API is keyed by the stored blockId, so clicking has to be translated.
 *
 * The translation is by FIGURE NUMBER, which §6.1 assigns during extraction as
 * a 1-based count within the lesson — so it is exactly the figure's ordinal
 * position, in both the preview's parse and the server's.
 *
 * That equality only holds while the buffer and the server agree, which is why
 * a dirty buffer or a failed parse resolves to nothing: the caller must flush
 * the pending save and retry with the block list that comes back.
 */
export interface FigureResolutionInput {
  /** The block list the content endpoint returned — the authoritative one. */
  readonly savedBlockList: BlockList | null;
  /** From `data-figure-number` on the clicked <figure>. */
  readonly figureNumber: number | null;
  /** The editor buffer differs from what the server has accepted. */
  readonly isDirty: boolean;
  /** The buffer currently parses. */
  readonly parseOk: boolean;
}

export function resolveFigureBlockId(input: FigureResolutionInput): string | null {
  const { savedBlockList, figureNumber, isDirty, parseOk } = input;

  if (isDirty || !parseOk) return null;
  if (!savedBlockList || figureNumber === null) return null;

  const match = savedBlockList.blocks.find(
    (block: Block) => block.blockType === 'figure' && block.figureNumber === figureNumber,
  );
  return match?.blockId ?? null;
}

/** Reads the figure number off the clicked element's nearest <figure>. */
export function figureNumberFromEvent(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;

  const figure = target.closest('figure[data-figure-number]');
  const raw = figure?.getAttribute('data-figure-number');
  if (!raw) return null;

  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
