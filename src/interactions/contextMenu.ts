/**
 * Right-click block menu (Logseq-style): copy reference / copy markdown,
 * duplicate, delete, cycle TODO, collapse, zoom. Uses Obsidian's Menu API so
 * theming, positioning and outside-click dismissal come for free.
 *
 * Right-clicking the bullet opens the same menu with the copy pair promoted to
 * the top (Logseq puts the block-embed actions on the bullet).
 *
 * Right-clicking INSIDE the focused editor (outline or in-place embed) shows
 * the native-editor text menu instead: Cut / Copy / Paste / Select all over
 * the CM6 selection — the same items the native Obsidian editor offers on a
 * text selection.
 */

import { Menu, Notice } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import { blockFromEl } from '../blocks/renderTree';
import { blockId, ensureId, isCollapsed, setCollapsed, type Block } from '../types';
import { cycleMarker, duplicateBlock, isDescendant, removeBlock } from '../core/treeOps';
import { blocksEmbedSyntax, blocksMarkdown } from '../features/copyFormats';
import { openMoveToFileModal } from '../features/moveToFile';
import { openTextSelectionMenu } from './textSelectionMenu';

export function attachContextMenu(container: HTMLElement, host: BlockEditorView): void {
  container.addEventListener('contextmenu', (ev) => {
    const target = ev.target as HTMLElement | null;
    // Native-editor parity: a right-click inside a live editor is about the
    // TEXT selection, not the block.
    if (target?.closest('.cm-editor') && openTextSelectionMenu(ev, host)) return;
    const b = blockFromEl(target);
    if (!b) return;
    ev.preventDefault();
    const fromBullet = !!target?.closest('.block-bullet');
    openBlockMenu(ev.clientX, ev.clientY, b, host, fromBullet);
  });

  // Touch long-press (500ms, 8px jitter tolerance) → the same block menu.
  let lpTimer: number | null = null;
  let lpXY: { x: number; y: number } | null = null;
  container.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length !== 1) return;
      const t = ev.touches[0];
      const target = ev.target as HTMLElement | null;
      const b = blockFromEl(target);
      if (!b) return;
      const fromBullet = !!target?.closest('.block-bullet');
      lpXY = { x: t.clientX, y: t.clientY };
      lpTimer = window.setTimeout(() => {
        lpTimer = null;
        openBlockMenu(t.clientX, t.clientY, b, host, fromBullet);
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
export function openBlockMenu(
  x: number,
  y: number,
  b: Block,
  host: BlockEditorView,
  fromBullet = false,
): void {
  // Multi-selection containing the target block → bulk menu instead.
  if (host.selectedBlocks.has(b) && host.selectedBlocks.size > 1) {
    buildBulkMenu(host, fromBullet).showAtPosition({ x, y });
    return;
  }
  buildBlockMenu(b, host, fromBullet).showAtPosition({ x, y });
}

/** Bulk actions for the current multi-selection. */
function buildBulkMenu(host: BlockEditorView, fromBullet: boolean): Menu {
  const menu = new Menu();
  const n = host.selectedBlocks.size;
  const tops = host.topSelectedBlocks();

  if (fromBullet) {
    menu.addItem((item) =>
      item
        .setTitle(`Copy ${n} block embeds`)
        .setIcon('braces')
        .onClick(() => copyBlocksAsEmbed(tops, host)),
    );
    menu.addItem((item) =>
      item
        .setTitle(`Copy ${n} blocks as markdown`)
        .setIcon('copy')
        .onClick(() => copyBlocksAsMarkdown(tops, host)),
    );
    menu.addSeparator();
  }

  menu.addItem((item) =>
    item
      .setTitle(`Cycle TODO on ${n} blocks`)
      .setIcon('list-todo')
      .onClick(() => host.cycleMarkerSelected()),
  );
  if (!fromBullet) {
    menu.addItem((item) =>
      item
        .setTitle(`Copy ${n} blocks as markdown`)
        .setIcon('copy')
        .onClick(() => copyBlocksAsMarkdown(host.topSelectedBlocks(), host)),
    );
  }
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

function buildBlockMenu(b: Block, host: BlockEditorView, fromBullet: boolean): Menu {
  const menu = new Menu();

  // Bullet menu leads with the two "copy this block elsewhere" shapes.
  if (fromBullet) {
    menu.addItem((item) =>
      item
        .setTitle('Copy block embed')
        .setIcon('braces')
        .onClick(() => copyBlocksAsEmbed([b], host)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Copy block as markdown')
        .setIcon('copy')
        .onClick(() => copyBlocksAsMarkdown([b], host)),
    );
    menu.addSeparator();
  }

  menu.addItem((item) =>
    item
      .setTitle('Copy block reference')
      .setIcon('link')
      .onClick(() => copyBlockRef(b, host)),
  );
  if (!fromBullet) {
    menu.addItem((item) =>
      item
        .setTitle('Copy block as markdown')
        .setIcon('copy')
        .onClick(() => copyBlocksAsMarkdown([b], host)),
    );
  }

  menu.addSeparator();

  // Edit this block as raw markdown for one session (live preview is the
  // default editing experience; this is the explicit way out).
  menu.addItem((item) =>
    item
      .setTitle('Source mode')
      .setIcon('code')
      .onClick(() => {
        host.sourceModeBlock = b;
        host.focusBlock(b, 'end');
      }),
  );

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
  persistIds([b], host);
  void navigator.clipboard.writeText(`((${blockId(b)}))`);
  new Notice('Block reference copied');
}

/** Copy `{{embed ((id))}}` for each block (assigning ids where needed). */
function copyBlocksAsEmbed(blocks: Block[], host: BlockEditorView): void {
  persistIds(blocks, host);
  const text = blocksEmbedSyntax(blocks);
  void navigator.clipboard.writeText(text);
  new Notice(blocks.length > 1 ? `${blocks.length} block embeds copied` : 'Block embed copied');
}

/** Copy the markdown sub-tree of each block (live editor text committed first). */
function copyBlocksAsMarkdown(blocks: Block[], host: BlockEditorView): void {
  for (const b of blocks) commitIfFocused(b, host);
  const md = blocksMarkdown(blocks);
  void navigator.clipboard.writeText(md);
  new Notice(
    blocks.length > 1 ? `${blocks.length} blocks copied as markdown` : 'Block copied as markdown',
  );
}

/**
 * Give every block without an id a fresh one and persist the new `id::`
 * properties through the normal mutation pipeline (snapshot + dirty + rebuild).
 * No-op (no undo entry, no dirty flag) when all blocks already have ids.
 * Returns true when at least one id was added.
 */
function persistIds(blocks: Block[], host: BlockEditorView): boolean {
  let added = false;
  for (const b of blocks) {
    if (!blockId(b)) {
      ensureId(b);
      added = true;
    }
  }
  if (!added) return false;
  host.mutate(
    () => {},
    () => ({ full: true }),
  );
  return true;
}

/** Commit the focused CM6 text first when the menu target overlaps the edit. */
function commitIfFocused(b: Block, host: BlockEditorView): void {
  const f = host.focusedBlock;
  if (f && (f === b || isDescendant(b, f))) host.commitFocusedText();
}
