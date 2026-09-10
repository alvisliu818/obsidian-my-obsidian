/**
 * BlockEditorView — the Logseq-style outline editor view (TextFileView).
 *
 * Owns the parsed block forest, the focused-block CM6 lifecycle, structural
 * mutations (with snapshot undo), zoom state, and the save pipeline (native
 * TextFileView requestSave/save — files stay 100% standard markdown).
 */

import { TextFileView, type TAbstractFile, type ViewState, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { CompletionSource } from '@codemirror/autocomplete';
import type LogseqEditorPlugin from '../main';
import type { Block, ParsedDocument } from '../types';
import { createBlock, setCollapsed } from '../types';
import { parseDocument } from '../core/parser';
import { serializeBlock, serializeDocument } from '../core/serializer';
import {
  cycleMarker,
  duplicateBlock,
  findBlockById,
  flattenVisible,
  indent,
  isDescendant,
  linkParents,
  moveBlock,
  moveBlockVertically,
  outdent,
  registerRoots,
  removeBlock,
  type MovePosition,
} from '../core/treeOps';
import { UndoStack } from '../state/undoStack';
import {
  renderBlockTree,
  refreshBlockContent,
  refreshQueryBlocks,
  clearAllBlockCaches,
  findBlockEl,
  patchBlockSubtree,
  patchSiblingList,
  VIRTUAL_CHUNK,
  VIRTUAL_INITIAL_CAP,
} from '../blocks/renderTree';
import { applyCursor, commitEditorText, cursorAtCoords, mountFocusedEditor, type CursorPos } from '../editor/focusEditor';
import { toggleCollapse } from '../interactions/collapse';
import { breadcrumbFor, restoreZoomed, visibleRootsFor, zoomId } from '../interactions/zoom';
import { attachDnd } from '../interactions/dnd';
import { attachContextMenu } from '../interactions/contextMenu';
import { autocompleteSources } from '../features/links';
import { PageSearchBar } from '../features/pageSearch';
import { ConflictModal } from '../features/conflictModal';
import { parseVarLines, type TemplateContext } from '../features/template';

export const VIEW_TYPE_BLOCK_EDITOR = 'logseq-block-editor';

/** Targeted mutation: which DOM regions to rebuild (computed after fn runs). */
export interface MutatePatch {
  /** Sibling lists to rebuild, keyed by their parent block (null = root list). */
  lists?: (Block | null)[];
  /** A whole block subtree to rebuild (chrome / marker / props changes). */
  subtree?: Block;
  /** Force the full-render fallback (zoom state changed, etc.). */
  full?: boolean;
}

export class BlockEditorView extends TextFileView {
  plugin: LogseqEditorPlugin;
  doc: ParsedDocument = { frontmatter: '', pageProps: '', blocks: [] };
  focusedBlock: Block | null = null;
  focusedView: EditorView | null = null;
  zoomedBlock: Block | null = null;
  /** Bumped on every file (re)load; stale async markdown renders are dropped. */
  renderGeneration = 0;
  /** Virtual scrolling: how many leading visible blocks may render. */
  scrollCap = VIRTUAL_INITIAL_CAP;
  /** Multi-selection (Shift/Ctrl+click); only top-level members act in bulk. */
  selectedBlocks = new Set<Block>();
  private lastClicked: Block | null = null;
  /** Last content handed to disk (getViewData/setViewData) — conflict baseline. */
  private lastDiskData: string | null = null;
  /** A conflict modal is open for this view (suppress re-entrant handling). */
  private conflictOpen = false;

  private editorContainerEl!: HTMLElement;
  private breadcrumbEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private undo = new UndoStack();
  private focusStartSnapshot = '';
  private pendingFocus: { pos: CursorPos; clickXY: { x: number; y: number } | null } | null = null;
  private savedFocusPos: CursorPos = 'end';
  private indexDisposer: (() => void) | null = null;
  private searchBar: PageSearchBar | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_BLOCK_EDITOR;
  }
  getDisplayText(): string {
    return this.file?.basename ?? 'Block editor';
  }
  getIcon(): string {
    return 'list-tree';
  }

  // ------------------------------------------------------------------
  // DOM skeleton & lifecycle
  // ------------------------------------------------------------------

  onload(): void {
    super.onload();
    this.editorContainerEl = this.contentEl.createEl('div', { cls: 'block-editor-container' });
    this.breadcrumbEl = this.editorContainerEl.createEl('div', { cls: 'block-editor-breadcrumb' });
    const scroller = this.editorContainerEl.createEl('div', { cls: 'block-editor-scroller' });
    this.treeEl = scroller.createEl('div', { cls: 'block-editor-tree' });

    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        void this.onExternalModify(file);
      }),
    );
    // Global undo/redo when no block is focused (block-internal undo is CM6's).
    this.editorContainerEl.addEventListener('keydown', (ev) => this.handleGlobalKeydown(ev));
    attachDnd(this.treeEl, this);
    attachContextMenu(this.treeEl, this);
    this.searchBar = new PageSearchBar(this, this.editorContainerEl);
    // Live {{query}} blocks: refresh when the vault-wide index rebuilds.
    this.indexDisposer = this.plugin.blockIndex?.onRebuild(() => this.refreshQueryResults()) ?? null;

    this.render();
  }

  onunload(): void {
    this.indexDisposer?.();
    this.indexDisposer = null;
    this.commitFocusedText();
    clearAllBlockCaches(this.doc.blocks);
    super.onunload();
  }

  /** Template expansion context: page title + user-defined variables. */
  templateContext(): TemplateContext {
    return {
      currentPage: this.file?.basename ?? '',
      vars: parseVarLines(this.plugin.settings.customTemplateVars),
    };
  }

  /** Re-execute visible {{query}} blocks against the current index. */
  refreshQueryResults(): void {
    if (this.treeEl) refreshQueryBlocks(this.treeEl, this);
  }

  /** Virtual scroll: render the next chunk (sentinel clicked / approached). */
  bumpScrollCap(): void {
    this.scrollCap += VIRTUAL_CHUNK;
    this.render();
  }

  /** Grow the render cap until `b` falls inside the rendered window. */
  private ensureCapFor(b: Block): boolean {
    const idx = flattenVisible(this.visibleRoots).indexOf(b);
    if (idx >= 0 && idx >= this.scrollCap) {
      this.scrollCap = idx + VIRTUAL_CHUNK;
      return true;
    }
    return false;
  }

  // TextFileView data interface -------------------------------------------------

  getViewData(): string {
    const s = this.serializeCurrent();
    this.lastDiskData = s; // this is what Obsidian writes to disk
    return s;
  }

  setViewData(data: string, clear: boolean): void {
    if (clear) this.commitFocusedText();
    this.renderGeneration++;
    this.doc = parseDocument(data);
    linkParents(this.doc.blocks);
    registerRoots(this.doc.blocks);
    this.zoomedBlock = null;
    this.focusedBlock = null;
    this.scrollCap = VIRTUAL_INITIAL_CAP;
    this.selectedBlocks.clear();
    this.lastClicked = null;
    this.undo.clear();
    this.lastDiskData = data;
    this.focusStartSnapshot = serializeDocument(this.doc);
    this.render();
  }

  clear(): void {
    this.commitFocusedText();
    this.renderGeneration++;
    clearAllBlockCaches(this.doc.blocks);
    this.doc = { frontmatter: '', pageProps: '', blocks: [] };
    this.zoomedBlock = null;
    this.scrollCap = VIRTUAL_INITIAL_CAP;
    this.undo.clear();
    this.render();
  }

  async onLoadFile(file: import('obsidian').TFile): Promise<void> {
    await super.onLoadFile(file);
    this.render();
    // Reveal a pending block reference (opened from another file via ((id))).
    const pending = this.plugin.pendingReveal;
    if (pending && pending.path === file.path) {
      this.plugin.pendingReveal = null;
      this.revealBlock(pending.blockId);
    }
  }

  async onUnloadFile(file: import('obsidian').TFile): Promise<void> {
    this.commitFocusedText();
    await this.save(true);
    return super.onUnloadFile(file);
  }

  getState(): Record<string, unknown> {
    const s = { ...super.getState() } as unknown as ViewState;
    const zid = zoomId(this.zoomedBlock);
    if (zid) s.state = { ...(s.state ?? {}), zoomedBlockId: zid };
    return s as unknown as Record<string, unknown>;
  }

  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const st = state as unknown as ViewState;
    const zid = (st.state as Record<string, unknown> | undefined)?.zoomedBlockId;
    if (typeof zid === 'string' && zid) {
      this.zoomedBlock = restoreZoomed(this.doc, zid);
      this.render();
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  get visibleRoots(): Block[] {
    return visibleRootsFor(this.doc, this.zoomedBlock);
  }

  /** The rendered block-tree DOM (used by the in-page search bar). */
  get contentTreeEl(): HTMLElement {
    return this.treeEl;
  }

  private render(): void {
    if (!this.editorContainerEl) return;
    const roots = this.visibleRoots;
    registerRoots(roots);
    this.renderBreadcrumb();
    // Destroy the previous focused CM6 instance (its DOM is about to be
    // rebuilt); the focused block itself is remounted during tree render.
    if (this.focusedView) {
      this.focusedView.destroy();
      this.focusedView = null;
    }
    renderBlockTree(this.treeEl, roots, this);
    // The tree DOM was rebuilt — re-apply in-page search highlights if open.
    this.searchBar?.onRerender();
  }

  private renderBreadcrumb(): void {
    const el = this.breadcrumbEl;
    if (!el) return;
    el.empty();
    const entries = breadcrumbFor(this.doc, this.zoomedBlock, this.file?.basename ?? '');
    let hasZoom = false;
    entries.forEach((e, i) => {
      if (i > 0) el.createEl('span', { cls: 'bc-sep', text: '›' });
      const isCurrent = i === entries.length - 1;
      if (e.block) hasZoom = true;
      const c = el.createEl('span', {
        cls: 'bc-crumb' + (isCurrent ? ' is-current' : ''),
        text: e.label || '…',
      });
      const b = e.block;
      c.addEventListener('click', () => {
        if (!b) this.zoomTo(null);
        else this.zoomTo(b);
      });
    });
    if (hasZoom) {
      const out = el.createEl('span', { cls: 'bc-zoom-out', text: '⤴' });
      out.setAttribute('aria-label', 'Zoom out');
      out.addEventListener('click', () => this.zoomOut());
    }
  }

  /** Called by renderTree when it reaches the focused block's content slot. */
  mountFocusedInto(content: HTMLElement): void {
    const b = this.focusedBlock;
    if (!b) return;
    const pending = this.pendingFocus;
    const pos: CursorPos = pending?.pos ?? this.savedFocusPos;
    this.pendingFocus = null;
    const v = mountFocusedEditor(content, b, pos, this);
    this.focusedView = v;
    if (pending?.clickXY) {
      const p = cursorAtCoords(v, pending.clickXY.x, pending.clickXY.y, 'end');
      applyCursor(v, p);
    }
    this.focusStartSnapshot = serializeDocument(this.doc);
  }

  // ------------------------------------------------------------------
  // Focus / blur lifecycle
  // ------------------------------------------------------------------

  focusBlock(b: Block, pos: CursorPos = 'end'): void {
    if (this.focusedBlock === b && this.focusedView) {
      applyCursor(this.focusedView, pos);
      this.focusedView.focus();
      return;
    }
    this.commitFocusedText();
    this.focusedBlock = b;
    this.pendingFocus = { pos, clickXY: null };
    this.savedFocusPos = pos;
    // Incremental: swap static ↔ CM6 inside the two affected wraps only.
    // Full render fallback when the target is beyond the virtual-scroll cap
    // or not currently rendered.
    if (this.ensureCapFor(b) || !this.mountFocusedInDom(b)) this.render();
  }

  focusBlockFromClick(b: Block, ev: MouseEvent): void {
    this.clearSelection(); // editing replaces multi-selection
    const xy = { x: ev.clientX, y: ev.clientY };
    if (this.focusedBlock === b && this.focusedView) {
      const p = cursorAtCoords(this.focusedView, xy.x, xy.y, 'end');
      applyCursor(this.focusedView, p);
      this.focusedView.focus();
      return;
    }
    this.commitFocusedText();
    this.focusedBlock = b;
    this.pendingFocus = { pos: 'end', clickXY: xy };
    this.savedFocusPos = 'end';
    if (!this.mountFocusedInDom(b)) this.render();
  }

  /**
   * Mount the focused CM6 into b's existing wrap in place.
   * Returns false when b has no rendered wrap (caller falls back to render()).
   */
  private mountFocusedInDom(b: Block): boolean {
    const wrap = findBlockEl(b);
    const content = wrap?.querySelector(':scope > .block-main > .block-content') ?? null;
    if (!wrap || !content) return false;
    content.empty();
    content.classList.add('is-editing');
    this.mountFocusedInto(content as HTMLElement);
    return true;
  }

  /** Destroy the focused CM6 instance if it lives inside `el` (about to be wiped). */
  destroyFocusedInside(el: HTMLElement): void {
    const v = this.focusedView;
    if (v && el.contains(v.dom)) {
      v.destroy();
      this.focusedView = null;
    }
  }

  /** Commit CM6 text back into the block model; single-block static refresh. */
  commitFocusedText(): void {
    const v = this.focusedView;
    const b = this.focusedBlock;
    this.focusedView = null;
    this.focusedBlock = null;
    if (!v || !b) return;
    const changed = commitEditorText(v, b, this.templateContext());
    v.destroy();
    if (changed) {
      this.undo.push(this.focusStartSnapshot);
      this.markDirty();
    }
    // Always restore static content: the CM6 DOM was removed by destroy(),
    // and the cached static el re-attaches synchronously when unchanged.
    refreshBlockContent(b, this);
  }

  /** CM6 updateListener hooks. */
  onFocusedTextChange(): void {
    this.markDirty();
  }

  onFocusedBlur(): void {
    this.commitFocusedText();
  }

  // ------------------------------------------------------------------
  // Mutations (structural)
  // ------------------------------------------------------------------

  /**
   * Unified mutation entry: snapshot for undo, run fn, mark dirty, then either
   * a targeted DOM patch (when `patch` describes the affected regions — the
   * closure runs AFTER fn so it can read post-mutation parents) or a full
   * structural re-render.
   */
  mutate(fn: () => void, patch?: () => MutatePatch): void {
    const v = this.focusedView;
    const b = this.focusedBlock;
    if (v && b) {
      commitEditorText(v, b, this.templateContext());
      this.savedFocusPos = v.state.selection.main.head;
    }
    this.undo.push(this.serializeCurrent());
    fn();
    this.markDirty();
    const p = patch?.();
    if (!p || !this.renderPatched(p)) this.render();
    // If the focused block still exists, it was remounted with savedFocusPos
    // during render; refresh the baseline snapshot.
    this.focusStartSnapshot = serializeDocument(this.doc);
  }

  /** Apply a targeted patch; false = caller falls back to a full render. */
  private renderPatched(p: MutatePatch): boolean {
    if (p.full) return false;
    try {
      if (p.subtree && !patchBlockSubtree(p.subtree, this)) return false;
      const seen = new Set<Block | null>();
      for (const parent of p.lists ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        if (!patchSiblingList(parent, this)) return false;
      }
    } catch {
      return false;
    }
    this.searchBar?.onRerender();
    return true;
  }

  createFirstBlock(): void {
    const b = createBlock('');
    this.mutate(() => {
      this.doc.blocks.push(b);
    });
    this.focusBlock(b, 0);
  }

  toggleCollapse(b: Block): void {
    this.mutate(
      () => toggleCollapse(b),
      () => ({ subtree: b }),
    );
  }

  // ------------------------------------------------------------------
  // Multi-selection
  // ------------------------------------------------------------------

  /** Shift/Ctrl+click on a block: plain = single select, ctrl = toggle,
   *  shift = range from the last clicked block. */
  selectFromClick(b: Block, ev: MouseEvent): void {
    this.commitFocusedText();
    if (ev.shiftKey && this.lastClicked) {
      const seq = flattenVisible(this.visibleRoots);
      const from = seq.indexOf(this.lastClicked);
      const to = seq.indexOf(b);
      if (from >= 0 && to >= 0) {
        this.selectedBlocks.clear();
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
          this.selectedBlocks.add(seq[i]);
        }
        this.syncSelectionClasses();
        return;
      }
    }
    if (ev.ctrlKey || ev.metaKey) {
      if (this.selectedBlocks.has(b)) this.selectedBlocks.delete(b);
      else this.selectedBlocks.add(b);
    } else {
      this.selectedBlocks.clear();
      this.selectedBlocks.add(b);
    }
    this.lastClicked = b;
    this.syncSelectionClasses();
  }

  clearSelection(): void {
    if (this.selectedBlocks.size === 0) return;
    this.selectedBlocks.clear();
    this.lastClicked = null;
    this.syncSelectionClasses();
  }

  /** Update .is-selected classes in place (no re-render). */
  syncSelectionClasses(): void {
    for (const [b, wrap] of this.selectionElIterator()) {
      wrap.classList.toggle('is-selected', this.selectedBlocks.has(b));
    }
  }

  /** Selected blocks without selected ancestors, in visible order. */
  topSelectedBlocks(): Block[] {
    const sel = this.selectedBlocks;
    const tops = [...sel].filter((b) => {
      let p = b.parent;
      while (p) {
        if (sel.has(p)) return false;
        p = p.parent;
      }
      return true;
    });
    const order = new Map(flattenVisible(this.visibleRoots).map((b, i) => [b, i] as const));
    return tops.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  private *selectionElIterator(): IterableIterator<[Block, HTMLElement]> {
    for (const b of flattenVisible(this.visibleRoots)) {
      const el = findBlockEl(b);
      if (el) yield [b, el];
    }
  }

  deleteSelected(): void {
    const tops = this.topSelectedBlocks();
    if (tops.length === 0) return;
    const wasZoomed = !!this.zoomedBlock;
    this.mutate(
      () => {
        for (const b of tops) {
          const z = this.zoomedBlock;
          if (z && (z === b || isDescendant(b, z))) this.zoomedBlock = null;
          removeBlock(b);
        }
      },
      () => ({ full: true }),
    );
    void wasZoomed;
    this.selectedBlocks.clear();
    this.syncSelectionClasses();
  }

  duplicateSelected(): void {
    const tops = [...this.topSelectedBlocks()].reverse(); // back-to-front keeps indices
    if (tops.length === 0) return;
    this.mutate(
      () => {
        for (const b of tops) duplicateBlock(b);
      },
      () => ({ full: true }),
    );
    this.selectedBlocks.clear();
    this.syncSelectionClasses();
  }

  /** Unify all selected list blocks to the next marker state of the first. */
  cycleMarkerSelected(): void {
    const tops = this.topSelectedBlocks().filter((b) => b.kind === 'list');
    if (tops.length === 0) return;
    const first = tops[0];
    const order: (typeof first.marker)[] = [null, 'TODO', 'DOING', 'DONE'];
    const next = order[(order.indexOf(first.marker) + 1) % order.length];
    this.mutate(
      () => {
        for (const b of tops) b.marker = next;
      },
      () => ({ full: true }),
    );
  }

  indentSelected(shift: boolean): void {
    const tops = this.topSelectedBlocks().filter((b) => b.kind === 'list');
    if (tops.length === 0) return;
    // Upward: top-down; downward: bottom-up — each block moves relative to
    // its (possibly just-moved) previous sibling.
    const seq = shift ? [...tops].reverse() : tops;
    this.mutate(
      () => {
        for (const b of seq) {
          if (shift) outdent(b);
          else indent(b);
        }
      },
      () => ({ full: true }),
    );
  }

  /** Bulk move: up passes top-down, down passes bottom-up. */
  moveSelectedVertically(dir: -1 | 1): void {
    const tops = this.topSelectedBlocks().filter((b) => b.kind === 'list');
    if (tops.length === 0) return;
    const roots = this.visibleRoots;
    const seq = dir === -1 ? tops : [...tops].reverse();
    let moved = false;
    this.mutate(
      () => {
        for (const b of seq) {
          if (moveBlockVertically(roots, b, dir)) moved = true;
        }
      },
      () => (moved ? { full: true } : {}),
    );
  }

  toggleMarker(b: Block): void {
    this.mutate(
      () => cycleMarker(b),
      () => ({ subtree: b }),
    );
  }

  // ------------------------------------------------------------------
  // Zoom
  // ------------------------------------------------------------------

  zoomIn(b: Block): void {
    if (b.children.length === 0) return;
    this.commitFocusedText();
    this.zoomedBlock = b;
    this.render();
  }

  zoomTo(b: Block | null): void {
    this.commitFocusedText();
    this.zoomedBlock = b;
    this.render();
  }

  zoomOut(): void {
    if (!this.zoomedBlock) return;
    this.commitFocusedText();
    this.zoomedBlock = this.zoomedBlock.parent;
    this.render();
  }

  // ------------------------------------------------------------------
  // Drag & drop entry (from interactions/dnd)
  // ------------------------------------------------------------------

  dropBlock(dragged: Block, target: Block, pos: MovePosition): void {
    const oldParent = dragged.parent; // captured before the move
    this.mutate(
      () => {
        moveBlock(dragged, target, pos);
      },
      // Rebuild both the source and the destination sibling lists.
      () => ({ lists: [oldParent, dragged.parent] }),
    );
  }

  // ------------------------------------------------------------------
  // Links / navigation
  // ------------------------------------------------------------------

  openLink(linktext: string): void {
    this.app.workspace.openLinkText(linktext, this.file?.path ?? '', false);
  }

  /** Scroll to a block (by id) and flash-highlight it. Used by ((ref)) navigation. */
  revealBlock(id: string): void {
    const b = findBlockById(this.doc.blocks, id);
    if (!b) return;
    // Unfold ancestors so the block is visible.
    let p = b.parent;
    while (p) {
      setCollapsed(p, false);
      p = p.parent;
    }
    // Leave zoom mode if the block lives outside the zoomed subtree.
    if (this.zoomedBlock && !isDescendant(this.zoomedBlock, b)) {
      this.zoomedBlock = null;
    }
    this.ensureCapFor(b);
    this.render();
    const el = findBlockEl(b);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.addClass('block-revealed');
    window.setTimeout(() => el.removeClass('block-revealed'), 1600);
  }

  autocompleteSources(): CompletionSource[] {
    return autocompleteSources(this);
  }

  // ------------------------------------------------------------------
  // In-page search (Ctrl+F / Ctrl+H)
  // ------------------------------------------------------------------

  openSearch(withReplace = false): void {
    this.searchBar?.open(withReplace);
  }

  closeSearch(): void {
    this.searchBar?.close();
  }

  // ------------------------------------------------------------------
  // Undo / redo (global, non-focused)
  // ------------------------------------------------------------------

  private handleGlobalKeydown(ev: KeyboardEvent): void {
    // Escape exits multi-selection first (even while editing).
    if (ev.key === 'Escape' && this.selectedBlocks.size > 0) {
      ev.preventDefault();
      this.clearSelection();
      return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod) return;
    const key = ev.key.toLowerCase();
    // Find/replace works in both states (CM6 has no Mod-f binding of its own,
    // so the event bubbles up here even while a block is focused).
    if (key === 'f') {
      ev.preventDefault();
      this.openSearch(false);
      return;
    }
    if (key === 'h') {
      ev.preventDefault();
      this.openSearch(true);
      return;
    }
    if (this.focusedView) return;
    // Bulk shortcuts when a multi-selection exists.
    if (this.selectedBlocks.size > 0) {
      if (key === 'a') {
        // Select the entire visible outline.
        ev.preventDefault();
        this.selectedBlocks = new Set(flattenVisible(this.visibleRoots));
        this.syncSelectionClasses();
        return;
      }
      if (key === 'x' || key === 'c') {
        ev.preventDefault();
        void this.copySelectedAsMarkdown(); // cut = copy + delete
        if (key === 'x') this.deleteSelected();
        return;
      }
      if (key === 'd') {
        ev.preventDefault();
        this.duplicateSelected();
        return;
      }
    }
    if (key === 'z' && !ev.shiftKey) {
      if (this.undoRestore()) ev.preventDefault();
    } else if ((key === 'z' && ev.shiftKey) || key === 'y') {
      if (this.redoRestore()) ev.preventDefault();
    }
  }

  /** Serialize the top-level selected blocks to the clipboard. */
  async copySelectedAsMarkdown(): Promise<void> {
    const md = this.topSelectedBlocks()
      .map((b) => serializeBlock(b, 0))
      .join('\n');
    if (md) await navigator.clipboard.writeText(md);
  }

  private undoRestore(): boolean {
    const cur = this.serializeCurrent();
    const snap = this.undo.undoPop(cur);
    if (snap === null) return false;
    this.restoreSnapshot(snap);
    return true;
  }

  private redoRestore(): boolean {
    const cur = this.serializeCurrent();
    const snap = this.undo.redoPop(cur);
    if (snap === null) return false;
    this.restoreSnapshot(snap);
    return true;
  }

  private restoreSnapshot(snap: string): void {
    this.commitFocusedText();
    this.doc = parseDocument(snap);
    linkParents(this.doc.blocks);
    this.zoomedBlock = this.zoomedBlock && findBlockById(this.doc.blocks, zoomId(this.zoomedBlock));
    this.render();
    this.markDirty();
    this.focusStartSnapshot = serializeDocument(this.doc);
  }

  // ------------------------------------------------------------------
  // Saving & external changes
  // ------------------------------------------------------------------

  private serializeCurrent(): string {
    // Overlay the focused CM6's live text without committing it (no template
    // expansion, no re-render): auto-save and conflict diffs must reflect
    // exactly what is on screen even mid-edit.
    const v = this.focusedView;
    const b = this.focusedBlock;
    if (v && b) {
      const live = v.state.doc.toString();
      if (live !== b.text) {
        const saved = b.text;
        b.text = live;
        const s = serializeDocument(this.doc);
        b.text = saved;
        return s;
      }
    }
    return serializeDocument(this.doc);
  }

  private markDirty(): void {
    this.requestSave(); // native: sets dirty + debounced save (2s)
  }

  private async onExternalModify(file: TAbstractFile): Promise<void> {
    if (!this.file || file !== this.file) return;
    const data = await this.app.vault.cachedRead(this.file);
    const ours = this.serializeCurrent();
    if (data === ours) return; // our own write echoed (or no real change)
    if (this.conflictOpen) return; // already resolving this conflict
    const haveLocal = this.lastDiskData === null || ours !== this.lastDiskData;
    if (!haveLocal) {
      // No unsaved local edits — silently adopt the external version.
      this.setViewData(data, false);
      return;
    }
    // Real conflict: unsaved local edits vs changed disk content.
    this.conflictOpen = true;
    new ConflictModal(this.app, {
      path: this.file.path,
      mine: ours,
      external: data,
      onKeepMine: () => {
        this.conflictOpen = false;
        void this.save(true);
      },
      onUseExternal: () => {
        this.conflictOpen = false;
        this.commitFocusedText(); // destroy the live CM6 before swapping docs
        this.setViewData(data, false);
      },
    }).open();
  }
}
