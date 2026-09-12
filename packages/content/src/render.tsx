import type { ReactElement, ReactNode } from 'react';
import type { Nodes, PhrasingContent, RootContent } from 'mdast';
import { parseBlockMarkdown } from './blocks';
import type { Block, FigureImage, FigureImages } from './types';

/**
 * The lesson body renderer, shared by the admin editor's preview pane (P2) and
 * the learner reader (P7), so FR-EDIT-01's "renders exactly what the learner
 * will see" holds by construction rather than by discipline.
 *
 * Reached as `@knowledge-explorer/content/render`, never from the package
 * barrel: apps/api and apps/worker import the barrel and must not pull React.
 *
 * It renders from the BLOCK LIST, never from raw markdown. Figure and table
 * numbers, table cells and captions all come from the stored block — §6.1:
 * "Renderer and narration generator both read these numbers; neither recomputes
 * them". Inline formatting is the one thing re-derived, by re-parsing the
 * block's own source slice through the same pipeline the parser used.
 *
 * No `dangerouslySetInnerHTML` anywhere. Raw HTML is rejected at parse, so there
 * is never any to render.
 */

const isParent = (node: Nodes): node is Nodes & { children: Nodes[] } =>
  'children' in node && Array.isArray((node as { children?: unknown }).children);

const renderChildren = (nodes: readonly Nodes[]): ReactNode =>
  nodes.map((node, index) => renderNode(node, index));

/** One mdast node to React. Covers exactly the §5.3 dialect; nothing else parses. */
function renderNode(node: Nodes, key: number): ReactNode {
  switch (node.type) {
    // Inline
    case 'text':
      return node.value;
    case 'strong':
      return <strong key={key}>{renderChildren(node.children)}</strong>;
    case 'emphasis':
      return <em key={key}>{renderChildren(node.children)}</em>;
    case 'delete':
      return <del key={key}>{renderChildren(node.children)}</del>;
    case 'inlineCode':
      return <code key={key}>{node.value}</code>;
    case 'break':
      return <br key={key} />;
    case 'link':
      return (
        <a key={key} href={node.url} {...(node.title ? { title: node.title } : {})}>
          {renderChildren(node.children)}
        </a>
      );

    // Block
    case 'paragraph':
      return <p key={key}>{renderChildren(node.children)}</p>;
    case 'heading':
      return <Heading key={key} depth={node.depth}>{renderChildren(node.children)}</Heading>;
    case 'list':
      return node.ordered ? (
        <ol key={key}>{renderChildren(node.children)}</ol>
      ) : (
        <ul key={key}>{renderChildren(node.children)}</ul>
      );
    case 'listItem':
      return <li key={key}>{renderLooseItem(node.children)}</li>;
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node.children)}</blockquote>;
    case 'code':
      return (
        <pre key={key}>
          <code {...(node.lang ? { className: `language-${node.lang}` } : {})}>{node.value}</code>
        </pre>
      );

    default:
      return isParent(node) ? renderChildren(node.children) : null;
  }
}

/**
 * A single-paragraph list item renders without the `<p>`, which is how markdown
 * renderers conventionally treat a tight list.
 */
const renderLooseItem = (children: readonly Nodes[]): ReactNode => {
  const only = children.length === 1 ? children[0] : undefined;
  if (only && only.type === 'paragraph') return renderChildren(only.children);
  return renderChildren(children);
};

const Heading = ({ depth, children }: { depth: number; children: ReactNode }): ReactElement => {
  switch (depth) {
    case 1:
      return <h1>{children}</h1>;
    case 2:
      return <h2>{children}</h2>;
    case 3:
      return <h3>{children}</h3>;
    case 4:
      return <h4>{children}</h4>;
    case 5:
      return <h5>{children}</h5>;
    default:
      return <h6>{children}</h6>;
  }
};

/** Renders a block's own source slice, for everything except figures and tables. */
const RenderedSource = ({ block }: { block: Block }): ReactNode => {
  const node: RootContent | undefined = parseBlockMarkdown(block.markdown);
  if (!node) return block.text;
  return renderNode(node, 0);
};

/** One table cell: markdown, rendered inline the same way a paragraph's is. */
const Cell = ({ markdown }: { markdown: string }): ReactNode => {
  const node = parseBlockMarkdown(markdown);
  if (node && node.type === 'paragraph') {
    return renderChildren(node.children as readonly PhrasingContent[]);
  }
  return markdown;
};

/**
 * §6.1: a figure's image, caption and alt text live in `lesson_images`.
 *
 * With no entry in the images map this is still P2's numbered slot — which is
 * what an unillustrated figure looks like in the editor, and what the parser
 * test suite asserts. The figure number always comes from the block; §6.1
 * assigns numbering during extraction "and nowhere else", so it is never
 * recomputed here.
 *
 * Rendered through `<img>` and never as inline SVG, so an uploaded SVG cannot
 * execute even if it somehow reached here unsanitized.
 */
const Figure = ({ block, image }: { block: Block; image?: FigureImage }): ReactElement => {
  if (!image) {
    return (
      <figure data-figure-number={block.figureNumber}>
        <div className="figure-placeholder">Figure {block.figureNumber}</div>
      </figure>
    );
  }

  return (
    <figure data-figure-number={block.figureNumber}>
      <img src={image.url} alt={image.alternativeText} />
      <figcaption>
        Figure {block.figureNumber}
        {image.captionText ? <> — {image.captionText}</> : null}
      </figcaption>
    </figure>
  );
};

const TableBlock = ({ block }: { block: Block }): ReactElement => (
  <figure data-table-number={block.tableNumber}>
    <figcaption>
      Table {block.tableNumber}
      {block.captionText ? <> — {block.captionText}</> : null}
    </figcaption>
    <table>
      <thead>
        <tr>
          {(block.headers ?? []).map((header, index) => (
            <th key={index} scope="col">
              <Cell markdown={header} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(block.rows ?? []).map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>
                <Cell markdown={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </figure>
);

const renderBlock = (block: Block, images: FigureImages | undefined): ReactNode => {
  switch (block.blockType) {
    case 'figure':
      return <Figure block={block} image={images?.get(block.blockId)} />;
    case 'table':
      return <TableBlock block={block} />;
    default:
      return <RenderedSource block={block} />;
  }
};

/**
 * `images` is optional and defaults to empty, so every P2 call site and every
 * existing test keeps working untouched.
 *
 * No click handling lives here. This renderer is shared with the learner reader
 * (P7) and an editor interaction has no business in it; the admin editor
 * delegates from its preview container instead, reading the `data-figure-number`
 * this markup already emits.
 */
export function LessonBody({
  blocks,
  images,
}: {
  blocks: readonly Block[];
  images?: FigureImages;
}): ReactElement {
  return (
    <div className="lesson-body">
      {blocks.map((block) => (
        <div key={block.blockId} data-block-id={block.blockId}>
          {renderBlock(block, images)}
        </div>
      ))}
    </div>
  );
}
