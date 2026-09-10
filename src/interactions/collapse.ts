/**
 * Block collapse state operations.
 * Collapse is persisted via the Logseq `collapsed:: true` block property.
 */

import type { Block } from '../types';
import { setCollapsed } from '../types';

export function toggleCollapse(b: Block): void {
  setCollapsed(b, b.props['collapsed'] !== 'true');
}

export function collapseAll(roots: Block[]): void {
  const walk = (b: Block) => {
    if (b.children.length > 0) {
      setCollapsed(b, true);
      b.children.forEach(walk);
    }
  };
  roots.forEach(walk);
}

export function expandAll(roots: Block[]): void {
  const walk = (b: Block) => {
    setCollapsed(b, false);
    b.children.forEach(walk);
  };
  roots.forEach(walk);
}
