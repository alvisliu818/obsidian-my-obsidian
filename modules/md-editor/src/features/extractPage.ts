/**
 * Extract blocks to their own page ("document block", SiYuan style).
 *
 * The whole point is that the note stays readable afterwards: the subtree
 * leaves, and an embed of the new page takes its place, so the reader follows
 * a link instead of a wall of inlined detail. Both sides stay plain markdown —
 * the new page is an ordinary `.md` file, and the reference is an ordinary
 * `![[Page]]` embed.
 *
 * Naming and reference syntax are pure functions here so they can be tested
 * without a vault: a filename derived from a block title is exactly the kind of
 * thing that silently produces `Notes/a/b?.md` or an over-long path.
 *
 * Pure logic — no obsidian import.
 */

import { serializeBlock } from '../core/serializer';
import type { Block } from '../types';

/** Characters Obsidian (and Windows) refuse in a file name. */
const ILLEGAL_RE = /[\\/:*?"<>|#^[\]]/g;
/** Obsidian's own ceiling; longer names are unwieldy in the file explorer. */
export const MAX_NAME_LEN = 100;
/** First line of a block, trimmed of markdown noise, used as a page title. */
const TITLE_NOISE_RE = /^[#>\-*\s]+|[`*_~[\]()]/g;

/**
 * Derive a file name from a block's text.
 *
 * Returns '' when the block carries no usable text (an empty block, or one
 * whose only content is markup) — the caller must then ask the user rather
 * than invent a name.
 */
export function pageNameFor(text: string): string {
  const first = (text.split('\n')[0] ?? '').trim();
  if (!first) return '';
  // Strip leading list/heading markers and inline markup so `- **Foo**` and
  // `Foo` do not produce two different pages for the same idea.
  const cleaned = first.replace(TITLE_NOISE_RE, ' ').replace(ILLEGAL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > MAX_NAME_LEN ? cleaned.slice(0, MAX_NAME_LEN).trim() : cleaned;
}

/**
 * A file name that does not collide with anything already in the vault.
 *
 * `Report` → `Report`, `Report 1`, `Report 2` … The suffix is appended to the
 * BASE name, never to the extension, and the comparison is case-insensitive
 * because macOS and Windows filesystems are.
 */
export function uniquePageName(base: string, taken: readonly string[]): string {
  const clean = base.replace(ILLEGAL_RE, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
  const has = (n: string): boolean => taken.some((t) => t.toLowerCase() === n.toLowerCase());
  if (!has(clean)) return clean;
  // "Report 1" may itself be taken, so probe every candidate rather than
  // stopping at the first gap.
  for (let i = 1; i < 1000; i++) {
    const candidate = `${clean} ${i}`;
    if (!has(candidate)) return candidate;
  }
  return `${clean} ${Date.now()}`;
}

/** The `![[Page]]` embed left behind in the original position. */
export function pageEmbedSyntax(pageName: string): string {
  return `![[${pageName}]]`;
}

/**
 * The markdown written to the new page.
 *
 * The extracted blocks are serialized as top-level blocks, so the new page is
 * a normal outline rather than a single blob — it can be edited, indented and
 * dragged like any other page.
 */
export function extractedPageMarkdown(blocks: readonly Block[]): string {
  return blocks.map((b) => serializeBlock(b, 0)).join('\n');
}

/**
 * Replace a block with an embed of `pageName`, in place.
 *
 * The new block is inserted exactly where the old one was — same parent, same
 * sibling position — and the old subtree is detached (the caller has already
 * serialized it into the destination page, so nothing is lost).
 * Returns the new block so the caller can focus it.
 */
export function replaceWithPageEmbed(
  roots: Block[],
  target: Block,
  pageName: string,
): Block | null {
  const embed: Block = {
    kind: 'list',
    marker: null,
    text: pageEmbedSyntax(pageName),
    props: {},
    children: [],
    parent: null,
  };
  const parent = target.parent;
  const sibs = parent ? parent.children : roots;
  const at = sibs.indexOf(target);
  if (at < 0) return null;
  // Detach the sub-tree BEFORE unlinking: `target` may be a root, and leaving
  // it linked would keep a phantom parent pointing at the moved blocks.
  target.children = [];
  target.parent = null;
  // Remove the original, then put the embed in the slot it vacated — splicing
  // twice at the same index is what keeps the position exact.
  sibs.splice(at, 1);
  sibs.splice(at, 0, embed);
  embed.parent = parent;
  return embed;
}

/** Convenience: what the notice should say. */
export function extractNotice(blockCount: number, pageName: string): string {
  return blockCount > 1
    ? `Extracted ${blockCount} blocks to ${pageName}`
    : `Extracted to ${pageName}`;
}
