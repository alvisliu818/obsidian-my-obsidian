/**
 * Clipboard payload builders for the block copy actions (pure — unit-tested
 * under plain vitest, no obsidian / DOM imports).
 *
 * Two shapes make a block re-appear somewhere else:
 *  - embed syntax: `{{embed ((uuid))}}` — rendered inline by this plugin as a
 *    live embedded sub-tree (requires the block to own a stable id).
 *  - markdown: the block's serialized sub-tree, pasted as plain markdown.
 */

import type { Block } from '../types';
import { ensureId } from '../types';
import { serializeBlock } from '../core/serializer';

/** `{{embed ((uuid))}}`; assigns (and returns) a block id when missing. */
export function blockEmbedSyntax(b: Block): string {
  return `{{embed ((${ensureId(b)}))}}`;
}

/** Markdown of one block's whole sub-tree. */
export function blockMarkdown(b: Block): string {
  return serializeBlock(b, 0);
}

/** Embeds for several blocks, one per line. */
export function blocksEmbedSyntax(blocks: Block[]): string {
  return blocks.map(blockEmbedSyntax).join('\n');
}

/** Markdown of several sub-trees (one per block, in order). */
export function blocksMarkdown(blocks: Block[]): string {
  return blocks.map(blockMarkdown).join('\n');
}
