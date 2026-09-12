import TurndownService from 'turndown';
// @ts-expect-error -- turndown-plugin-gfm ships no type declarations.
import { tables, strikethrough } from 'turndown-plugin-gfm';

/**
 * Converts a rich-text paste to markdown.
 *
 * Raw HTML is rejected at parse (§5.3's supported list is closed), so pasting
 * from Word or a web page would otherwise produce content the save refuses.
 * Turndown emits no raw HTML of its own — its `keep` list is empty — so the
 * work here is to drop what has no markdown equivalent rather than to escape it.
 *
 * The GFM table rules are loaded because pasting a table is a real authoring
 * path for this product: the first course is a language course and its lessons
 * are full of pronunciation tables.
 */

const service = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});

service.use([tables, strikethrough]);

// Dropped with their content: none of it belongs in a lesson body, and a
// <script> reaching the editor at all is worth being decisive about.
service.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form', 'input']);

/** A lesson figure is a `::figure` slot filled by P3, never an inline image. */
service.addRule('dropImages', {
  filter: 'img',
  replacement: () => '',
});

/** `---` is not in the dialect (§5.3); a paste must not introduce one. */
service.addRule('dropRules', {
  filter: 'hr',
  replacement: () => '\n\n',
});

export function htmlToMarkdown(html: string): string {
  return service
    .turndown(html)
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
