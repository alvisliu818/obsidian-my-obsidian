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

export function serializeBlock(b: Block, depth: number): string {
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
    out.push(`${softPrefix}${key}:: ${b.props[key]}`);
  }
  for (const c of b.children) {
    out.push(serializeBlock(c, depth + 1));
  }
  return out.join('\n');
}

/** Serialize the visible sub-tree of one block (used for block-reference previews). */
export function serializeBlockContent(b: Block): string {
  const lines = b.text.split('\n');
  const out: string[] = [];
  out.push(lines[0]);
  for (let k = 1; k < lines.length; k++) out.push(lines[k]);
  for (const c of b.children) out.push(serializeBlock(c, 1));
  return out.join('\n');
}
