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
  // A leaf block has no children to focus — show the block itself.
  return zoomed.children.length > 0 ? zoomed.children : [zoomed];
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
/**
 * 面包屑摘要：raw HTML 块（Word 导出常见的跨行 <img> 标签）直接取首行会把
 *  原文漏进面包屑，换成可读的 [图片]/[代码块] 摘要。
 */
function crumbLabel(b: Block): string {
  const first = (b.text || '').split('\n')[0].trim();
  if (!first) return '…';
  if (b.kind === 'raw') {
    if (/^<img\b/i.test(first)) {
      const src = /src="([^"]*)"/i.exec(b.text)?.[1] ?? '';
      const name = src.split('/').pop() || 'image';
      return `[图片] ${name}`;
    }
    if (/^<iframe|^<video|^<audio|^<embed/i.test(first)) return '[嵌入]';
    if (/^`{3,}|^~{3,}/.test(first)) {
      const lang = first.match(/^`{3,}|^~{3,}(.*)$/)?.[1]?.trim();
      return lang ? `[代码块] ${lang}` : '[代码块]';
    }
  }
  return first;
}

export function breadcrumbFor(doc: ParsedDocument, zoomed: Block | null, fileLabel: string): BreadcrumbEntry[] {
  const entries: BreadcrumbEntry[] = [{ block: null, label: fileLabel }];
  if (!zoomed || !stillInForest(doc, zoomed)) return entries;
  for (const b of pathToRoot(zoomed)) {
    entries.push({ block: b, label: crumbLabel(b) });
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
