import { describe, expect, it } from 'vitest';
import { parseLessonMarkdown } from '@knowledge-explorer/content';
import { htmlToMarkdown } from '../lib/paste-as-markdown';

/**
 * The contract that makes pasting safe: whatever comes out of the converter must
 * be markdown the lesson parser accepts.
 *
 * Raw HTML is a save-time validation error, so a paste that smuggled a tag
 * through would leave the admin with content they cannot save and no obvious
 * cause.
 */

const parses = (markdown: string): boolean => parseLessonMarkdown(markdown, null).ok;

describe('htmlToMarkdown', () => {
  it('converts ordinary rich text', () => {
    expect(htmlToMarkdown('<h2>Title</h2><p>Some <strong>bold</strong> text.</p>')).toBe(
      '## Title\n\nSome **bold** text.',
    );
  });

  it('converts lists', () => {
    expect(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')).toBe('-   one\n-   two');
  });

  it('converts a table, which is why the GFM rules are loaded', () => {
    const markdown = htmlToMarkdown(
      '<table><thead><tr><th>Character</th><th>Romaji</th></tr></thead>' +
        '<tbody><tr><td>あ</td><td>a</td></tr></tbody></table>',
    );

    expect(markdown).toContain('| Character | Romaji |');
    expect(markdown).toContain('| あ | a |');
    expect(parses(markdown)).toBe(true);
  });

  it('drops a script, an iframe and a div wrapper without leaving a tag behind', () => {
    const markdown = htmlToMarkdown(
      '<div><script>alert(1)</script><p>Kept text.</p>' +
        '<iframe src="https://example.test"></iframe></div>',
    );

    expect(markdown).toBe('Kept text.');
    expect(parses(markdown)).toBe(true);
  });

  it('drops images rather than emitting an inline image the dialect forbids', () => {
    expect(htmlToMarkdown('<p>Before</p><img src="x.png" alt="x"><p>After</p>')).toBe(
      'Before\n\nAfter',
    );
  });

  it('drops a horizontal rule, which §5.3 does not support', () => {
    const markdown = htmlToMarkdown('<p>One</p><hr><p>Two</p>');

    expect(markdown).not.toContain('---');
    expect(parses(markdown)).toBe(true);
  });

  /** The property that matters, over a messy realistic paste. */
  it('always produces markdown the lesson parser accepts', () => {
    const messy =
      '<div class="wrapper"><h1>Lesson</h1><p>Text with <span style="color:red">span</span>' +
      ' and <a href="https://example.test">a link</a>.</p>' +
      '<blockquote>Quoted.</blockquote><pre><code>const a = 1;</code></pre>' +
      '<figure><img src="x.png"><figcaption>Caption</figcaption></figure>' +
      '<script>evil()</script></div>';

    const markdown = htmlToMarkdown(messy);

    expect(markdown).not.toMatch(/<[a-z]/iu);
    expect(parses(markdown)).toBe(true);
  });
});
