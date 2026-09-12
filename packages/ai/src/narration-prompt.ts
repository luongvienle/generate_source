/**
 * The versioned narration prompt (§6.3, NFR-08).
 *
 * Unlike the image prompt, the version is NOT carried inside the stored string:
 * `narration_scripts` has a `generator_prompt_version` column, so the composed
 * prompt is never persisted at all and the column records which template ran.
 *
 * Changing any wording below REQUIRES incrementing the version. Existing rows
 * are never rewritten.
 */
export const NARRATION_PROMPT_VERSION = 'narration/v1';

/** §6.3: at most 5 representative rows of a table are ever read aloud. */
export const MAX_TABLE_ROWS_IN_PROMPT = 5;

/**
 * What the generator sees for one block.
 *
 * A projection of §6.1's Block, not the Block itself. `markdown` is never sent —
 * it is the raw source slice, which the renderer needs and a narrator does not —
 * and a figure carries the caption and alt text because FR-SCRIPT-03 writes its
 * segment from those two fields and from nothing else.
 */
export interface NarrationInputBlock {
  readonly blockId: string;
  readonly blockType: string;
  readonly text: string;
  readonly figureNumber?: number | null;
  readonly tableNumber?: number | null;
  readonly captionText?: string | null;
  readonly alternativeText?: string | null;
  readonly headers?: readonly string[];
  readonly rows?: readonly (readonly string[])[];
}

export interface NarrationPromptInput {
  readonly blocks: readonly NarrationInputBlock[];
  readonly lessonTitle: string;
  /** §8 makes lessons.learning_objective nullable. */
  readonly learningObjective: string | null;
  readonly languageCode: string;
}

/** The machine-readable manifest, delimited so the fake can read it back. */
export const BLOCK_MANIFEST_OPEN = '<blocks>';
export const BLOCK_MANIFEST_CLOSE = '</blocks>';

interface ManifestEntry {
  blockId: string;
  type: string;
  text?: string;
  figureNumber?: number;
  caption?: string;
  alt?: string;
  tableNumber?: number;
  headers?: readonly string[];
  rows?: readonly (readonly string[])[];
  rowsOmitted?: number;
}

const manifestEntry = (block: NarrationInputBlock): ManifestEntry => {
  const entry: ManifestEntry = { blockId: block.blockId, type: block.blockType };

  if (block.blockType === 'figure') {
    if (typeof block.figureNumber === 'number') entry.figureNumber = block.figureNumber;
    entry.caption = block.captionText ?? '';
    entry.alt = block.alternativeText ?? '';
    return entry;
  }

  if (block.blockType === 'table') {
    if (typeof block.tableNumber === 'number') entry.tableNumber = block.tableNumber;
    if (block.captionText) entry.caption = block.captionText;
    if (block.headers) entry.headers = block.headers;

    const rows = block.rows ?? [];
    // §6.3's "at most 5 representative rows" is enforced by NOT SENDING the
    // rest, so a long table cannot be read in full even if the model ignores
    // the instruction. The count of what was withheld is sent so the narrator
    // can say the table continues rather than implying it ended.
    entry.rows = rows.slice(0, MAX_TABLE_ROWS_IN_PROMPT);
    if (rows.length > MAX_TABLE_ROWS_IN_PROMPT) {
      entry.rowsOmitted = rows.length - MAX_TABLE_ROWS_IN_PROMPT;
    }
    return entry;
  }

  entry.text = block.text;
  return entry;
};

/** §6.3's prompt constraints, verbatim in intent. Do not restate them elsewhere. */
const RULES = [
  'Produce exactly one segment per input block, in the same order, reusing the same blockId values. Never merge, split, skip or reorder blocks.',
  'Restate only what the lesson says. Do not add facts, examples, definitions or opinions that are not in the input.',
  'For a figure block: open by referring to it by its number, then describe what it shows using the caption and alt text.',
  'For a table block: name the table by its number, say what it covers, then read at most five representative rows. Never read a long table in full.',
  'Convert symbols to words: "%" becomes the word for percent, an arrow becomes "leads to", and so on. For inline code, say the name and skip the syntax.',
  'Spoken style: short sentences, no markdown, no bullet characters, and never read a heading aloud as punctuation.',
];

export function composeNarrationPrompt(input: NarrationPromptInput): string {
  const manifest = input.blocks.map(manifestEntry);

  return [
    'You are writing a narration script that will be read aloud from a lesson body.',
    '',
    `Lesson: ${input.lessonTitle}`,
    // A labelled blank invites the model to fill it in, which is exactly the
    // added knowledge FR-SCRIPT-02 forbids. When there is no objective, the
    // line is absent rather than empty.
    ...(input.learningObjective ? [`Learning objective: ${input.learningObjective}`] : []),
    `Write every segment in this language (BCP-47): ${input.languageCode}`,
    '',
    'Rules:',
    ...RULES.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    `The blocks, in order (${String(input.blocks.length)} of them):`,
    BLOCK_MANIFEST_OPEN,
    JSON.stringify(manifest, null, 2),
    BLOCK_MANIFEST_CLOSE,
    '',
    'Reply with JSON only, no prose and no code fence, in exactly this shape:',
    '{"segments":[{"blockId":"<id>","narrationText":"<spoken text>"}],"totalEstimatedSeconds":<integer>}',
  ].join('\n');
}

/** Reads the manifest back out of a composed prompt. Used by the fake provider. */
export function readPromptManifest(promptText: string): readonly ManifestEntry[] {
  const start = promptText.indexOf(BLOCK_MANIFEST_OPEN);
  const end = promptText.indexOf(BLOCK_MANIFEST_CLOSE);
  if (start < 0 || end < 0) return [];

  const json = promptText.slice(start + BLOCK_MANIFEST_OPEN.length, end).trim();
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * §6.3's three rejection conditions, plus unparseable output.
 *
 * Reported as a typed violation rather than thrown, because the retry ladder in
 * narration-run.ts feeds the reason back into the next attempt — a thrown error
 * would be indistinguishable from the transport failures that must escape to
 * BullMQ instead.
 */
export type NarrationViolation =
  | { readonly kind: 'unparseable'; readonly detail: string }
  | { readonly kind: 'count'; readonly expected: number; readonly received: number }
  | { readonly kind: 'unknown-block-id'; readonly blockId: string }
  | { readonly kind: 'order'; readonly position: number; readonly expected: string; readonly received: string };

export type NarrationDecodeResult =
  | { readonly ok: true; readonly segments: ReadonlyMap<string, string>; readonly estimatedSeconds: number | null }
  | { readonly ok: false; readonly violation: NarrationViolation };

/** A human-readable restatement of the violation, fed back into the retry prompt. */
export function describeViolation(violation: NarrationViolation): string {
  switch (violation.kind) {
    case 'unparseable':
      return `Your previous reply was not valid JSON (${violation.detail}). Reply with JSON only — no prose, no code fence.`;
    case 'count':
      return `Your previous reply had ${String(violation.received)} segments but there are ${String(violation.expected)} blocks. Produce exactly one segment per block.`;
    case 'unknown-block-id':
      return `Your previous reply used blockId "${violation.blockId}", which is not one of the blocks given. Reuse the blockId values exactly.`;
    case 'order':
      return `Your previous reply had "${violation.received}" at position ${String(violation.position + 1)} where "${violation.expected}" was expected. Keep the blocks in the order given.`;
  }
}

interface RawSegment {
  readonly blockId?: unknown;
  readonly narrationText?: unknown;
}

/**
 * Strips a code fence if the model added one despite being told not to. This is
 * forgiveness for formatting, never for content — a wrong count, an unknown id
 * or a wrong order is still rejected and retried.
 */
const stripFence = (text: string): string => {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/u.exec(text);
  return fenced?.[1] ?? text;
};

export function decodeNarrationResponse(
  text: string,
  expectedBlockIds: readonly string[],
): NarrationDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch (error) {
    return {
      ok: false,
      violation: {
        kind: 'unparseable',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const body = parsed as { segments?: unknown; totalEstimatedSeconds?: unknown } | null;
  const rawSegments = body?.segments;
  if (!Array.isArray(rawSegments)) {
    return { ok: false, violation: { kind: 'unparseable', detail: 'no segments array' } };
  }

  if (rawSegments.length !== expectedBlockIds.length) {
    return {
      ok: false,
      violation: { kind: 'count', expected: expectedBlockIds.length, received: rawSegments.length },
    };
  }

  const known = new Set(expectedBlockIds);
  const segments = new Map<string, string>();

  for (const [position, raw] of (rawSegments as RawSegment[]).entries()) {
    const blockId = typeof raw?.blockId === 'string' ? raw.blockId : '';
    const narrationText = typeof raw?.narrationText === 'string' ? raw.narrationText : '';

    if (!known.has(blockId)) {
      return { ok: false, violation: { kind: 'unknown-block-id', blockId } };
    }

    const expected = expectedBlockIds[position] as string;
    if (blockId !== expected) {
      return { ok: false, violation: { kind: 'order', position, expected, received: blockId } };
    }

    segments.set(blockId, narrationText);
  }

  const estimate = body?.totalEstimatedSeconds;
  return {
    ok: true,
    segments,
    estimatedSeconds: typeof estimate === 'number' && Number.isFinite(estimate) ? Math.round(estimate) : null,
  };
}
