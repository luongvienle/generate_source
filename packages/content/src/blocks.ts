import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';
import type { Nodes, Parent, Root, RootContent, Table } from 'mdast';
import { assignIdentity } from './block-identity';
import {
  emptyBlockList,
  type BlockDraft,
  type BlockList,
  type ParseError,
  type ParseResult,
} from './types';

/**
 * §6.1 block extraction: lesson body markdown in, ordered block list out.
 *
 * An AST, never regular expressions (§6.1). Nothing here stringifies a node back
 * to markdown — `markdown` is the exact source slice — so remark-stringify is
 * deliberately absent and no round-trip fidelity question arises.
 *
 * Pure: no database, no clock, no randomness. It runs unchanged in the browser
 * for the editor's live preview and on the server for the authoritative save,
 * which is what lets the server reparse rather than trust the client.
 */

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkDirective);

/** The figure placeholder. The image, caption and alt text are P3's, in lesson_images. */
const FIGURE_DIRECTIVE = 'figure';
/** GFM has no table caption syntax; §6.1 requires one, so this supplies it. */
const CAPTION_DIRECTIVE = 'caption';

const describeNode = (node: RootContent): string => {
  switch (node.type) {
    case 'thematicBreak':
      return 'a horizontal rule';
    case 'html':
      return 'raw HTML';
    case 'definition':
      return 'a link reference definition';
    case 'footnoteDefinition':
      return 'a footnote definition';
    case 'containerDirective':
    case 'leafDirective':
    case 'textDirective':
      return `an unknown \`::${'name' in node ? node.name : '?'}\` directive`;
    default:
      return `a \`${node.type}\` node`;
  }
};

const positionOf = (node: Nodes): { line: number; column: number } => ({
  line: node.position?.start.line ?? 1,
  column: node.position?.start.column ?? 1,
});

const isParent = (node: Nodes): node is Parent & Nodes =>
  'children' in node && Array.isArray((node as Parent).children);

/** Raw HTML appears as `html` nodes both at block level and inline, so walk everything. */
const collectHtmlErrors = (node: Nodes, errors: ParseError[]): void => {
  if (node.type === 'html') {
    const { line, column } = positionOf(node);
    errors.push({
      message: 'Raw HTML is not allowed in a lesson body. Use markdown, or remove the tag.',
      line,
      column,
    });
  }
  if (isParent(node)) {
    for (const child of node.children) collectHtmlErrors(child, errors);
  }
};

/**
 * Block-level constructs are joined by a newline when flattened; inline ones run
 * together. Without this a three-item list narrates as one run-on word.
 */
const blockLevelTypes = new Set([
  'paragraph',
  'heading',
  'listItem',
  'list',
  'blockquote',
  'code',
  'table',
  'tableRow',
]);

/** The plain-text flattening P4's narration generator reads (§6.3). */
const flattenText = (node: Nodes): string => {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'code') return node.value;
  if (isParent(node)) {
    return node.children
      .map(flattenText)
      .filter((part) => part.length > 0)
      .join(node.children.some((child) => blockLevelTypes.has(child.type)) ? '\n' : '');
  }
  return '';
};

const sliceSource = (source: string, node: Nodes): string => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return flattenText(node);
  return source.slice(start, end);
};

const isFigure = (node: RootContent): boolean =>
  node.type === 'leafDirective' && node.name === FIGURE_DIRECTIVE;

const isCaption = (node: RootContent): boolean =>
  node.type === 'leafDirective' && node.name === CAPTION_DIRECTIVE;

/**
 * Table cells keep their markdown, so the renderer can render each one inline.
 *
 * Sliced from the cell's CHILDREN rather than the cell node itself: a
 * `tableCell`'s own position spans the delimiting pipes, which would put a `|`
 * at the front of every value.
 */
const tableCells = (source: string, table: Table): { headers: string[]; rows: string[][] } => {
  const cellSource = (cell: { children: Nodes[] }): string => {
    const first = cell.children[0];
    const last = cell.children[cell.children.length - 1];
    const start = first?.position?.start.offset;
    const end = last?.position?.end.offset;
    if (start === undefined || end === undefined) return '';
    return source.slice(start, end).trim();
  };

  const [headerRow, ...bodyRows] = table.children;
  const cellsOf = (row: (typeof table.children)[number] | undefined): string[] =>
    row ? row.children.map(cellSource) : [];

  return { headers: cellsOf(headerRow), rows: bodyRows.map(cellsOf) };
};

/**
 * Builds the draft block for one top-level node, or records why it cannot.
 *
 * `captionText` is supplied by a `::caption[…]` directive on the line above a
 * table, which the caller has already consumed.
 */
const toBlockDraft = (
  source: string,
  node: RootContent,
  captionText: string | null,
  errors: ParseError[],
): BlockDraft | undefined => {
  const markdown = sliceSource(source, node);
  const text = flattenText(node);

  // Checked before the switch: `leafDirective` covers both `::figure` and every
  // unknown directive, and a conditional fallthrough would not compile under
  // noFallthroughCasesInSwitch.
  if (isFigure(node)) {
    // The image, caption and alt text that will fill this live in lesson_images (P3).
    return { blockType: 'figure', markdown, text: '' };
  }

  switch (node.type) {
    case 'heading':
      return { blockType: 'heading', markdown, text, depth: node.depth };
    case 'paragraph':
      return { blockType: 'paragraph', markdown, text };
    case 'list':
      return { blockType: 'list', markdown, text, ordered: node.ordered ?? false };
    case 'code':
      return { blockType: 'code', markdown, text, lang: node.lang ?? null };
    case 'blockquote':
      return { blockType: 'blockquote', markdown, text };
    case 'table': {
      const { headers, rows } = tableCells(source, node);
      // §6.3 narrates a table from its number and caption, so `text` is the
      // caption rather than a flattening of every cell.
      return {
        blockType: 'table',
        markdown,
        text: captionText ?? '',
        captionText,
        headers,
        rows,
      };
    }
    default: {
      const { line, column } = positionOf(node);
      errors.push({
        message: `Unsupported construct: ${describeNode(node)} cannot appear in a lesson body.`,
        line,
        column,
      });
      return undefined;
    }
  }
};

/**
 * Assigns `figureNumber` and `tableNumber`, sequentially from 1 and counted
 * separately (§6.1).
 *
 * This is the only place either number is decided. The renderer and P4's
 * narration generator read them; neither recomputes them, which is what stops
 * the page showing "Figure 3" while the audio says "figure two".
 */
const numberFiguresAndTables = (drafts: readonly BlockDraft[]): BlockDraft[] => {
  let figureNumber = 0;
  let tableNumber = 0;

  return drafts.map((draft) => {
    if (draft.blockType === 'figure') {
      figureNumber += 1;
      return { ...draft, figureNumber };
    }
    if (draft.blockType === 'table') {
      tableNumber += 1;
      return { ...draft, tableNumber };
    }
    return draft;
  });
};

/**
 * Re-parses one block's own source slice, for the renderer to recover inline
 * structure from.
 *
 * The renderer stores no inline AST and re-derives nothing of its own: it runs
 * the same pipeline over `Block.markdown`, so what it draws cannot drift from
 * what the parser saw.
 */
export function parseBlockMarkdown(markdown: string): RootContent | undefined {
  const root = processor.parse(markdown) as Root;
  return root.children[0];
}

/**
 * Parses lesson markdown into the §6.1 block list.
 *
 * `previous` is the block list currently stored for this draft; ids are matched
 * against it so FR-EDIT-02's stability holds. Pass `null` for a first parse.
 */
export function parseLessonMarkdown(markdown: string, previous: BlockList | null): ParseResult {
  const root = processor.parse(markdown) as Root;
  const errors: ParseError[] = [];

  collectHtmlErrors(root, errors);

  const drafts: BlockDraft[] = [];
  /** Set by a `::caption[…]`, consumed by the table on the next line. */
  let pendingCaption: { text: string; node: RootContent } | null = null;

  const reportOrphanCaption = (): void => {
    if (!pendingCaption) return;
    const { line, column } = positionOf(pendingCaption.node);
    errors.push({
      message: '`::caption` must be followed immediately by a table.',
      line,
      column,
    });
    pendingCaption = null;
  };

  for (const node of root.children) {
    if (isCaption(node)) {
      reportOrphanCaption();
      pendingCaption = { text: flattenText(node), node };
      continue;
    }

    if (node.type !== 'table') reportOrphanCaption();

    const draft = toBlockDraft(markdown, node, pendingCaption?.text ?? null, errors);
    pendingCaption = null;
    if (draft) drafts.push(draft);
  }

  reportOrphanCaption();

  // FR-EDIT-01: report every error, not the first, and write nothing. Sorted by
  // position because the tree walk finds inline HTML before the top-level pass
  // reaches a later construct, and an editor gutter reads top to bottom.
  if (errors.length > 0) {
    return {
      ok: false,
      errors: [...errors].sort((a, b) => a.line - b.line || a.column - b.column),
    };
  }

  return {
    ok: true,
    blockList: assignIdentity(previous ?? emptyBlockList, numberFiguresAndTables(drafts)),
  };
}
