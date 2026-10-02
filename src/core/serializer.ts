/**
 * Block tree → Markdown serializer (Logseq file format).
 *
 * - One tab per nesting depth, `- ` list markers, `TODO/DOING/DONE` markers.
 * - Properties emitted as indented `key:: value` child lines (insertion order).
 * - In-block soft line breaks are re-indented one level deeper than the block.
 * - Raw blocks are emitted verbatim.
 */

import { Block, ParsedDocument } from '../types';

export function serializeDocument(doc: ParsedDocument): string {
  const parts: string[] = [];
  const blocks = doc.blocks;
  if (doc.frontmatter && !blocks[0]?.frontmatter) parts.push(doc.frontmatter);
  if (doc.pageProps) parts.push(doc.pageProps);
  // Obsidian-format page properties: a frontmatter-sourced props-only first
  // block round-trips as the `---` fenced frontmatter (format preserved).
  if (blocks[0]?.frontmatter) {
    const fm = blocks[0];
    parts.push('---', ...fm.text.split('\n'), '---');
    for (const c of fm.children) parts.push(serializeBlock(c, 0));
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      // Logseq props-only blocks after the frontmatter keep their format too.
      if (isPropsOnlyBlock(b)) {
        for (const [k, v] of Object.entries(b.props)) parts.push(`${k}:: ${v}`);
        for (const c of b.children) parts.push(serializeBlock(c, 0));
      } else {
        parts.push(serializeBlock(b, 0));
      }
    }
    return parts.join('\n');
  }
  // Logseq model: a first block holding ONLY properties is the page-properties
  // block — its props are written as the unindented file-top lines, and its
  // children (if any) shift up to top level.
  if (isPropsOnlyBlock(blocks[0])) {
    const pb = blocks[0];
    for (const [k, v] of Object.entries(pb.props)) parts.push(`${k}:: ${v}`);
    for (const c of pb.children) parts.push(serializeBlock(c, 0));
    for (let i = 1; i < blocks.length; i++) parts.push(serializeBlock(blocks[i], 0));
    return parts.join('\n');
  }
  for (const b of blocks) {
    parts.push(serializeBlock(b, 0));
  }
  return parts.join('\n');
}

/** The page-properties block: an empty-text first block that only carries props. */
function isPropsOnlyBlock(b: Block | undefined): boolean {
  return !!b && b.kind === 'list' && b.text === '' && Object.keys(b.props).length > 0;
}

export function serializeBlock(b: Block, depth: number, skipProps?: readonly string[]): string {
  if (b.kind === 'raw') return b.text;

  const prefix = '\t'.repeat(depth);
  const marker = b.marker ? b.marker + ' ' : '';
  const textLines = b.text.split('\n');
  const out: string[] = [];
  out.push(`${prefix}- ${marker}${textLines[0]}`);
  const softPrefix = '\t'.repeat(depth + 1);
  for (let k = 1; k < textLines.length; k++) {
    out.push(softPrefix + textLines[k]);
  }
  for (const key of Object.keys(b.props)) {
    if (skipProps?.includes(key)) continue;
    out.push(`${softPrefix}${key}:: ${b.props[key]}`);
  }
  for (const c of b.children) {
    out.push(serializeBlock(c, depth + 1, skipProps));
  }
  return out.join('\n');
}

/** Bookkeeping props that are meaningless in an embed / drag-drop preview. */
export const PREVIEW_SKIP_PROPS: readonly string[] = ['id', 'collapsed'];

/**
 * Serialize the content of one block (used for embeds and drag & drop):
 * the block's own text followed by its children as a top-level list.
 *
 * Children are emitted at depth 0 — a tab-indented list cannot interrupt a
 * paragraph, so the old `depth + 1` output collapsed the whole sub-tree into a
 * single run-on paragraph when rendered as markdown.
 */
export function serializeBlockContent(b: Block): string {
  const lines = b.text.split('\n');
  const out: string[] = [];
  for (const line of lines) out.push(line);
  if (b.children.length > 0) out.push(''); // blank line: safe block break
  for (const c of b.children) out.push(serializeBlock(c, 0, PREVIEW_SKIP_PROPS));
  return out.join('\n');
}
