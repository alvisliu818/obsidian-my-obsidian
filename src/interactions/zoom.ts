/**
 * Zoom (focus) mode helpers: when zoomed into a block, the editor shows that
 * block's children; the breadcrumb shows the root-to-block chain.
 */

import type { Block, ParsedDocument } from '../types';
import { blockId } from '../types';
import { findBlockById, pathToRoot } from '../core/treeOps';

/** Blocks shown in the editor body for the current zoom state. */
export function visibleRootsFor(doc: ParsedDocument, zoomed: Block | null): Block[] {
  if (!zoomed) return doc.blocks;
  if (!stillInForest(doc, zoomed)) return doc.blocks; // zoomed block was deleted
  return zoomed.children;
}

function stillInForest(doc: ParsedDocument, b: Block): boolean {
  let cur: Block | null = b;
  while (cur.parent) cur = cur.parent;
  return doc.blocks.includes(cur);
}

export interface BreadcrumbEntry {
  block: Block | null; // null = the file itself
  label: string;
}

/** Breadcrumb chain: file → ancestors → zoomed block. */
export function breadcrumbFor(doc: ParsedDocument, zoomed: Block | null, fileLabel: string): BreadcrumbEntry[] {
  const entries: BreadcrumbEntry[] = [{ block: null, label: fileLabel }];
  if (!zoomed || !stillInForest(doc, zoomed)) return entries;
  for (const b of pathToRoot(zoomed)) {
    entries.push({ block: b, label: b.text.split('\n')[0].trim() || '…' });
  }
  return entries;
}

/** Restore a zoomed block from a persisted state id. */
export function restoreZoomed(doc: ParsedDocument, zoomedBlockId: string): Block | null {
  if (!zoomedBlockId) return null;
  const b = findBlockById(doc.blocks, zoomedBlockId);
  return b ?? null;
}

export function zoomId(b: Block | null): string {
  return b ? blockId(b) : '';
}
