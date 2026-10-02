/**
 * BlockEditorView — the Logseq-style outline editor view (TextFileView).
 *
 * Owns the parsed block forest, the focused-block CM6 lifecycle, structural
 * mutations (with snapshot undo), zoom state, and the save pipeline (native
 * TextFileView requestSave/save — files stay 100% standard markdown).
 */

import { MarkdownRenderer, TFile, TextFileView, type TAbstractFile, type ViewState, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { CompletionSource } from '@codemirror/autocomplete';
import type LogseqEditorPlugin from '../main';
import type { Block, ParsedDocument } from '../types';
import { applyBlockProps, blockEditorDoc, createBlock, editableProps, propsShallowEqual, setCollapsed, splitPropLines } from '../types';
import { parseDocument } from '../core/parser';
import { clearLogseqPageProps, registerLogseqPageProps } from '../pagePropsRegistry';
import { serializeBlock, serializeDocument } from '../core/serializer';
import { blockAtPath, cycleMarker, duplicateBlock, findBlockById, flattenVisible, indent, isDescendant, linkParents, moveBlock, moveBlockVertically, outdent, pseudoRootOf, registerRoots, removeBlock, siblingsOf, splitBlock, type MovePosition } from '../core/treeOps';
import { UndoStack } from '../state/undoStack';
import {
  renderBlockTree,
  refreshBlockContent,
  refreshQueryBlocks,
  clearAllBlockCaches,
  cachedStaticEl,
  findBlockEl,
  patchBlockSubtree,
  patchSiblingList,
  VIRTUAL_CHUNK,
  VIRTUAL_INITIAL_CAP,
} from '../blocks/renderTree';
import { applyCursor, applyCursorAndScroll, commitEditorText, cursorAtCoords, mountFocusedEditor, type CursorPos } from '../editor/focusEditor';
import { createEmbedExtensions } from '../editor/extensions';
import {
  findEmbedBox,
  findEmbedRow,
  findEmbedRowForBlock,
  getEmbedRowSource,
  mutatePageEmbedSource,
  refreshEmbedBox,
  refreshPageEmbedBox,
  renderEmbedBodyFrom,
  rerenderEmbedRow,
  type EmbedSource,
} from '../features/links';
import { collapseLevels, expandLevels, toggleCollapse } from '../interactions/collapse';
import { isCollapsed } from '../types';
import { breadcrumbFor, restoreZoomed, visibleRootsFor, zoomId } from '../interactions/zoom';
import { attachDnd } from '../interactions/dnd';
import { attachContextMenu } from '../interactions/contextMenu';
import { clearActiveBlockEditor, syncActiveBlockEditor } from '../interactions/textSelectionMenu';
import { autocompleteSources } from '../features/links';
import { PageSearchBar } from '../features/pageSearch';
import { expandTemplates, parseVarLines, type TemplateContext } from '../features/template';
import { logOp } from '../features/logger';
import { refreshBlockBacklinkBadges } from '../blocks/blockBacklinks';
import { renderPageReferences } from '../features/pageReferences';
import { mountCodeEditor, parseCodeFence, type MountedCodeEditor } from '../blocks/codeBlockEdit';
import { unwatchGuideLayout, watchGuideLayout } from '../blocks/guideLayout';

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
  /** Last block the caret lived in — keeps the outline path shown after blur. */
  lastEditedBlock: Block | null = null;
  focusedView: EditorView | null = null;
  /** Dedicated code-block edit mode (Logseq parity) — mounted instead of the raw editor. */
  focusedCode: MountedCodeEditor | null = null;
  /**
   * Set by the block menu's "Source mode": the next editor mounted for THIS
   * block skips live preview (raw source for one edit session). Cleared on
   * commit.
   */
  sourceModeBlock: Block | null = null;
  /**
   * Page-wide source mode (status bar toggle): every block edits as raw
   * markdown — no live preview, and pure code fences stay as raw fences
   * (no dedicated code editor). Off by default.
   */
  pageSourceMode = false;
  /** CM6 mounted inside an embed row for in-place editing (null when idle). */
  embedEdit: { view: EditorView; source: EmbedSource; path: number[]; row: HTMLElement; escHandler: (e: KeyboardEvent) => void } | null = null;
  zoomedBlock: Block | null = null;
  /** Bumped on every file (re)load; stale async markdown renders are dropped. */
  renderGeneration = 0;
  /** Virtual scrolling: how many leading visible blocks may render. */
  scrollCap = VIRTUAL_INITIAL_CAP;
  /** Multi-selection (Shift/Ctrl+click); only top-level members act in bulk. */
  selectedBlocks = new Set<Block>();
  private lastClicked: Block | null = null;
  /** Last content handed to disk (getViewData/setViewData) — external-change baseline. */
  private lastDiskData: string | null = null;

  private editorContainerEl!: HTMLElement;
  private breadcrumbEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private refsHostEl!: HTMLElement;
  private undo = new UndoStack();
  private focusStartSnapshot = '';
  private pendingFocus: {
    pos: CursorPos;
    clickXY: { x: number; y: number } | null;
    /** Click position mapped from the static render (pre-swap), when available. */
    staticPos: number | null;
  } | null = null;
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
    // Page references (linked + unlinked) live INSIDE the scroller, after the
    // outline: they scroll with the page content (Logseq parity). render()
    // only empties treeEl, so this host persists across re-renders.
    this.refsHostEl = scroller.createEl('div', { cls: 'page-references-host' });
    // Pin every guide line's ends to the real dot positions after any layout
    // change (multi-line parents / props rows shift the containers — CSS
    // approximations cannot know those heights).
    watchGuideLayout(this.treeEl);
    this.register(() => unwatchGuideLayout(this.treeEl));

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
    this.indexDisposer = this.plugin.blockIndex?.onRebuild(() => {
      this.refreshQueryResults();
      // Page references (linked + unlinked) track the index.
      renderPageReferences(
        this.refsHostEl,
        this.plugin,
        this.file?.path,
        this.file?.basename ?? '',
      );
      refreshBlockBacklinkBadges(this);
    }) ?? null;

    this.render();
  }

  onunload(): void {
    this.indexDisposer?.();
    this.indexDisposer = null;
    this.commitFocusedText();
    this.commitEmbedEdit();
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
    this.syncPagePropsRegistry();
    linkParents(this.doc.blocks);
    registerRoots(this.doc.blocks);
    this.zoomedBlock = null;
    this.focusedBlock = null;
    this.lastEditedBlock = null; // new file: stale outline path must not leak
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
    // Obsidian's openLinkText reopen path may clear() a view whose file was
    // JUST loaded (and whose leaf still points at that file). Schedule one
    // deferred re-read: if the leaf still owns a file and the model is empty
    // at next tick, reload it from disk (self-heal for the stray clear).
    const f = this.file;
    if (f) {
      window.setTimeout(() => {
        if (this.file === f && this.doc.blocks.length === 0 && !this.embedEdit) {
          void this.app.vault.cachedRead(f).then((data) => {
            if (this.file === f && this.doc.blocks.length === 0 && data.length > 0) {
              this.setViewData(data, false);
            }
          });
        }
      }, 0);
    }
  }

  async onLoadFile(file: import('obsidian').TFile): Promise<void> {
    await super.onLoadFile(file);
    // Obsidian's openLinkText reopen path can fire a stray clear() AFTER
    // setViewData populated the doc (observed when reopening the previous
    // file's leaf while an openLinkText promise chain is still pending),
    // leaving the view showing the file with an EMPTY model. Re-read from
    // disk when we caught that state — the file on disk is authoritative.
    if (file && this.doc.blocks.length === 0) {
      const data = await this.app.vault.cachedRead(file);
      if (data.length > 0) {
        this.setViewData(data, false);
      }
    }
    this.render();
    // Page references (linked + unlinked) normally re-render on index
    // rebuilds only; a file SWITCH must also refresh them, otherwise the
    // section shows the previous file's stale content (or an empty scan
    // from before the index existed) until the next unrelated rebuild.
    renderPageReferences(
      this.refsHostEl,
      this.plugin,
      this.file?.path,
      this.file?.basename ?? '',
    );
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

  /** Re-read the file from disk (after a page-props edit) and refresh the view. */
  async reloadFile(): Promise<void> {
    const f = this.file;
    if (!f) return;
    const data = await this.app.vault.read(f);
    this.setViewData(data, false);
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
    try {
      this.renderInner();
    } catch (e) {
      console.error('[LG] render() threw:', e);
    }
  }

  private renderInner(): void {
    if (!this.editorContainerEl) return;
    this.commitEmbedEdit(); // never lose an in-place embed edit on re-render
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
    // Bottom-of-page references render on INDEX REBUILD only (see onload's
    // onRebuild handler) — the unlinked scan is a full-vault pass and must
    // not run in the hot editing path (it re-creates DOM mid-typing).
    // The tree DOM was rebuilt — re-apply in-page search highlights if open.
    this.searchBar?.onRerender();
    this.updateOutlinePath();
  }

  /**
   * Focused block's outline position (root → focused, text crumbs), exposed
   * on the DOM (`contentEl.__lgFocusPath`) plus an `lgp-block-focus` event so
   * companion plugins (breadcrumb nav) can show WHERE in the outline the
   * caret lives. Falls back to the zoom context when no block is focused.
   */
  private updateOutlinePath(): void {
    const el = this.contentEl as HTMLElement & { __lgFocusPath?: string[] };
    const crumbs: string[] = [];
    // The focused block while editing; after blur keep the LAST edited
    // block's position (companion breadcrumbs must not snap back to the zoom
    // context the moment the caret leaves).
    let b = this.focusedBlock ?? this.lastEditedBlock ?? this.zoomedBlock;
    while (b) {
      const first = (b.text.split('\n')[0] ?? '').trim();
      crumbs.unshift(!first ? '·' : first.length > 24 ? first.slice(0, 24) + '…' : first);
      b = b.parent;
    }
    el.__lgFocusPath = crumbs;
    el.dispatchEvent(new CustomEvent('lgp-block-focus', { detail: { path: crumbs } }));
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
    // A re-render while a code editor was already mounted (scroll-cap bump,
    // index rebuild, ...) would leak the old CM6 instance and leave its dead
    // wrap inside the cached static render — destroy & restore first. The
    // restored code element is exactly what the source-mode branch below
    // swaps out next.
    if (this.focusedCode) {
      const stale = this.focusedCode;
      this.focusedCode = null;
      stale.view.destroy();
      if (stale.editingWrap && stale.restoreEl && stale.editingWrap.parentElement) {
        stale.editingWrap.replaceWith(stale.restoreEl);
      }
    }
    // Code blocks open their OWN editor (no fences on screen, Enter = newline
    // inside the code). Source mode keeps the raw view.
    const codeInfo = this.sourceModeBlock || this.pageSourceMode ? null : parseCodeFence(b.text);
    if (codeInfo) {
      const pending = this.pendingFocus;
      this.pendingFocus = null;
      let mountOpts: { replaceEl?: HTMLElement } | undefined;
      if (codeInfo.prefix) {
        // Mixed block (image/prose + fence): keep the rendered prefix on
        // screen — re-attach the cached static render and swap ONLY its code
        // element for the dedicated editor. The block never collapses into
        // raw text, so the page never jumps either.
        const holder = cachedStaticEl(b);
        const codeEl =
          holder?.querySelector<HTMLElement>('.lgp-code-block:not(.lgp-code-editing)') ?? null;
        if (holder && codeEl) {
          content.appendChild(holder);
          mountOpts = { replaceEl: codeEl };
        } else {
          // Static render unavailable or still rendering (async): render the
          // prefix fresh above the editor; the image appears when done.
          const ph = document.createElement('div');
          ph.className = 'block-content-static';
          content.appendChild(ph);
          void MarkdownRenderer.render(
            this.app,
            codeInfo.prefix,
            ph,
            this.file?.path ?? '',
            this,
          ).catch(() => {});
        }
      }
      this.focusedCode = mountCodeEditor(content, b, codeInfo, this, mountOpts);
      // Cursor placement: the code editor's doc holds ONLY the fence content,
      // so whole-text positions (staticPos / numeric pos) shift by the
      // prefix + opening fence line.
      const v = this.focusedCode.view;
      const beforeLen =
        (codeInfo.prefix ? codeInfo.prefix.length + 1 : 0) + codeInfo.openLine.length + 1;
      const len = v.state.doc.length;
      if (pending?.clickXY) {
        // On mixed mounts the layout barely changed (only the code element
        // was swapped), so the click maps accurately onto the fresh editor.
        let p = cursorAtCoords(v, pending.clickXY.x, pending.clickXY.y, 'start');
        if (pending.staticPos !== null) {
          let top: number | null = null;
          try {
            top = v.coordsAtPos(p)?.top ?? null;
          } catch {
            top = null;
          }
          if (top === null || Math.abs(top - pending.clickXY.y) > 60) {
            p = Math.max(0, Math.min(pending.staticPos - beforeLen, len));
          }
        }
        applyCursorAndScroll(v, p);
      } else if (pending) {
        const p =
          pending.pos === 'start'
            ? 0
            : pending.pos === 'end'
              ? len
              : Math.max(0, Math.min(pending.pos - beforeLen, len));
        applyCursorAndScroll(v, p);
      }
      this.focusStartSnapshot = serializeDocument(this.doc);
      // The dedicated code editor bypasses the generic mount path — without
      // this the companion breadcrumb keeps showing the PREVIOUS block.
      this.updateOutlinePath();
      return;
    }
    // One-shot source mode on a MIXED block (image/prose + fence): the fence
    // SOURCE (markers + language word editable) mounts through the code
    // editor IN PLACE of the rendered code element, prefix kept rendered —
    // the generic whole-text editor would collapse the image to a text line
    // and jump the page by its height. Pure blocks fall through to the
    // generic editor (their whole text IS the fence source).
    if (this.sourceModeBlock === b) {
      const mixed = parseCodeFence(b.text);
      if (mixed?.prefix) {
        const holder = cachedStaticEl(b);
        const codeEl =
          holder?.querySelector<HTMLElement>('.lgp-code-block:not(.lgp-code-editing)') ?? null;
        if (holder && codeEl) {
          const pending = this.pendingFocus;
          this.pendingFocus = null;
          content.appendChild(holder);
          this.focusedCode = mountCodeEditor(content, b, mixed, this, {
            replaceEl: codeEl,
            source: true,
          });
          // Cursor: the doc starts at the opening fence line — whole-text
          // positions shift by the prefix (plus its newline).
          const cv = this.focusedCode.view;
          const len = cv.state.doc.length;
          if (pending) {
            const off = mixed.prefix.length + 1;
            const p =
              pending.pos === 'start'
                ? 0
                : pending.pos === 'end'
                  ? len
                  : Math.max(0, Math.min(pending.pos - off, len));
            applyCursorAndScroll(cv, p);
          }
          this.focusStartSnapshot = serializeDocument(this.doc);
          this.updateOutlinePath();
          return;
        }
      }
    }
    const pending = this.pendingFocus;
    const pos: CursorPos = pending?.pos ?? this.savedFocusPos;
    this.pendingFocus = null;
    const v = mountFocusedEditor(content, b, pos, this);
    this.focusedView = v;
    if (pending?.clickXY) {
      // posAtCoords on the fresh view uses the CLICK's page coords, but the
      // raw-text CM6 is much shorter than the static render when it contained
      // images/rendered code — the mapping clamps to doc end and the caret
      // lands far from the click. When the mapped caret line is visibly off
      // the click Y, fall back to the pre-swap static-render position.
      let p = cursorAtCoords(v, pending.clickXY.x, pending.clickXY.y, 'end');
      if (pending.staticPos !== null) {
        let top: number | null = null;
        try {
          top = v.coordsAtPos(p)?.top ?? null;
        } catch {
          top = null;
        }
        if (top === null || Math.abs(top - pending.clickXY.y) > 60) {
          p = Math.max(0, Math.min(pending.staticPos, v.state.doc.length));
        }
      }
      // Scroll-compensate: the raw editor is far shorter than the static
      // render it replaced (images/code collapse to single lines), so the
      // caret can land off-screen without this.
      applyCursorAndScroll(v, p);
    }
    this.focusStartSnapshot = serializeDocument(this.doc);
  }

  // ------------------------------------------------------------------
  // Focus / blur lifecycle
  // ------------------------------------------------------------------

  focusBlock(b: Block, pos: CursorPos = 'end'): void {
    if (this.focusedCode?.block === b) {
      this.focusedCode.view.focus();
      return;
    }
    if (this.focusedBlock === b && this.focusedView) {
      applyCursor(this.focusedView, pos);
      this.focusedView.focus();
      return;
    }
    this.commitFocusedText();
    this.focusedBlock = b;
    this.lastEditedBlock = b;
    this.pendingFocus = { pos, clickXY: null, staticPos: null };
    this.savedFocusPos = pos;
    // Incremental: swap static ↔ CM6 inside the two affected wraps only.
    // Full render fallback when the target is beyond the virtual-scroll cap
    // or not currently rendered.
    if (!this.ensureCapFor(b) && this.mountFocusedInDom(b)) {
      this.updateOutlinePath();
      return;
    }
    this.render(); // render() → renderInner() syncs the outline path
  }

  focusBlockFromClick(b: Block, ev: MouseEvent): void {
    this.clearSelection(); // editing replaces multi-selection
    const xy = { x: ev.clientX, y: ev.clientY };
    if (this.focusedCode?.block === b) {
      this.focusedCode.view.focus();
      return;
    }
    if (this.focusedBlock === b && this.focusedView) {
      const p = cursorAtCoords(this.focusedView, xy.x, xy.y, 'end');
      // A click BELOW the raw-text doc (the raw editor is much shorter than
      // the static render it replaced) clamps to doc end — visibly far from
      // the click. Keep the caret where it is instead of teleporting it.
      let top: number | null = null;
      try {
        top = this.focusedView.coordsAtPos(p)?.top ?? null;
      } catch {
        top = null;
      }
      if (top === null || Math.abs(top - xy.y) > 60) return;
      applyCursor(this.focusedView, p);
      this.focusedView.focus();
      return;
    }
    // Capture the click's source position from the STATIC render BEFORE the
    // CM6 swap: tall rendered elements (images, code blocks) make the raw-text
    // editor much shorter, so post-mount posAtCoords maps the stale Y far off
    // (usually clamping to doc end) and the caret "disappears" from the click
    // point — e.g. clicking right before a rendered fence.
    const staticPos = this.staticClickPos(b, ev.clientY);
    this.commitFocusedText();
    this.focusedBlock = b;
    this.lastEditedBlock = b;
    this.pendingFocus = { pos: 'end', clickXY: xy, staticPos };
    this.savedFocusPos = 'end';
    if (!this.mountFocusedInDom(b)) this.render();
    else this.updateOutlinePath();
  }

  /**
   * Map a click Y (page coords) onto a doc position of b's text using the
   * static render's top-level children. Markdown block constructs map 1:1 to
   * source line groups (paragraph run / heading / fenced run), so "nearest
   * child at/above Y" → end of that child's last source line. Returns null
   * when no static render (focused, or structure not mapped).
   */
  private staticClickPos(b: Block, y: number): number | null {
    if (b.kind === 'raw') return null;
    const wrap = findBlockEl(b);
    const holder = wrap?.querySelector(':scope > .block-main > .block-content > .block-content-static') as HTMLElement | null;
    if (!holder || !holder.children.length) return null;
    const lines = b.text.split('\n');
    if (lines.length <= 1) return null;
    // Line-run per top-level child: fences swallow their whole run; headings
    // one line; everything else consumes up to the next fence/heading.
    const runs: Array<[number, number]> = [];
    let li = 0;
    for (let ci = 0; ci < holder.children.length && li < lines.length; ci++) {
      const tag = (holder.children[ci] as HTMLElement).tagName;
      const isFence = /^\s*(```|~~~)/.test(lines[li] ?? '');
      let j = li;
      if (isFence || tag === 'PRE') {
        if (isFence) {
          j++;
          while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j])) j++;
          if (j < lines.length) j++;
        } else j = li + 1;
      } else if (/^H[1-6]$/.test(tag)) {
        j = li + 1;
      } else {
        while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j]) && !/^#{1,6}\s/.test(lines[j])) j++;
        if (j === li) j = li + 1;
      }
      runs.push([li, Math.min(j - 1, lines.length - 1)]);
      li = j;
    }
    if (!runs.length) return null;
    // Nearest child at/above the click Y.
    let pick = -1;
    for (let i = 0; i < holder.children.length && i < runs.length; i++) {
      const r = (holder.children[i] as HTMLElement).getBoundingClientRect();
      if (y < r.top) break;
      pick = i;
    }
    if (pick < 0) return 0;
    const [startLine, endLine] = runs[pick];
    let line = endLine;
    let atLineStart = false;
    const rect = (holder.children[pick] as HTMLElement).getBoundingClientRect();
    if (rect.height > 0 && endLine > startLine) {
      const ratio = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
      if (ratio <= 0.25) {
        // Top band of a multi-line run (e.g. right before a rendered fence):
        // the caret goes to the START of the run's first line — "before ```".
        line = startLine;
        atLineStart = true;
      } else {
        line = startLine + Math.round(ratio * (endLine - startLine));
      }
    }
    let pos = 0;
    for (let i = 0; i < line; i++) pos += lines[i].length + 1;
    return atLineStart ? pos : pos + lines[line].length;
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
    // The editor now shows the props as text — drop the static props row.
    wrap.querySelector(':scope > .block-props-row')?.remove();
    this.mountFocusedInto(content as HTMLElement);
    return true;
  }

  /** Destroy the focused CM6 instance if it lives inside `el` (about to be wiped). */
  destroyFocusedInside(el: HTMLElement): void {
    const fc = this.focusedCode;
    if (fc && el.contains(fc.view.dom)) {
      this.commitFocusedText(); // land the code edit before the section is wiped
    }
    const v = this.focusedView;
    if (v && el.contains(v.dom)) {
      v.destroy();
      this.focusedView = null;
    }
    const ee = this.embedEdit;
    if (ee && el.contains(ee.view.dom)) this.commitEmbedEdit();
  }

  /**
   * Commit a SPECIFIC editor view into its block, bypassing host bookkeeping
   * (focusedView/focusedBlock). Used by the Escape capture handler: in
   * background windows the focus juggling can clear host state while the
   * editor is still on screen, and Esc must still land the edit.
   */
  commitViewNow(view: EditorView, block: Block): void {
    const changed = commitEditorText(view, block, this.templateContext());
    if (this.sourceModeBlock === block) this.sourceModeBlock = null;
    if (this.focusedView === view) {
      this.focusedView = null;
      this.focusedBlock = null;
    }
    view.destroy();
    clearActiveBlockEditor(this.app);
    if (changed) {
      this.undo.push(this.focusStartSnapshot);
      this.markDirty();
    }
    refreshBlockContent(block, this);
  }

  /** Commit CM6 text back into the block model; single-block static refresh. */
  commitFocusedText(): void {
    const fc = this.focusedCode;
    if (fc) {
      this.focusedCode = null;
      this.focusedBlock = null;
      const content = fc.view.state.doc.toString();
      const head = fc.prefix ? fc.prefix + '\n' : '';
      // Source mode: the doc IS the fence source (markers/language possibly
      // edited) — written verbatim under the prefix. Otherwise re-wrap the
      // fence around the content.
      const newText = fc.source
        ? head + content
        : fc.closed
          ? `${head}${fc.openLine}
${content}
${fc.fence}`
          : `${head}${fc.openLine}
${content}`;
      fc.view.destroy();
      // Mixed-block mount: put the static code element back so the cached
      // static render (image + code) stays valid — the commit re-attaches it
      // unchanged, and nothing re-renders or flickers.
      if (fc.editingWrap && fc.restoreEl && fc.editingWrap.parentElement) {
        fc.editingWrap.replaceWith(fc.restoreEl);
      }
      if (fc.block.text !== newText) {
        fc.block.text = newText;
        this.undo.push(this.focusStartSnapshot);
        this.markDirty();
      }
      // One-shot source mode ends when its editor commits.
      if (this.sourceModeBlock === fc.block) this.sourceModeBlock = null;
      refreshBlockContent(fc.block, this);
      this.updateOutlinePath();
      return;
    }
    const v = this.focusedView;
    const b = this.focusedBlock;
    this.focusedView = null;
    this.focusedBlock = null;
    if (!v || !b) return;
    // "Source mode" is a one-shot edit session: committing ITS editor ends it.
    // Scoped to THIS block — focusBlock() commits the PREVIOUS editor on the
    // way to mounting a source-mode editor for the NEXT one, and that commit
    // must not clear the just-set flag. (The early return above matters too:
    // nothing focused → keep the flag.)
    if (this.sourceModeBlock === b) this.sourceModeBlock = null;
    const changed = commitEditorText(v, b, this.templateContext());
    if (b.kind === 'list' && b.text === '' && !b.frontmatter && this.doc.blocks[0] === b && this.file) registerLogseqPageProps(this.file.path, b.props);
    else clearLogseqPageProps(this.file?.path ?? '');
    v.destroy();
    clearActiveBlockEditor(this.app);
    if (changed) {
      this.undo.push(this.focusStartSnapshot);
      this.markDirty();
    }
    // Always restore static content: the CM6 DOM was removed by destroy(),
    // and the cached static el re-attaches synchronously when unchanged.
    refreshBlockContent(b, this);
    this.updateOutlinePath();
  }

  /** Toggle page-wide source mode (status bar): raw markdown for every block. */
  togglePageSourceMode(): void {
    this.commitFocusedText();
    this.sourceModeBlock = null;
    this.pageSourceMode = !this.pageSourceMode;
    this.render();
  }

  /** Keep the Logseq-page-props registry fresh for other plugins. */
  private syncPagePropsRegistry(): void {
    const path = this.file?.path;
    if (!path) return;
    const pb = this.doc.blocks[0];
    if (pb && pb.kind === 'list' && pb.text === '' && !pb.frontmatter) registerLogseqPageProps(path, pb.props);
    else clearLogseqPageProps(path);
  }

  /** CM6 updateListener hooks. */
  onFocusedTextChange(): void {
    this.markDirty();
  }

  onFocusedBlur(): void {
    // CM6 fires a blur on initial mount when the Electron window is not the
    // OS-foreground window (CDP-driven tests, background windows). Committing
    // there would tear down the editor the user is actively typing into.
    // Re-check on the next task: if focus returned to THIS view's CM6, it was
    // a focus juggle, not a real blur.
    window.setTimeout(() => {
      const v = this.focusedView;
      if (!v) return;
      if (v.hasFocus || document.activeElement === v.contentDOM || v.contentDOM.contains(document.activeElement)) return;
      this.commitFocusedText();
    }, 0);
  }

  // ------------------------------------------------------------------
  // In-place editing of an embedded block (Logseq-style)
  // ------------------------------------------------------------------

  /**
   * Edit a block of an embedded sub-tree right inside its row — only the
   * clicked row swaps to a CM6 editor, the rest of the embed stays visible.
   * `path` is the child-index path from the embedded root (`[]` = the root).
   * Works for blocks of this file and of any other file (see writeEmbedText).
   */
  startEmbedEdit(row: HTMLElement, source: EmbedSource, path: number[] = []): void {
    this.commitEmbedEdit(); // finish a previous in-place edit first
    this.commitFocusedText(); // ...and any outline edit
    this.clearSelection();
    const content = row.querySelector(':scope > .embed-main > .embed-content') as HTMLElement | null;
    if (!content) return;
    const target = blockAtPath(source.block, path) ?? source.block;
    row.classList.add('is-editing');
    row.closest('.block-embed')?.classList.add('is-editing'); // e.g. lift max-height
    content.empty();
    const view = new EditorView({
      doc: blockEditorDoc(target),
      parent: content,
      extensions: createEmbedExtensions(
        this,
        () => this.commitEmbedEdit(),
        () => this.commitEmbedEditAndNew(source, path),
        (shift) => this.handleEmbedTab(shift),
      ),
    });
    applyCursor(view, 'end');
    view.focus();
    syncActiveBlockEditor(this.app, this, view);
    // Real Escape keystrokes never reach CM6's keymap: CM6's capture-phase
    // keydown handler marks keyCode 27 as handled (tabFocusMode bookkeeping)
    // and the bubbling keymap dispatch then skips the defaultPrevented
    // event. Catch Escape here in the CAPTURE phase on the editor DOM —
    // capture listeners run before CM6's own capture handler regardless of
    // registration order, and preventDefault/stopPropagation here keeps the
    // event out of the outline's global handlers too.
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      void this.commitEmbedEdit();
    };
    view.dom.addEventListener('keydown', escHandler, true);
    this.embedEdit = { view, source, path, row, escHandler };
  }

  /**
   * Commit the current embed edit, then create a NEW EMPTY BLOCK in the
   * SOURCE page, directly below the block that was being edited (Logseq md
   * parity: Enter below a block continues writing in the page the block
   * lives in — for embeds that is the embedded source, not the host).
   *
   * Same-file embeds: insert via the model (undo/patch). Cross-file embeds
   * and page-embed rows: patch the source file on disk (guarded write), then
   * refresh the open views / the embed box itself.
   */
  commitEmbedEditAndNew(src: EmbedSource, path: number[]): void {
    // Capture the edited row BEFORE committing (commit clears embedEdit);
    // used to locate the embed box that owns this edit.
    const editRow = this.embedEdit?.row ?? null;
    // Awaited: the commit's text write must land BEFORE the insert below
    // re-parses/re-serializes the same source (disk mode race).
    void this.commitEmbedEdit().then(() => {
      this.commitEmbedEditAndNewInner(src, path, editRow);
    });
  }

  /**
   * Tab / Shift+Tab inside an in-place embed edit: indent/outdent the edited
   * block in its source tree, then re-open the edit on it (Logseq parity).
   */
  handleEmbedTab(shift: boolean): boolean {
    const src = this.embedEdit?.source ?? null;
    const path = this.embedEdit?.path ?? null;
    const editRow = this.embedEdit?.row ?? null;
    if (!src || !path || !editRow) return false;
    void this.commitEmbedEdit().then(() => {
      this.commitEmbedEditTabInner(src, path, editRow, shift);
    });
    return true;
  }

  private commitEmbedEditTabInner(src: EmbedSource, path: number[], editRow: HTMLElement | null, shift: boolean): void {
    const isPageEmbed = src.id === '';
    const isLocal = !src.file || src.file.path === this.file?.path;
    const box = isPageEmbed
      ? ((editRow?.closest('.block-embed.block-page-embed') as HTMLElement | null) ??
         (this.treeEl.querySelector('.block-embed.block-page-embed') as HTMLElement | null))
      : findEmbedBox(this, src.id);
    if (!box) return;
    const target = blockAtPath(src.block, path) ?? src.block;

    const indentViaView = (view: BlockEditorView): boolean => {
      const addrRoot = isPageEmbed ? pseudoRootOf(view.doc.blocks) : findBlockById(view.doc.blocks, src.id);
      const t = addrRoot ? (blockAtPath(addrRoot, path) ?? (path.length === 0 ? addrRoot : null)) : null;
      if (!t) return false;
      const oldParent = t.parent;
      view.mutate(() => (shift ? outdent(t) : indent(t)), () => ({ lists: [oldParent, t.parent] }));
      return true;
    };

    // After the box re-renders, re-open the in-place editor on the indented
    // block (matched against embed rows by block identity — same-file model
    // objects survive the re-render).
    const editIndentedWhenReady = (): void => {
      const t0 = Date.now();
      const tryFind = (): void => {
        const hit = findEmbedRowForBlock(box, target);
        if (hit) {
          this.startEmbedEdit(hit.row, hit.src, hit.path);
          return;
        }
        if (Date.now() - t0 < 4000) window.setTimeout(tryFind, 60);
      };
      tryFind();
    };

    if (isLocal) {
      if (!indentViaView(this)) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(this, box, src.file!).then(() => editIndentedWhenReady());
      } else {
        const fresh = findBlockById(this.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, this);
        editIndentedWhenReady();
      }
      return;
    }

    const other = src.file ? this.findOpenBlockEditor(src.file.path) : null;
    if (other) {
      if (!indentViaView(other)) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(this, box, src.file!).then(() => editIndentedWhenReady());
      } else {
        const fresh = findBlockById(other.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, this);
      }
      return;
    }

    // Nobody has the source open: patch the file on disk (guarded write).
    void mutatePageEmbedSource(this, src.file!, (doc) => {
      const root = src.id ? findBlockById(doc.blocks, src.id) : pseudoRootOf(doc.blocks);
      const t = root ? blockAtPath(root, path) : null;
      if (t) (shift ? outdent(t) : indent(t));
    }).then(() => {
      if (isPageEmbed) void refreshPageEmbedBox(this, box, src.file!);
      else void refreshEmbedBox(this, box, src.id);
    });
  }

  private commitEmbedEditAndNewInner(src: EmbedSource, path: number[], editRow: HTMLElement | null): void {
    const isPageEmbed = src.id === '';
    const isLocal = !src.file || src.file.path === this.file?.path;
    const box = isPageEmbed
      ? ((editRow?.closest('.block-embed.block-page-embed') as HTMLElement | null) ??
         (this.treeEl.querySelector('.block-embed.block-page-embed') as HTMLElement | null))
      : findEmbedBox(this, src.id);
    if (!box) return;

    /**
     * Where a "new block below the addressed row" lands. Root rows of block
     * embeds grow a LAST CHILD (the new block stays inside the embed and can
     * be focused there — Logseq embed-scope parity); every other row takes a
     * sibling below. A page-embed root row (`[]`) appends to the page's top
     * level (its "rows" ARE the page's top-level blocks).
     *
     * `newPath` is expressed in the SAME address space as `path` — block-
     * relative — so it can be matched against embed rows after a re-render.
     */
    const planInsert = (
      docBlocks: Block[],
      addrRoot: Block | null,
    ): { list: Block[]; index: number; parent: Block | null; newPath: number[] } | null => {
      const t = addrRoot ? (blockAtPath(addrRoot, path) ?? addrRoot) : null;
      if (!t) return null;
      if (path.length === 0) {
        if (isPageEmbed) return { list: docBlocks, index: docBlocks.length, parent: null, newPath: [docBlocks.length] };
        return { list: t.children, index: t.children.length, parent: t, newPath: [t.children.length] };
      }
      const sibs = t.parent ? t.parent.children : docBlocks;
      const idx = sibs.indexOf(t);
      if (idx < 0) return null;
      return { list: sibs, index: idx + 1, parent: t.parent ?? null, newPath: [...path.slice(0, -1), idx + 1] };
    };

    /**
     * After the box re-renders, the new empty row exists in the DOM but the
     * re-render is async (markdown resolves on micro/next tasks), so the
     * row-path registry may lag one tick. Poll briefly, then start the
     * in-place editor on the row.
     */
    const editNewRowWhenReady = (np: number[]): void => {
      const t0 = Date.now();
      const tryFind = (): void => {
        const row = findEmbedRow(box, np);
        if (row) {
          const liveSrc = getEmbedRowSource(row);
          if (liveSrc) this.startEmbedEdit(row, liveSrc, np);
          return;
        }
        if (Date.now() - t0 < 4000) window.setTimeout(tryFind, 60);
      };
      tryFind();
    };

    // ---- 1) Insert the new empty block into the source ----
    // ---- 2) Refresh the embed box -------------------------
    // ---- 3) In-place edit the new row ---------------------
    const insertViaView = (view: BlockEditorView): number[] | null => {
      const addrRoot = isPageEmbed ? pseudoRootOf(view.doc.blocks) : findBlockById(view.doc.blocks, src.id);
      const plan = planInsert(view.doc.blocks, addrRoot);
      if (!plan) return null;
      const nb = createBlock('');
      view.mutate(() => {
        plan.list.splice(plan.index, 0, nb);
        nb.parent = plan.parent;
      });
      return plan.newPath;
    };

    if (isLocal && !isPageEmbed) {
      // Same-file block embed: model insert in THIS view, then re-render the
      // box from the live model (fresher than disk during the save debounce).
      // mutate() may fully re-render the view (virtual cap / patch fallback),
      // replacing the box DOM — re-locate it afterwards.
      const np = insertViaView(this);
      if (!np) return;
      const boxNow = findEmbedBox(this, src.id);
      const fresh = findBlockById(this.doc.blocks, src.id);
      if (!boxNow || !fresh) return;
      const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
      renderEmbedBodyFrom(boxNow, freshSrc, src.id, this);
      editNewRowWhenReady(np);
      return;
    }

    const filePath = src.file?.path ?? '';
    const other = isLocal ? null : this.findOpenBlockEditor(filePath);
    if (other) {
      // Source page open in another block-editor view: insert through ITS
      // model so unsaved edits / undo / save stay authoritative.
      const np = insertViaView(other);
      if (!np) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(this, box, src.file!).then(() => editNewRowWhenReady(np));
      } else {
        const fresh = findBlockById(other.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, this);
        editNewRowWhenReady(np);
      }
      return;
    }

    // Nobody has the source open: patch the file on disk (guarded write:
    // backup + operation log), re-render the box from disk, then edit the
    // new row. An open native-editor view adopts the change via its own
    // vault-modify handler — no forced reload from here.
    if (!src.file) return;
    let npDisk: number[] | null = null;
    void mutatePageEmbedSource(this, src.file, (doc) => {
      const addrRoot = isPageEmbed ? pseudoRootOf(doc.blocks) : findBlockById(doc.blocks, src.id);
      const plan = planInsert(doc.blocks, addrRoot);
      if (!plan) return;
      const nb = createBlock('');
      plan.list.splice(plan.index, 0, nb);
      nb.parent = plan.parent;
      npDisk = plan.newPath;
    }).then((ok) => {
      const np = npDisk as number[] | null;
      if (!ok || !np) return;
      const refreshed = isPageEmbed
        ? refreshPageEmbedBox(this, box, src.file!)
        : refreshEmbedBox(this, box, src.id);
      void Promise.resolve(refreshed).then(() => editNewRowWhenReady(np));
    });
  }

  /** Commit + tear down the in-place embed editor; resolves after any disk write lands. */
  async commitEmbedEdit(): Promise<boolean> {
    const cur = this.embedEdit;
    this.embedEdit = null;
    if (!cur) return false;
    const raw = expandTemplates(cur.view.state.doc.toString(), new Date(), this.templateContext());
    cur.view.dom.removeEventListener('keydown', cur.escHandler, true);
    cur.view.destroy();
    clearActiveBlockEditor(this.app);
    cur.row.classList.remove('is-editing');
    cur.row.closest('.block-embed')?.classList.remove('is-editing');
    const target = blockAtPath(cur.source.block, cur.path) ?? cur.source.block;
    const { text: clean, props } = splitPropLines(raw);
    const changed = clean !== target.text || !propsShallowEqual(editableProps(target), props);
    if (changed) {
      target.text = clean;
      applyBlockProps(target, props);
      // Writers re-extract, so the raw doc text is safe to hand over.
      await this.writeEmbedText(cur.source, cur.path, raw);
    }
    rerenderEmbedRow(cur.row, cur.source, cur.path, this);
    return changed;
  }

  /** Write an in-place embed edit back into the block the row renders. */
  private async writeEmbedText(src: EmbedSource, path: number[], text: string): Promise<void> {
    const filePath = src.file?.path;
    // Same file: go through the model so undo / dirty / rendering stay in sync.
    if (!filePath || filePath === this.file?.path) {
      // Page-embed rows of THIS file (no id) are addressed by path, not by id.
      if (src.id === '') {
        this.applyBlockTextAtPath(path, text);
        return;
      }
      this.applyBlockText(src.id, path, text);
      return;
    }
    // Another file: prefer the block editor that has it open (keeps its undo
    // stack and any unsaved edits), otherwise patch the markdown on disk.
    const other = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)
      .map((l) => l.view as BlockEditorView)
      .find((v) => v.file?.path === filePath);
    if (other) {
      if (src.id === '') other.applyBlockTextAtPath(path, text);
      else other.applyBlockText(src.id, path, text);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    // Path-based addressing handles id-less blocks (page-embed rows) and
    // id-carrying blocks alike; the paths were captured from the same parse.
    const ok = await mutatePageEmbedSource(this, file, (doc) => {
      const root = src.id ? findBlockById(doc.blocks, src.id) : pseudoRootOf(doc.blocks);
      if (!root) return;
      const b = blockAtPath(root, path);
      if (!b) return;
      const { text: clean, props } = splitPropLines(text);
      b.text = clean;
      applyBlockProps(b, props);
    });
    if (ok) {
      // An open view adopts the change via its vault-modify handler (its own
      // unsaved edits win and re-save) — no forced reload here.
    }
  }

  /** Apply a text change to a block addressed by child-index path (id-less rows). */
  private applyBlockTextAtPath(path: number[], text: string): boolean {
    const root = pseudoRootOf(this.doc.blocks);
    const b = blockAtPath(root, path);
    if (!b) return false;
    const { text: clean, props } = splitPropLines(text);
    if (b.text === clean && propsShallowEqual(editableProps(b), props)) return false;
    this.undo.push(this.serializeCurrent());
    b.text = clean;
    applyBlockProps(b, props);
    this.markDirty();
    refreshBlockContent(b, this);
    this.focusStartSnapshot = serializeDocument(this.doc);
    return true;
  }

  /** First open block-editor view showing `path` (this view included), if any. */
  findOpenBlockEditor(path: string): BlockEditorView | null {
    return (
      this.app.workspace
        .getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)
        .map((l) => l.view as BlockEditorView)
        .find((v) => v.file?.path === path) ?? null
    );
  }

  /** Apply a text change made outside this view (e.g. an in-place embed edit). */
  applyBlockText(id: string, path: number[], text: string): boolean {
    const root = findBlockById(this.doc.blocks, id);
    const b = root ? blockAtPath(root, path) : null;
    if (!b) return false;
    const { text: clean, props } = splitPropLines(text);
    if (b.text === clean && propsShallowEqual(editableProps(b), props)) return false;
    this.undo.push(this.serializeCurrent());
    b.text = clean;
    applyBlockProps(b, props);
    this.markDirty();
    refreshBlockContent(b, this);
    this.focusStartSnapshot = serializeDocument(this.doc);
    return true;
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

  /** Logseq parity: clicking the empty area under the last block appends a
   *  new block at the end of the visible outline and focuses it. */
  addBlockAtEnd(): void {
    let nb: Block | null = null;
    this.mutate(
      () => {
        nb = createBlock('');
        const last = this.doc.blocks[this.doc.blocks.length - 1];
        if (last) {
          const sibs = siblingsOf(last);
          sibs.splice(sibs.indexOf(last) + 1, 0, nb);
          nb.parent = last.parent ?? null;
        } else {
          this.doc.blocks.push(nb);
        }
      },
      () => ({ lists: [null] }),
    );
    if (nb) this.focusBlock(nb as Block, 0);
  }

  toggleCollapse(b: Block): void {
    this.mutate(
      () => toggleCollapse(b),
      () => ({ subtree: b }),
    );
  }

  /** Guide-line click: folds/unfolds the content INSIDE the guide (the
   *  clicked block itself is not folded). Depths come from the settings
   *  (`guideLineCollapseLevels` / `guideLineExpandLevels`, 0 = all levels). */
  toggleCollapseGuide(b: Block): void {
    const expanding = isCollapsed(b) || b.children.some((c) => isCollapsed(c));
    this.mutate(
      () => {
        if (expanding) {
          if (isCollapsed(b)) setCollapsed(b, false); // stub click on a folded block
          expandLevels(b, this.plugin.settings.guideLineExpandLevels);
        } else {
          collapseLevels(b, this.plugin.settings.guideLineCollapseLevels);
        }
      },
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

  /**
   * Focus (zoom) a block: the editor shows its children — or the block itself
   * when it is a leaf, so focusing never lands on an empty page.
   */
  zoomIn(b: Block): void {
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

  autocompleteSources(embed = false): CompletionSource[] {
    return autocompleteSources(this, embed);
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
  // Slash-command bridges (block-model structure commands)
  // ------------------------------------------------------------------

  /** Indent / outdent the focused block, as if Tab / Shift+Tab was pressed. */
  handleTabFromCommand(shift: boolean): void {
    const b = this.focusedBlock;
    if (!b) return;
    const offset = this.focusedView?.state.selection.main.head ?? 0;
    const oldParent = b.parent;
    this.mutate(
      () => {
        if (shift) outdent(b);
        else indent(b);
      },
      () => ({ lists: [oldParent, b.parent] }),
    );
    this.focusBlock(b, Math.min(offset, b.text.length));
  }

  /** Insert a new empty sibling below the focused block (as Enter does). */
  handleEnterFromCommand(): void {
    const b = this.focusedBlock;
    if (!b || b.kind === 'raw') return;
    let nb: Block | null = null;
    const parent = b.parent;
    this.mutate(
      () => {
        nb = splitBlock(b, b.text.length);
      },
      () => ({ lists: [parent] }),
    );
    const target = nb as Block | null;
    if (target) this.focusBlock(target, 0);
  }

  /** Delete the focused block; its children move up one level (Logseq behavior). */
  deleteFocusedBlock(): void {
    const b = this.focusedBlock;
    if (!b) return;
    const parent = b.parent;
    const kids = b.children;
    this.mutate(
      () => {
        const sibs = removeBlock(b);
        // Re-insert children at the removed block's position (Logseq keeps
        // them in place, lifted one level).
        const idx = sibs.indexOf(b) >= 0 ? sibs.indexOf(b) : parent ? parent.children.length : 0;
        for (let i = kids.length - 1; i >= 0; i--) {
          const k = kids[i];
          sibs.splice(idx, 0, k);
          k.parent = b.parent ?? null;
        }
      },
      () => ({ full: true }),
    );
  }

  // ------------------------------------------------------------------
  // Collapse-all / expand-all (Logseq md parity)
  // ------------------------------------------------------------------

  /** Ctrl+\ semantics: anything folded → expand all; otherwise fold all. */
  toggleCollapseAll(): void {
    let hasCollapsed = false;
    const walk = (b: Block): void => {
      if (b.props['collapsed'] === 'true') hasCollapsed = true;
      b.children.forEach(walk);
    };
    this.doc.blocks.forEach(walk);
    if (hasCollapsed) this.expandAll();
    else this.collapseAll();
  }

  /** Recursively set `collapsed:: true` on every block that has children. */
  collapseAll(): void {
    this.mutate(
      () => {
        const walk = (b: Block): void => {
          if (b.children.length > 0) {
            b.props['collapsed'] = 'true';
            b.children.forEach(walk);
          }
        };
        this.doc.blocks.forEach(walk);
      },
      () => ({ full: true }),
    );
  }

  /** Remove the `collapsed::` prop from every block. */
  expandAll(): void {
    this.mutate(
      () => {
        const walk = (b: Block): void => {
          delete b.props['collapsed'];
          b.children.forEach(walk);
        };
        this.doc.blocks.forEach(walk);
      },
      () => ({ full: true }),
    );
  }

  // ------------------------------------------------------------------
  // Journal navigation (prev / next day, Logseq md parity)
  // ------------------------------------------------------------------

  /** Open the journal N days from THIS file's date (or today when not a journal). */
  async openAdjacentJournal(days: number): Promise<void> {
    const { openJournalFor, journalDateFromName } = await import('../features/dailyNote');
    const name = (this.file?.name ?? '').replace(/\.md$/, '');
    const base = journalDateFromName(name);
    await openJournalFor(this.plugin, days, base);
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
    // Logseq md parity: Ctrl+\ toggles collapse-all / expand-all.
    if (key === '\\') {
      ev.preventDefault();
      this.toggleCollapseAll();
      return;
    }
    if (this.focusedView || this.focusedCode) return;
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
    // expansion, no re-render): auto-save and external-change comparisons
    // must reflect exactly what is on screen even mid-edit. Trailing
    // `key:: value` lines get the SAME treatment a commit would give them —
    // they are properties, not body text — so an auto-save in the middle of
    // typing props can never flatten them into the block's text.
    const v = this.focusedView;
    const b = this.focusedBlock;
    if (v && b) {
      const live = v.state.doc.toString();
      if (live !== blockEditorDoc(b)) {
        const savedText = b.text;
        const savedProps = b.props;
        const { text, props } = splitPropLines(live);
        b.text = text;
        applyBlockProps(b, props);
        const s = serializeDocument(this.doc);
        b.text = savedText;
        b.props = savedProps;
        return s;
      }
    }
    return serializeDocument(this.doc);
  }

  private markDirty(): void {
    logOp(this.plugin, 'blocks.edit', this.file?.path ?? '', 'ok');
    // First plugin-session write to this file: snapshot the on-disk original
    // (fire-and-forget; the debounced save gives it time to land).
    const f = this.file;
    if (f) void this.plugin.backups.ensureSessionBackup(f);
    this.requestSave(); // native: sets dirty + debounced save (2s)
  }

  private async onExternalModify(file: TAbstractFile): Promise<void> {
    if (!this.file || file !== this.file) return;
    const data = await this.app.vault.cachedRead(this.file);
    const ours = this.serializeCurrent();
    if (data === ours) return; // our own write echoed (or no real change)
    const haveLocal = this.lastDiskData === null || ours !== this.lastDiskData;
    if (!haveLocal) {
      // No unsaved local edits — silently adopt the external version.
      this.setViewData(data, false);
      return;
    }
    // External change while we hold unsaved edits: the EDITOR always wins.
    // The debounced save will overwrite the disk version; the original disk
    // content is already recoverable via the session backup taken at the
    // first markDirty of this session (plus the pre-write backup in the
    // save path). No user prompt — editor-wins is the policy.
    this.requestSave();
  }
}
