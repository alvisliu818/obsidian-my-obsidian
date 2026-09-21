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
  if (doc.frontmatter) parts.push(doc.frontmatter);
  if (doc.pageProps) parts.push(doc.pageProps);
  for (const b of doc.blocks) {
    parts.push(serializeBlock(b, 0));
  }
  return parts.join('\n');
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
