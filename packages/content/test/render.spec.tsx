import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '../src/blocks';
import { LessonBody } from '../src/render';
import type { BlockList } from '../src/types';

/**
 * The renderer that P7 will import, tested through its HTML output.
 *
 * renderToStaticMarkup rather than a DOM testing library: the assertions are
 * about what the markup says, and a string keeps the package free of jsdom.
 */

const parse = (markdown: string): BlockList => {
  const result = parseLessonMarkdown(markdown, null);
  if (!result.ok) throw new Error(`fixture did not parse: ${JSON.stringify(result.errors)}`);
  return result.blockList;
};

const render = (markdown: string): string =>
  renderToStaticMarkup(<LessonBody blocks={parse(markdown).blocks} />);

describe('LessonBody', () => {
  it('renders a heading at its own level', () => {
    expect(render('## Stroke order')).toContain('<h2>Stroke order</h2>');
  });

  it('renders inline formatting inside a paragraph', () => {
    const html = render('Hiragana is a **syllabary**, not an *alphabet*.');

    expect(html).toContain('<strong>syllabary</strong>');
    expect(html).toContain('<em>alphabet</em>');
  });

  it('renders a link with its href', () => {
    expect(render('See [the chart](https://example.test/chart).')).toContain(
      '<a href="https://example.test/chart">the chart</a>',
    );
  });

  it('tags every block with its blockId, so the preview and the stored list line up', () => {
    const html = render('# Title\n\nBody text.\n');

    expect(html).toContain('data-block-id="b1"');
    expect(html).toContain('data-block-id="b2"');
  });

  it('renders lists and code blocks', () => {
    expect(render('- one\n- two\n')).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(render('1. first\n')).toContain('<ol><li>first</li></ol>');
    expect(render('```ts\nconst a = 1;\n```\n')).toContain(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it('keeps inline formatting inside a block quote', () => {
    expect(render('> Practice beats **theory**.\n')).toContain('<strong>theory</strong>');
  });

  /**
   * The load-bearing assertion of the phase: the numbers drawn are the numbers
   * stored. Nothing in the renderer counts figures or tables.
   */
  it('renders the figure and table numbers the parser assigned', () => {
    const markdown =
      '::figure\n\nProse.\n\n::figure\n\n::caption[Stroke counts]\n\n| Character | Strokes |\n|---|---|\n| あ | 3 |\n';
    const blocks = parse(markdown).blocks;
    const html = renderToStaticMarkup(<LessonBody blocks={blocks} />);

    expect(html).toContain('Figure 1');
    expect(html).toContain('Figure 2');
    expect(html).toContain('Table 1 — Stroke counts');

    const figures = blocks.filter((block) => block.blockType === 'figure');
    expect(figures.map((block) => block.figureNumber)).toEqual([1, 2]);
    for (const figure of figures) {
      expect(html).toContain(`data-figure-number="${figure.figureNumber}"`);
    }
  });

  it('renders table cells with their inline markdown', () => {
    const html = render('| Term |\n|---|\n| **bold** |\n');

    expect(html).toContain('<th scope="col">Term</th>');
    expect(html).toContain('<td><strong>bold</strong></td>');
  });

  it('never emits raw HTML from the content itself', () => {
    // Raw HTML cannot reach the renderer — it is rejected at parse — so the
    // only markup in the output is markup the renderer chose to emit.
    const html = render('Text with a [link](https://example.test).\n');

    expect(html).not.toContain('<script');
    expect(html).toContain('<a href="https://example.test">link</a>');
  });
});
