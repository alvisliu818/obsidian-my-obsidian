/**
 * Right-click block menu (Logseq-style): copy reference / copy markdown,
 * duplicate, delete, cycle TODO, collapse, zoom. Uses Obsidian's Menu API so
 * theming, positioning and outside-click dismissal come for free.
 */

import { Menu, Notice } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import { blockFromEl } from '../blocks/renderTree';
import { ensureId, isCollapsed, setCollapsed, type Block } from '../types';
import { serializeBlock } from '../core/serializer';
import { cycleMarker, duplicateBlock, isDescendant, removeBlock } from '../core/treeOps';
import { openMoveToFileModal } from '../features/moveToFile';

export function attachContextMenu(container: HTMLElement, host: BlockEditorView): void {
  container.addEventListener('contextmenu', (ev) => {
    const b = blockFromEl(ev.target as HTMLElement | null);
    if (!b) return;
    ev.preventDefault();
    openBlockMenu(ev.clientX, ev.clientY, b, host);
  });

  // Touch long-press (500ms, 8px jitter tolerance) → the same block menu.
  let lpTimer: number | null = null;
  let lpXY: { x: number; y: number } | null = null;
  container.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length !== 1) return;
      const t = ev.touches[0];
      const b = blockFromEl(ev.target as HTMLElement | null);
      if (!b) return;
      lpXY = { x: t.clientX, y: t.clientY };
      lpTimer = window.setTimeout(() => {
        lpTimer = null;
        openBlockMenu(t.clientX, t.clientY, b, host);
      }, 500);
    },
    { passive: true },
  );
  const cancel = (): void => {
    if (lpTimer !== null) {
      window.clearTimeout(lpTimer);
      lpTimer = null;
    }
  };
  container.addEventListener(
    'touchmove',
    (ev) => {
      if (lpTimer === null || !lpXY) return;
      const t = ev.touches[0];
      if (Math.abs(t.clientX - lpXY.x) > 8 || Math.abs(t.clientY - lpXY.y) > 8) cancel();
    },
    { passive: true },
  );
  container.addEventListener('touchend', cancel, { passive: true });
  container.addEventListener('touchcancel', cancel, { passive: true });
}

/** Show the block menu at a viewport position (right-click / long-press). */
export function openBlockMenu(x: number, y: number, b: Block, host: BlockEditorView): void {
  // Multi-selection containing the target block → bulk menu instead.
  if (host.selectedBlocks.has(b) && host.selectedBlocks.size > 1) {
    buildBulkMenu(host).showAtPosition({ x, y });
    return;
  }
  buildBlockMenu(b, host).showAtPosition({ x, y });
}

/** Bulk actions for the current multi-selection. */
function buildBulkMenu(host: BlockEditorView): Menu {
  const menu = new Menu();
  const n = host.selectedBlocks.size;

  menu.addItem((item) =>
    item
      .setTitle(`Cycle TODO on ${n} blocks`)
      .setIcon('list-todo')
      .onClick(() => host.cycleMarkerSelected()),
  );
  menu.addItem((item) =>
    item
      .setTitle(`Copy ${n} blocks as markdown`)
      .setIcon('copy')
      .onClick(() => void host.copySelectedAsMarkdown()),
  );
  menu.addItem((item) =>
    item
      .setTitle(`Duplicate ${n} blocks`)
      .setIcon('copy-plus')
      .onClick(() => host.duplicateSelected()),
  );
  menu.addItem((item) =>
    item
      .setTitle(`Indent ${n} blocks`)
      .setIcon('indent-increase')
      .onClick(() => host.indentSelected(false)),
  );
  menu.addItem((item) =>
    item
      .setTitle(`Outdent ${n} blocks`)
      .setIcon('indent-decrease')
      .onClick(() => host.indentSelected(true)),
  );
  menu.addItem((item) =>
    item
      .setTitle(`Move ${n} blocks to another page…`)
      .setIcon('file-output')
      .onClick(() => openMoveToFileModal(host, host.topSelectedBlocks())),
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(`Delete ${n} blocks`)
      .setIcon('trash-2')
      .onClick(() => host.deleteSelected()),
  );
  return menu;
}

function buildBlockMenu(b: Block, host: BlockEditorView): Menu {
  const menu = new Menu();

  menu.addItem((item) =>
    item
      .setTitle('Copy block reference')
      .setIcon('link')
      .onClick(() => copyBlockRef(b, host)),
  );
  menu.addItem((item) =>
    item
      .setTitle('Copy block as markdown')
      .setIcon('copy')
      .onClick(() => {
        void navigator.clipboard.writeText(serializeBlock(b, 0));
        new Notice('Block copied as markdown');
      }),
  );

  menu.addSeparator();

  menu.addItem((item) =>
    item
      .setTitle('Duplicate block')
      .setIcon('copy-plus')
      .onClick(() => {
        commitIfFocused(b, host);
        const parent = b.parent;
        host.mutate(
          () => {
            duplicateBlock(b);
          },
          () => ({ lists: [parent] }),
        );
      }),
  );
  menu.addItem((item) =>
    item
      .setTitle('Delete block')
      .setIcon('trash-2')
      .onClick(() => {
        commitIfFocused(b, host);
        const parent = b.parent;
        const wasZoomed = !!host.zoomedBlock;
        host.mutate(
          () => {
            removeBlock(b);
            // If we were zoomed into the deleted subtree, zoom back out.
            const z = host.zoomedBlock;
            if (z && (z === b || isDescendant(b, z))) host.zoomedBlock = null;
          },
          // Zoom reset requires a full render (breadcrumb + tree swap).
          () => ({ lists: [parent], full: wasZoomed && !host.zoomedBlock }),
        );
      }),
  );

  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle('Move block to another page…')
      .setIcon('file-output')
      .onClick(() => {
        commitIfFocused(b, host);
        openMoveToFileModal(host, [b]);
      }),
  );

  menu.addSeparator();

  if (b.kind === 'list') {
    menu.addItem((item) =>
      item
        .setTitle('Cycle TODO / DOING / DONE')
        .setIcon('list-todo')
        .onClick(() => {
          commitIfFocused(b, host);
          host.mutate(
            () => {
              cycleMarker(b);
            },
            () => ({ subtree: b }),
          );
        }),
    );
  }
  if (b.children.length > 0) {
    menu.addItem((item) =>
      item
        .setTitle(isCollapsed(b) ? 'Expand block' : 'Collapse block')
        .setIcon('chevrons-down-up')
        .onClick(() => {
          host.mutate(
            () => {
              setCollapsed(b, !isCollapsed(b));
            },
            () => ({ subtree: b }),
          );
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Zoom in')
        .setIcon('maximize-2')
        .onClick(() => host.zoomIn(b)),
    );
  }

  return menu;
}

/** Ensure the block has a persistent id, then copy ((id)) to the clipboard. */
function copyBlockRef(b: Block, host: BlockEditorView): void {
  const id = ensureId(b);
  // ensureId may have written an id:: property — persist it through the
  // normal mutation pipeline (snapshot + dirty + targeted wrap rebuild).
  host.mutate(
    () => {},
    () => ({ subtree: b }),
  );
  void navigator.clipboard.writeText(`((${id}))`);
  new Notice('Block reference copied');
}

/** Commit the focused CM6 text first when the menu target overlaps the edit. */
function commitIfFocused(b: Block, host: BlockEditorView): void {
  const f = host.focusedBlock;
  if (f && (f === b || isDescendant(b, f))) host.commitFocusedText();
}
