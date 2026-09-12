import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { normalizeBlockText } from './block-identity';
import type { Block, BlockList } from './types';

/**
 * §6.5: the head of the staleness chain.
 *
 *   lesson_contents.draft_content_checksum
 *       └─→ narration_scripts.source_content_checksum
 *               └─→ lesson_audios.source_script_checksum
 *
 * A script is stale when its source checksum differs from this value, so what
 * this hashes decides what costs an admin a regeneration. It therefore covers
 * exactly what a downstream consumer can observe — the block list's semantic
 * content — and nothing else:
 *
 *   - `markdown` is EXCLUDED. It is the raw source slice, which changes when a
 *     paragraph is reflowed or a trailing space is added. Including it would
 *     mark an approved narration script stale for a change no learner hears.
 *   - `text` is NORMALIZED for the same reason: a soft line break inside a
 *     paragraph changes the raw text and changes nothing a narrator would say.
 *   - `nextBlockSeq` is EXCLUDED: the counter is bookkeeping, not content.
 *   - `blockId` is INCLUDED, because P4 keys its segments by it.
 *
 * @noble/hashes rather than `node:crypto`, which the isomorphism constraint
 * bans, or `crypto.subtle`, which is async and would make every caller async.
 */

/** The projection of a block that downstream artifacts can actually observe. */
const semanticProjection = (block: Block): Record<string, unknown> => {
  const projection: Record<string, unknown> = {
    blockId: block.blockId,
    blockType: block.blockType,
    text: normalizeBlockText(block.text),
  };

  if (block.depth !== undefined) projection['depth'] = block.depth;
  if (block.ordered !== undefined) projection['ordered'] = block.ordered;
  if (block.lang !== undefined) projection['lang'] = block.lang;
  if (block.figureNumber !== undefined) projection['figureNumber'] = block.figureNumber;
  if (block.tableNumber !== undefined) projection['tableNumber'] = block.tableNumber;
  if (block.captionText !== undefined) {
    projection['captionText'] =
      block.captionText === null ? null : normalizeBlockText(block.captionText);
  }
  if (block.headers !== undefined) {
    projection['headers'] = block.headers.map(normalizeBlockText);
  }
  if (block.rows !== undefined) {
    projection['rows'] = block.rows.map((row) => row.map(normalizeBlockText));
  }

  return projection;
};

/** JSON with object keys sorted, so key order cannot change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

/** The §6.5 `draft_content_checksum`: SHA-256 of the canonical block list, hex. */
export function blockListChecksum(blockList: BlockList): string {
  const canonical = canonicalJson(blockList.blocks.map(semanticProjection));
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/**
 * The same projection, hashed for ONE block. P4's narration segments store this
 * as `sourceBlockChecksum`, which is how regeneration tells an edited block from
 * an untouched one and how §6.5 staleness is reported per block rather than per
 * lesson.
 *
 * DELIBERATELY NOT the definition of blockListChecksum above. Redefining the
 * list hash as a hash over these would be tidier and would change every stored
 * `draft_content_checksum`, marking every existing lesson changed for a refactor
 * nobody asked for. The two are independent by choice; the pinned fixtures in
 * test/checksum.spec.ts exist to make that choice fail loudly if it is revisited.
 */
export function blockChecksum(block: Block): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(semanticProjection(block)))));
}
