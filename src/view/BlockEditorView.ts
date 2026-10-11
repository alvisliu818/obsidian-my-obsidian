/**
 * BlockEditorView — the Logseq-style outline editor view (TextFileView).
 *
 * Owns the parsed block forest, the focused-block CM6 lifecycle, structural
 * mutations (with snapshot undo), zoom state, and the save pipeline (native
 * TextFileView requestSave/save — files stay 100% standard markdown).
 */

import { MarkdownRenderer, Notice, TFile, TextFileView, parseYaml, stringifyYaml, type TAbstractFile, type ViewState, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { CompletionSource } from '@codemirror/autocomplete';
import type LogseqEditorPlugin from '../main';
import type { Block, ParsedDocument } from '../types';
import { applyBlockProps, blockEditorDoc, createBlock, docPageProps, editableProps, isPagePropsBlock, propsShallowEqual, setCollapsed, splitPropLines, syncFrontmatterProps } from '../types';
import { parseDocument } from '../core/parser';
import { clearLogseqPageProps, registerLogseqPageProps } from '../pagePropsRegistry';
import { serializeBlock, serializeDocument } from '../core/serializer';
import { blockAtPath, cycleMarker, duplicateBlock, findBlockById, flattenVisible, indent, isDescendant, linkParents, moveBlockGroup, moveBlockVertically, outdent, pseudoRootOf, rangeAnchor, registerRoots, removeBlock, siblingsOf, splitBlock, splitRawToOutline, visibleRange, type MovePosition } from '../core/treeOps';
import { foldLevelOf, foldValueFor, nextFoldLevel, normFoldKey, subtreeFoldTargets, type FoldLevel } from '../core/fold';
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
  refreshTracetimeLabels,
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
import { collapseLevels, expandLevels, isSubtreeFullyFolded, toggleCollapse } from '../interactions/collapse';
import { isCollapsed } from '../types';
import { buildTraceTimeIndex, formatTraceTimestamp, traceTimeModifiedAt, traceTimePluginOf, type TraceTimeIndex, type TraceTimeState } from '../features/tracetime';
import { breadcrumbFor, restoreZoomed, visibleRootsFor, zoomId } from '../interactions/zoom';
import { attachDnd } from '../interactions/dnd';
import { attachContextMenu } from '../interactions/contextMenu';
import { classifyGlobalKey, modifiersOf } from '../interactions/hotkeys';
import { clearActiveBlockEditor, syncActiveBlockEditor } from '../interactions/textSelectionMenu';
import { autocompleteSources } from '../features/links';
import { PageSearchBar } from '../features/pageSearch';
import { expandTemplates, parseVarLines, type TemplateContext } from '../features/template';
import { logOp } from '../features/logger';
import { refreshBlockBacklinkBadges } from '../blocks/blockBacklinks';
import { renderPageReferences } from '../features/pageReferences';
import { renderSupertagCollection } from '../features/supertagCollection';
import { applySupertags, normalizeTag, removeSupertags } from '../features/supertags';
import { collectBlockTags, removeTagFromText } from '../features/supertagText';
import { mountCodeEditor, parseCodeFence, type MountedCodeEditor } from '../blocks/codeBlockEdit';
import { unwatchGuideLayout, watchGuideLayout } from '../blocks/guideLayout';
import { MOUNT_FOLDER, readExternalText, writeExternalText } from '../features/extFs';
import { relativeDisplayPath } from '../features/codeFileKind';
import { setLeafTitle } from '../features/leafTitle';

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
  /** Native properties editor mounted for the page-props block (setting: pagePropsEditor = native). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nativeProps: { editor: any; path: string } | null = null;
  private nativePropsUnavailable = false;
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
    // TraceTime parity: the tracker reconciles from disk after every save —
    // refresh this page's labels shortly after (its reconcile reads async).
    this.registerEvent(
      this.app.vault.on('modify', (f) => {
        if (f instanceof TFile && f.path === this.file?.path) {
          window.setTimeout(() => this.refreshTracetimeLabels(), 700);
        }
      }),
    );
  }

  getViewType(): string {
    return VIEW_TYPE_BLOCK_EDITOR;
  }
  getDisplayText(): string {
    if (this.isExternal) return this.externalName || '外部文件';
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
    // Focusable so a MULTI-SELECTION can own the keyboard. Measured on a real
    // instance: after Ctrl+click the focused CM6 is destroyed, focus falls back
    // to <body>, and a keydown on <body> never reaches this view's container
    // listener — Tab / Shift+Tab over a selection were silently dead. Parking
    // focus on the tree element (which survives re-render, since render() only
    // empties its children) gives those keys a target inside the editor.
    // `-1` keeps it OUT of the Tab order: it is focusable programmatically only,
    // so it never becomes a stop the user has to Tab through.
    this.treeEl.tabIndex = -1;
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
    // Global shortcuts. Registered in the CAPTURE phase on purpose: the
    // focused block's CM6 lives deeper in this subtree and dispatches its
    // keymap during the bubble phase, calling preventDefault() on any match.
    // A bubble-phase listener here would therefore never see Ctrl+F / Ctrl+H /
    // Ctrl+\ (they looked "already handled" and got skipped), and CM6's own
    // Mod-a / Mod-z would shadow the Obsidian commands for the same reason.
    // Capturing first lets us decide our own keys, and — crucially — lets every
    // key we do NOT own keep travelling to Obsidian's keymap untouched.
    this.editorContainerEl.addEventListener('keydown', (ev) => this.handleGlobalKeydown(ev), true);
    attachDnd(this.treeEl, this);
    attachContextMenu(this.treeEl, this);
    this.searchBar = new PageSearchBar(this, this.editorContainerEl);
    // Live {{query}} blocks: refresh when the vault-wide index rebuilds.
    this.indexDisposer = this.plugin.blockIndex?.onRebuild(() => {
      this.refreshQueryResults();
      // Page references (linked + unlinked) + the supertag collection track
      // the index. renderPageReferences owns the whole host (it clears and
      // rebuilds it), so the collection is drawn INSIDE that host, after it.
      renderPageReferences(
        this.refsHostEl,
        this.plugin,
        this.file?.path,
        this.file?.basename ?? '',
      );
      renderSupertagCollection(this.refsHostEl, this.plugin, this.file?.path);
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

  // External-file mode --------------------------------------------------------
  //
  // A file that lives OUTSIDE the vault. Measured constraints that shape this:
  //   - `vault.adapter` anchors every path to the vault root, so reading or
  //     writing an absolute path through it fails (ENOENT on a doubled path);
  //   - a synthetic TFile is not usable: `openFile` resolves and then mounts the
  //     "empty" placeholder, because the open flow validates against the index.
  // What DOES work (measured) is registering a TextFileView subclass and letting
  // it do its own IO — a `probe-external` leaf mounted with no file at all.
  //
  // So the content flows through getViewData/setViewData exactly as for a vault
  // file, and only the two places that touch the filesystem are redirected to
  // Node fs. Everything keyed on a vault path (backlinks, page references,
  // backups, the operation log) has no meaning here and is skipped.
  /** Absolute path on disk, or '' when this view holds a normal vault file. */
  externalAbs = '';

  /** True while this view is showing a file from outside the vault. */
  get isExternal(): boolean {
    return this.externalAbs !== '';
  }

  /**
   * Point this view at an external file and show it.
   *
   * `leaf` must ALREADY be showing a block editor. A `TextFileView` only mounts
   * with a file attached (measured: setViewState on the type with no TFile gives
   * the "empty" placeholder), so the view is obtained by opening any vault file
   * first and then pushing the external content in through setViewData — the
   * identical parse/render path a vault file takes.
   *
   * Vault-only chrome is torn down here: backlinks, page references and the
   * supertag section are all keyed on an indexed path this file does not have,
   * so leaving them would show the PREVIOUS file's results under the new
   * content.
   */
  async openExternalFile(abs: string, name: string, mountPath = ''): Promise<void> {
    const data = readExternalText(abs);
    // Release the seed note's page props before retargeting, so the registry
    // entry that pointed at the borrowed file goes away with it.
    clearLogseqPageProps(this.file?.path ?? '');
    // NOTE: `this.file` cannot simply be nulled — Obsidian's TextFileView save path
    // dereferences `file.saving` (measured: "Cannot read properties of null").
    // But leaving it on the SEED note is wrong too: third-party views label
    // themselves from `view.file.basename` — the Breadcrumb Nav plugin opens its
    // renderer with `let n = e.file; ... n.basename` — so its bar kept naming
    // 第12章复现3 above an AGENTS.md (reported with a screenshot). Fixing only our
    // own breadcrumb changed nothing visible, because that plugin's stylesheet
    // hides ours (`.block-editor-breadcrumb { display: none !important; }`).
    //
    // So the field is REPLACED with a stand-in carrying the external file's name.
    // Measured: the third-party bar follows it, saving still works (twice in a
    // row), and the save lands on the real external file. Nothing writes through
    // this object — saves go to Node fs — so the vault's note is never touched.
    this.file = this.mintExternalFileHandle(name);
    this.externalAbs = abs;
    this.externalName = name;
    this.externalDisplayPath = relativeDisplayPath(abs, mountPath, name);
    // Baseline for "has this actually been edited?" — without it, merely opening
    // an outside file would rewrite it in our formatting on the first save.
    this.externalDiskData = data;
    this.externalDirty = false;
    this.teardownNativePropsEditor();
    this.setViewData(data, false);
    // A page banner that says "outside the vault" is the honest header, and it
    // replaces the vault-only sections with something true.
    this.renderExternalBanner();
    this.renderBreadcrumb();
    // Obsidian caches a leaf's tab text when the view loads, so the retargeted
    // tab keeps showing the seed note's name until the header is re-read.
    // Measured: updateHeader() fixes it; re-calling setViewState instead drops
    // the view to the "empty" placeholder, so it is not an option.
    // It is absent from obsidian's type definitions but present at runtime.
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    this.syncLeafTitle();
    this.refreshBreadcrumbPlugins();
  }

  /**
   * Ask the Breadcrumb Nav plugin to re-render, when it is installed.
   *
   * It is a third-party plugin that labels itself from `view.file`, so after a
   * retarget it has to be told to look again — it only re-renders on its own
   * triggers (file switch, heading focus), none of which happened here. Its
   * `refresh` is a public method on the instance, so this is a documented call
   * rather than a guess; if the plugin is absent or renamed, nothing happens.
   */
  private refreshBreadcrumbPlugins(): void {
    if (!this.isExternal) return;
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { refresh?: () => void }> };
    }).plugins?.plugins;
    for (const id of ['breadcrumb-nav', 'obsidian-breadcrumb-nav']) {
      const p = plugins?.[id];
      if (typeof p?.refresh === 'function') {
        try {
          p.refresh();
        } catch {
          /* a third-party failure must not block opening the file */
        }
      }
    }
  }

  /**
   * Bring a hand-created instance to life on a leaf that has no file.
   *
   * Obsidian will not mount a TextFileView without a TFile: every route through
   * openFile/setViewState yields the "empty" placeholder (measured four ways).
   * Borrowing a real note works but opens a note the user did not ask for, which
   * is exactly what they objected to.
   *
   * So the view is built here instead: `onload()` — the same DOM skeleton the
   * framework would have run — and the host shell (ExternalBlockView) appends
   * the result. Nothing in the vault is opened, read or written.
   *
   * Idempotent, so a view that is already live can be re-adopted safely.
   */
  adoptIntoView(): void {
    // Just the skeleton: the caller pushes content in straight after, and
    // rendering an empty model here would only flash.
    if (!this.editorContainerEl) this.onload();
  }

  /**
   * A TFile-shaped stand-in naming an outside file.
   *
   * Minted from the prototype of a real TFile so `instanceof` and the property
   * observers behave, and never registered with the vault: this is a label, not
   * a file. Nothing writes through it (saves go to Node fs), so it cannot damage
   * the note it was borrowed from, and `getFileCache` on its path simply returns
   * nothing — which is correct, since the file is not in the vault.
   */
  private mintExternalFileHandle(name: string): TFile {
    const base = this.app.vault.getFiles()[0];
    const proto = (base ?? ({} as TFile)) as TFile;
    const handle = Object.create(Object.getPrototypeOf(proto) as object) as TFile;
    const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
    const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
    // The path is a label under the mount folder: it is never indexed, but a
    // third-party view that groups by path will still show something sensible.
    handle.path = `${MOUNT_FOLDER}/${name}`;
    handle.name = name;
    handle.basename = stem;
    handle.extension = ext;
    Object.defineProperty(handle, 'stat', {
      value: { ctime: 0, mtime: 0, size: 0 },
      configurable: true,
    });
    Object.defineProperty(handle, 'parent', { value: null, configurable: true, writable: true });
    return handle;
  }

  /**
   * Write the file's name into the leaf's own `.view-header`.
   *
   * updateHeader() only refreshes the TAB; the in-view header keeps the seed
   * note's name, which is what made a mounted AGENTS.md sit under a heading
   * that said 第12章复现3 (reported with a screenshot). Measured and ruled out as
   * fixes: updateHeader(), workspace.updateOptions(), and a resize trigger all
   * leave it alone; only writing the element changes it.
   *
   * The write is stable rather than a one-off: the node survives a re-render and
   * a tab switch with the text intact (measured), so this does not need to be
   * repeated on every render.
   *
   * File name only — the view header now spells out the full path as
   * breadcrumbs (挂载名 / 子目录 / …), so repeating it here wrote the directory
   * twice (`挂载库/sub/sub/code.ts`).
   */
  private syncLeafTitle(): void {
    if (!this.isExternal) return;
    setLeafTitle(this.leaf, this.externalName);
  }

  /** Banner shown instead of the vault-only backlinks / references sections. */
  private renderExternalBanner(): void {
    this.refsHostEl.empty();
    // The section is also where the save button lives; with the banner off the
    // file still autosaves, so the space is simply given back to the blocks.
    if (!this.plugin.settings.externalBanner) return;
    const box = this.refsHostEl.createDiv({ cls: 'logseq-external-note' });
    box.createDiv({ cls: 'logseq-external-note-title', text: `${this.externalName}（库外文件）` });
    const path = box.createDiv({ cls: 'logseq-external-note-path', text: this.externalDisplayPath });
    path.setAttribute('title', this.externalAbs);
    box.createDiv({
      cls: 'logseq-external-note-hint',
      text: '此文件不在库内。编辑直接写回原文件，反链与块引用不适用于它。',
    });
  }

  /** File name for the tab and breadcrumb; the basename for a vault file. */
  private externalName = '';
  /** Path shown to the user: relative to the mount root. The absolute one is
   *  still on record as `externalAbs`, one hover away on the banner. */
  private externalDisplayPath = '';

  /**
   * Persist the current content.
   *
   * For a vault file this is Obsidian's own TextFileView save, reached through
   * the native debounced `requestSave` so the existing pipeline is untouched.
   * For an external one there is no index entry and no adapter path that
   * resolves, so the bytes go straight to the file the user actually has open —
   * which is also the only place they can go, since a mount never copies
   * anything into the vault.
   */
  /**
   * The outside file's bytes as last read or written, tracked separately from
   * `lastDiskData`.
   *
   * `lastDiskData` cannot serve here: `getViewData` overwrites it with the
   * serializer's output on every read, so comparing the serialization against it
   * always reports a change. The serializer also normalizes blank lines (a
   * documented choice — see the changelog entry on verbatim regions), so without
   * this baseline merely opening and closing an outside file would rewrite it in
   * our formatting.
   */
  private externalDiskData: string | null = null;
  /** Whether the MODEL changed since the file was last written. */
  private externalDirty = false;

  /**
   * Persist the current content.
   *
   * For a vault file this is Obsidian's own TextFileView save, where `force`
   * means "write even if Obsidian does not consider the file dirty".
   *
   * For an external one there is no index entry and no adapter path that
   * resolves, so the bytes go straight to the file the user actually has open —
   * the only place they can go, since a mount never copies anything into the
   * vault. `force` does NOT mean "rewrite regardless of content" there: the
   * serializer normalizes blank lines (a documented choice — see the changelog
   * entry on verbatim regions), so a forced write would silently reformat
   * outside files the user only ever opened. The comparison below is the real
   * guard, and it applies either way.
   */
  async save(force = false): Promise<void> {
    if (!this.isExternal) {
      await super.save(force);
      return;
    }
    // Nothing was edited, so nothing is written.
    //
    // The test is NOT "does the serialization differ from the file" — the
    // serializer normalizes blank lines (a documented choice, see the changelog
    // entry on verbatim regions), so a file that merely round-trips always
    // differs and a comparison on text would rewrite every outside file the user
    // opens. The question is whether the MODEL changed, and the model only moves
    // through the edit paths, which all funnel into markDirty().
    if (!this.externalDirty && !force) return;
    const data = this.serializeCurrent();
    if (data === this.externalDiskData) return;
    try {
      writeExternalText(this.externalAbs, data);
      this.externalDiskData = data;
      this.externalDirty = false;
    } catch (e) {
      new Notice(`保存失败：${String(e).slice(0, 120)}`);
    }
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
    // The native properties editor is bound to ONE file — drop it on any
    // (re)load; the next render re-mounts it against the fresh model.
    this.teardownNativePropsEditor();
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
    // An external file has no vault entry to re-read, and its content is the
    // user's own — dropping it here would blank the tab.
    if (this.isExternal) return;
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
    // An external file never comes through here — it was pushed in with
    // setViewData — so there is no vault path to read and no page references
    // to resolve. Leave the model alone.
    if (this.isExternal) {
      this.render();
      return;
    }
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
    renderSupertagCollection(this.refsHostEl, this.plugin, this.file?.path);
    // Reveal a pending block reference (opened from another file via ((id))).
    const pending = this.plugin.pendingReveal;
    if (pending && pending.path === file.path) {
      this.plugin.pendingReveal = null;
      this.revealBlock(pending.blockId);
    }
  }

  async onUnloadFile(file: import('obsidian').TFile): Promise<void> {
    this.commitFocusedText();
    this.teardownNativePropsEditor();
    // Write the outside file back before letting go of it, then clear the
    // external state: this view is about to be retargeted at a vault note, and
    // a stale externalAbs would route the next save to the wrong file.
    // Deliberately not forced: an unedited external file must not be rewritten
    // in our formatting just because the tab was closed.
    await this.save();
    const wasExternal = this.isExternal;
    this.externalAbs = '';
    this.externalName = '';
    this.externalDisplayPath = "";
    this.externalDiskData = null;
    this.externalDirty = false;
    if (wasExternal) {
      // While an outside file is shown, `this.file` is a STAND-IN carrying the
      // external name — and the framework's unload writes what getViewData()
      // returns through the vault adapter. It would try to write
      // `Mounts/<name>` (measured: "ENOENT ... Mounts/outside.md") and, worse,
      // would rewrite the file in our formatting. Detaching the stand-in first
      // leaves the base class with no file, which skips that write; the bytes
      // were already written above, or deliberately not, by our own save().
      this.file = null;
      await super.onUnloadFile(file);
      return;
    }
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
    // While an outside file is shown, the view state must not name the borrowed
    // seed note: `workspace.getActiveFile()` reads `state.file`, so leaving it
    // there makes Obsidian report a note the user never opened as "the file you
    // are editing", and the tab breadcrumb/status follow suit. Measured: this is
    // the only place that state is read from — patching the leaf's state object
    // directly has no effect, because the framework rebuilds it from here.
    if (this.isExternal && s.state) {
      const next = { ...(s.state as Record<string, unknown>) };
      delete next.file;
      s.state = next;
    }
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
      // TraceTime labels re-resolve against the tracker's current index.
      this.tracetimeCache = null;
      this.renderInner();
    } catch (e) {
      console.error('[LG] render() threw:', e);
    }
  }

  /**
   * Re-render after a setting that changes how blocks are DRAWN (fold caret,
   * hidden properties) rather than what they contain. The model is untouched,
   * so this must not go through `setViewData` — that would re-parse the file
   * and throw away the undo stack and the focused editor for nothing.
   */
  rerender(): void {
    this.commitFocusedText();
    this.render();
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
    const el = this.contentEl as HTMLElement & {
      __lgFocusPath?: string[];
      __lgFocusBlocks?: Block[];
      __lgRoots?: Block[];
      __lgTopBlocks?: Block[];
    };
    const crumbs: string[] = [];
    const chain: Block[] = [];
    // The focused block while editing; after blur keep the LAST edited
    // block's position (companion breadcrumbs must not snap back to the zoom
    // context the moment the caret leaves).
    let b = this.focusedBlock ?? this.lastEditedBlock ?? this.zoomedBlock;
    while (b) {
      const first = (b.text.split('\n')[0] ?? '').trim();
      crumbs.unshift(!first ? '·' : first.length > 24 ? first.slice(0, 24) + '…' : first);
      chain.unshift(b);
      b = b.parent;
    }
    el.__lgFocusPath = crumbs;
    // Companion breadcrumbs (breadcrumb-nav) render markdown-parity controls
    // from the LIVE block chain: clickable levels (focus that block → path
    // truncates), sibling menus, and a trailing next-level (▸) menu. Roots =
    // current zoom context; top = document-level blocks (level-0 siblings).
    el.__lgFocusBlocks = chain;
    el.__lgRoots = this.visibleRoots;
    el.__lgTopBlocks = this.doc.blocks;
    el.dispatchEvent(new CustomEvent('lgp-block-focus', { detail: { path: crumbs } }));
  }

  /** Re-render the vault-only sections replaced by the external banner. */
  renderExternalSections(): void {
    if (!this.isExternal) return;
    this.renderExternalBanner();
    this.renderBreadcrumb();
    this.syncLeafTitle();
  }

  private renderBreadcrumb(): void {
    const el = this.breadcrumbEl;
    if (!el) return;
    el.empty();
    // An external file has no vault path, so name it from the mount instead —
    // otherwise the crumb would keep showing whatever note was open before.
    // The relative form is what the user recognises; the bare name is used when
    // the file sits at the mount root.
    const label = this.isExternal
      ? this.externalDisplayPath || this.externalName
      : this.file?.basename ?? '';
    const entries = breadcrumbFor(this.doc, this.zoomedBlock, label);
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
    // inside the code). One-shot source mode keeps the raw view.
    const codeInfo = this.sourceModeBlock ? null : parseCodeFence(b.text);
    // A click on the PREFIX (image/prose ABOVE the fence) edits the block
    // TEXT — the generic editor at the click position, not the code editor.
    // staticPos was mapped from the COMPLETE static render (before any
    // swap), so it lands within the prefix exactly when the click did.
    const peek = this.pendingFocus;
    const prefixClick =
      !!codeInfo?.prefix &&
      !!peek?.clickXY &&
      peek.staticPos !== null &&
      peek.staticPos <= codeInfo.prefix.length;
    if (codeInfo && !prefixClick) {
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
      // images/rendered code — the mapping clamps the stale click Y far from
      // the user's target (often clamping to doc end, which can still sit within a
      // small deviation of the click, defeating a pure pixel check). The
      // pre-swap staticPos knows WHICH source line was clicked: when the two
      // mappings disagree on the line, the layout collapsed and staticPos is
      // the ground truth; when they agree, posAtCoords keeps its intra-line
      // (x-axis) precision.
      let p = cursorAtCoords(v, pending.clickXY.x, pending.clickXY.y, 'end');
      if (pending.staticPos !== null) {
        const pStat = Math.max(0, Math.min(pending.staticPos, v.state.doc.length));
        // Raw blocks always take the static line mapping: the rendered text
        // hides the `## `/`>` markers the editor shows, so posAtCoords skews
        // by the marker width (clicking a heading's first character landed
        // INSIDE `## ` — Enter then produced an empty-looking heading block).
        if (b.kind === 'raw' || v.state.doc.lineAt(p).number !== v.state.doc.lineAt(pStat).number) {
          p = pStat;
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
      // The click reached the static PREFIX (the code editor sits OUTSIDE
      // the cached holder, so clicks inside it never bubble here): land the
      // code edit and edit the block TEXT at the click — the generic path
      // below re-maps the click on the restored (complete) static render.
      this.commitFocusedText();
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
   *
   * Raw blocks map too — their rendered headings hide the `## `/`>` markers
   * the editor shows, so the mapping is what makes clicking a rendered
   * heading land on the right source line at all.
   */
  private staticClickPos(b: Block, y: number): number | null {
    const wrap = findBlockEl(b);
    const holder = wrap?.querySelector(':scope > .block-main > .block-content > .block-content-static') as HTMLElement | null;
    if (!holder || !holder.children.length) return null;
    const lines = b.text.split('\n');
    if (lines.length <= 1 && b.kind !== 'raw') return null;
    // Line-run per top-level child: fences swallow their whole run; headings
    // one line; everything else consumes up to the next fence/heading.
    const runs: Array<[number, number]> = [];
    let li = 0;
    for (let ci = 0; ci < holder.children.length && li < lines.length; ci++) {
      const child = holder.children[ci] as HTMLElement;
      const tag = child.tagName;
      // The rendered code block is a div.lgp-code-block wrapping the <pre>
      // (toolbar swap) — both count as the fence's render.
      const isPreEl = tag === 'PRE' || child.classList.contains('lgp-code-block');
      const isFence = /^\s*(```|~~~)/.test(lines[li] ?? '');
      let j = li;
      // Run start may move past blank lines (a rendered <pre> in a raw block
      // sits behind its verbatim blank lines) — gap clicks then fall to the
      // previous child, code clicks land ON the fence line.
      let start = li;
      if (isFence) {
        j++;
        while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j])) j++;
        if (j < lines.length) j++;
      } else if (isPreEl) {
        let k = li;
        while (k < lines.length && lines[k].trim() === '') k++;
        if (/^\s*(```|~~~)/.test(lines[k] ?? '')) {
          start = k;
          k++;
          while (k < lines.length && !/^\s*(```|~~~)/.test(lines[k])) k++;
          if (k < lines.length) k++;
          j = k;
        } else {
          j = li + 1;
        }
      } else if (/^H[1-6]$/.test(tag)) {
        // Raw blobs keep blank lines verbatim — a rendered heading maps to
        // its OWN line (skipping the blanks), so the caret lands on the
        // heading line, not on the gap above it.
        let k = li;
        while (k < lines.length && lines[k].trim() === '') k++;
        start = k;
        j = k + 1;
      } else {
        while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j]) && !/^#{1,6}\s/.test(lines[j])) j++;
        if (j === li) j = li + 1;
      }
      runs.push([start, Math.min(j - 1, lines.length - 1)]);
      li = Math.max(j, start);
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
    if (isPagePropsBlock(b) && this.doc.blocks[0] === b && this.file) registerLogseqPageProps(this.file.path, b.props);
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

  /** Keep the Logseq-page-props registry fresh for other plugins. */
  private syncPagePropsRegistry(): void {
    const path = this.file?.path;
    if (!path) return;
    registerLogseqPageProps(path, docPageProps(this.doc));
  }

  // ------------------------------------------------------------------
  // TraceTime parity (block last-edited labels)
  // ------------------------------------------------------------------

  private tracetimeCache: TraceTimeIndex | null = null;
  private tracetimeFp = '';
  private tracetimeEnsured: string | null = null;
  private tracetimeRetries = 0;
  private tracetimeRetryPending = false;

  /** minutes-since-epoch the TraceTime plugin recorded for `b`, or null. */
  tracetimeModifiedAt(b: Block): number | null {
    const p = traceTimePluginOf(this.app);
    if (!p || !this.file) return null;
    let st: TraceTimeState | undefined;
    try {
      st = p.tracker?.getState?.(this.file.path);
    } catch {
      return null;
    }
    if (!st) {
      // The tracker only keeps files it saw in native markdown views and
      // evicts them on layout-change — ask it to track ours; the bounded
      // retry below re-walks the rows once its async open lands. NEVER call
      // refreshTracetimeLabels() synchronously from here: the walk re-enters
      // this method per row and would recurse until the stack overflows.
      this.ensureTracetimeTracking();
      return null;
    }
    // Fingerprint the state: after a save, their reconcile mutates the SAME
    // state object (entry timestamps move, text grows) — rebuild the cache
    // whenever anything in it changed.
    const blocks = st.index.blocks;
    let sum = 0;
    for (const b of blocks) sum += b.modifiedAt;
    const fp = `${st.text.length}:${blocks.length}:${sum}`;
    if (!this.tracetimeCache || fp !== this.tracetimeFp) {
      this.tracetimeFp = fp;
      this.tracetimeCache = buildTraceTimeIndex(st);
    }
    if (!this.tracetimeCache) return null;
    return traceTimeModifiedAt(this.tracetimeCache, b);
  }

  /** TraceTime's own relative/absolute formatting for a recorded time. */
  tracetimeFormat(minutes: number): string {
    const p = traceTimePluginOf(this.app);
    return p ? formatTraceTimestamp(minutes, p.settings) : '';
  }

  /** TraceTime's label vertical alignment preference ('start' | 'middle' | 'end'). */
  tracetimeVertical(): string {
    const p = traceTimePluginOf(this.app);
    const v = p?.settings?.['labelVertical'];
    return v === 'start' || v === 'end' ? v : 'middle';
  }

  /**
   * Make TraceTime track this file (idempotent) and re-walk the rows on a
   * timer until its state sticks — bounded, timer-separated (no recursion
   * through the render walk).
   */
  private ensureTracetimeTracking(): void {
    if (!this.file) return;
    if (this.tracetimeEnsured !== this.file.path) {
      this.tracetimeEnsured = this.file.path;
      try {
        traceTimePluginOf(this.app)?.tracker?.ensureFile?.(this.file.path);
      } catch {
        /* plugin API drift */
      }
    }
    if (this.tracetimeRetryPending || this.tracetimeRetries >= 10) return;
    this.tracetimeRetryPending = true;
    this.tracetimeRetries++;
    window.setTimeout(() => {
      this.tracetimeRetryPending = false;
      const p = traceTimePluginOf(this.app);
      if (!p || !this.file) return;
      try {
        p.tracker?.ensureFile?.(this.file.path);
      } catch {
        /* plugin API drift */
      }
      // One walk: rows pick up labels when the state exists; while it is
      // still missing each row re-enters ensureTracetimeTracking, which
      // schedules exactly one more pass.
      refreshTracetimeLabels(this);
    }, 800);
  }

  refreshTracetimeLabels(): void {
    refreshTracetimeLabels(this);
    const p = traceTimePluginOf(this.app);
    const st = p && this.file ? p.tracker?.getState?.(this.file.path) : true;
    if (!st) this.ensureTracetimeTracking();
    else this.tracetimeRetries = 0;
  }

  // ------------------------------------------------------------------
  // Native properties editor (setting: pagePropsEditor = 'native')
  // ------------------------------------------------------------------

  /**
   * Mount Obsidian's NATIVE properties editor (the `.metadata-container`
   * component the native markdown view renders above its content) in place of
   * the page-props block's Logseq `key:: value` content. Because the real
   * component is used, every property plugin that extends the native
   * properties UI (custom property type widgets, menus, suggestions) works
   * here too. Returns false — rendering nothing — when the component class is
   * not (yet) resolvable; the caller falls back to the Logseq rendering and
   * the block is re-rendered once the class arrives.
   */
  nativePropsEditorFor(content: HTMLElement, b: Block): boolean {
    if (!this.file) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = this.plugin.nativePropsCtor as (new (app: unknown, owner: unknown) => any) | null;
    if (!Ctor) {
      if (this.nativePropsUnavailable) return false;
      // Resolve once in the background, then re-render this block with the editor.
      void this.plugin.resolveNativePropsCtor().then((resolved) => {
        if (!resolved) this.nativePropsUnavailable = true;
        if (this.doc.blocks[0] === b) patchBlockSubtree(b, this);
      });
      return false;
    }
    if (!this.nativeProps || this.nativeProps.path !== this.file.path) {
      this.teardownNativePropsEditor();
      const owner = {
        app: this.app,
        getFile: () => this.file ?? null,
        // The native owner writes the record through its own editor; here the
        // record round-trips into the page's OWN format (Logseq lines or
        // frontmatter) through the block model + the debounced save.
        saveFrontmatter: (record: Record<string, unknown>) => this.saveNativePropsRecord(record),
        shiftFocusBefore: () => {},
        shiftFocusAfter: () => {},
        onMarkdownFold: () => {},
        getHoverSource: () => null,
      };
      const editor = new Ctor(this.app, owner);
      editor.load?.();
      this.nativeProps = { editor, path: this.file.path };
    }
    content.appendChild(this.nativeProps.editor.containerEl);
    this.nativeProps.editor.synchronize(nativePropsRecordOf(b));
    return true;
  }

  private teardownNativePropsEditor(): void {
    if (!this.nativeProps) return;
    try {
      this.nativeProps.editor.unload?.();
    } catch {
      /* component may never have been loaded */
    }
    this.nativeProps.editor.containerEl.remove();
    this.nativeProps = null;
  }

  /**
   * Native properties editor save: write the record back through the block
   * model in the page's own format — file-top `key:: value` lines for
   * Logseq-format pages, frontmatter for Obsidian-format ones — and let the
   * debounced save put it on disk (registry + metadata cache follow).
   */
  private saveNativePropsRecord(record: Record<string, unknown>): void {
    const b = this.doc.blocks[0];
    // The page-props block: an empty-text props block (Logseq format) or the
    // frontmatter block (its text is the YAML body).
    if (!b || !(b.kind === 'list' && (b.text === '' || b.frontmatter === true))) return;
    if (Object.keys(record).length === 0) {
      // Every property was deleted: the props block goes away with them.
      this.teardownNativePropsEditor();
      this.doc.blocks.shift();
      this.markDirty();
      this.render();
      return;
    }
    if (b.frontmatter) {
      b.text = stringifyYaml(record).replace(/\n+$/, '');
      syncFrontmatterProps(b);
    } else {
      const props: Record<string, string> = {};
      for (const [k, v] of Object.entries(record)) props[k] = nativePropValueToString(v);
      b.props = props;
      if (this.file) registerLogseqPageProps(this.file.path, props);
    }
    this.markDirty();
  }

  /** Keep the Logseq-page-props registry fresh for other plugins. */

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

  /**
   * Insert a whole top-level block (a ```prolog query fence, typically). Raw
   * blocks only exist at the top level — nested inside a bullet the serializer
   * would indent the fence and the query would stop being a query.
   */
  insertTopLevelBlock(text: string, kind: 'list' | 'raw' = 'list'): Block {
    const nb: Block = { kind, marker: null, text, props: {}, children: [], parent: null };
    this.mutate(() => {
      let anchor = this.focusedBlock;
      while (anchor?.parent) anchor = anchor.parent;
      const at = anchor ? this.doc.blocks.indexOf(anchor) : -1;
      if (at >= 0) this.doc.blocks.splice(at + 1, 0, nb);
      else this.doc.blocks.push(nb);
    });
    return nb;
  }

  toggleCollapse(b: Block): void {
    this.mutate(
      () => toggleCollapse(b),
      () => ({ subtree: b }),
    );
  }

  /** Whether the collapse caret is offered on every foldable body (setting). */
  get foldEnabled(): boolean {
    return this.plugin.settings.foldEnabled !== false;
  }

  /**
   * Fold or unfold a block by writing the `collapsed` property.
   *
   * The flag is the ONLY state: markdown stays the single source of truth, so
   * folding survives a reload and shows up in the SQLite index like any other
   * property. `collapsed:: true` folds to a one-line summary, `collapsed:: full`
   * to a terse type marker; `none` removes the property entirely rather than
   * writing `false`, so an unfolded block's file is byte-identical to one that
   * was never folded.
   */
  setFold(b: Block, level: FoldLevel): void {
    const value = foldValueFor(level);
    const current = foldLevelOf(b.props);
    if (current === level) return;
    this.mutate(
      () => {
        if (value === null) {
          // Drop the property under every spelling of the key.
          for (const k of Object.keys(b.props)) {
            if (normFoldKey(k) === 'collapsed') delete b.props[k];
          }
        } else {
          for (const k of Object.keys(b.props)) {
            if (normFoldKey(k) === 'collapsed') delete b.props[k];
          }
          b.props['collapsed'] = value;
        }
        // A folded block must not stay in the edit state: its editor would
        // render over the summary. Unfocus it so the summary takes over.
        if (level !== 'none' && this.focusedBlock === b) this.commitFocusedText();
      },
      // A FULL re-render, not `{ subtree: b }`: folding a HEADING hides the
      // following siblings it introduces, which are outside the block's own
      // subtree. A subtree patch would rewrite the heading and leave its
      // section on screen (measured: the flag landed in the file but the rows
      // stayed).
      () => ({ full: true }),
    );
    // The full re-render replaces the tree's children, so the caret that was
    // just clicked is gone. Re-assert focus on the tree, or the second click
    // (to expand) would land nowhere — the same failure the bulk-indent path
    // hit, for the same reason.
    this.focusTreeForSelection();
  }

  /** Caret click: a plain click toggles just this block. */
  cycleFold(b: Block): void {
    this.setFold(b, nextFoldLevel(foldLevelOf(b.props), false));
  }

  /**
   * Alt+click: fold (or unfold) EVERY descendant — SiYuan's
   * `toggleListFold(protyle, el, "children")`, which marks each child that has
   * children of its own and skips the childless ones (there is nothing to
   * collapse there, and marking one would replace its text with a summary the
   * user never asked for).
   *
   * Toggles on the FIRST descendant that disagrees, so a second Alt+click
   * opens everything back up regardless of the current state.
   */
  foldSubtree(b: Block): void {
    const targets = subtreeFoldTargets(b);
    if (targets.length === 0) {
      // No collapsible descendants: fall back to folding this block, so the
      // gesture is never a dead click.
      this.cycleFold(b);
      return;
    }
    const opening = targets.some((t) => foldLevelOf(t.props) === 'none');
    this.mutate(
      () => {
        for (const t of targets) setCollapsed(t, opening);
      },
      () => ({ full: true }),
    );
    this.focusTreeForSelection();
  }

  /** Guide-line click: folds/unfolds the content INSIDE the guide (the
   *  clicked block itself is not folded). Depths come from the settings
   *  (`guideLineCollapseLevels` / `guideLineExpandLevels`, 0 = all levels). */
  toggleCollapseGuide(b: Block): void {
    // Guide-line toggle (user spec): NOT fully folded → click folds the whole
    // subtree; FULLY folded → click expands the whole subtree. Both actions
    // are all-levels regardless of the fold-depth settings — with a depth-1
    // setting the state test and the action magnitudes dead-ended each other
    // (fold 1 → still not fully folded → fold 1 was a no-op: the line stuck).
    const expanding = isSubtreeFullyFolded(b);
    this.mutate(
      () => {
        if (expanding) {
          if (isCollapsed(b)) setCollapsed(b, false); // stub click on a folded block
          expandLevels(b, 0);
        } else {
          collapseLevels(b, 0);
        }
      },
      () => ({ subtree: b }),
    );
  }

  // ------------------------------------------------------------------
  // Multi-selection
  // ------------------------------------------------------------------

  /**
   * The range anchor to use for the Shift+click now being processed.
   *
   * Captured on mousedown, NOT read inside the click handler: mousedown moves
   * focus off the block being edited, CM6 fires blur, and the blur-commit
   * (`commitFocusedText`) sets `focusedBlock = null` — all before the click
   * event bubbles to the block's handler. Measured with an e2e probe that
   * wrapped `selectFromClick` and logged `this.focusedBlock` at entry: it was
   * already null, which is why editing a block and Shift+clicking another one
   * silently selected only the clicked block.
   */
  private pendingRangeAnchor: Block | null = null;

  /** mousedown on block content: stash the anchor before focus can move. */
  captureRangeAnchor(ev: MouseEvent): void {
    this.pendingRangeAnchor = ev.shiftKey
      ? rangeAnchor(this.visibleRoots, this.lastClicked, this.focusedBlock)
      : null;
  }

  /** Shift/Ctrl+click on a block: plain = single select, ctrl = toggle,
   *shift = range from the anchor (last clicked, else the block being edited). */
  selectFromClick(b: Block, ev: MouseEvent): void {
    // The anchor was stashed at mousedown time — `commitFocusedText()` below
    // destroys the focused CM6 and nulls focusedBlock, and the blur-commit
    // that fires on mousedown has usually nulled it even earlier.
    const anchor = ev.shiftKey
      ? this.pendingRangeAnchor ?? rangeAnchor(this.visibleRoots, this.lastClicked, this.focusedBlock)
      : null;
    this.pendingRangeAnchor = null;
    this.commitFocusedText();
    if (ev.shiftKey && anchor) {
      const range = visibleRange(this.visibleRoots, anchor, b);
      if (range) {
        this.selectedBlocks.clear();
        for (const member of range) this.selectedBlocks.add(member);
        this.syncSelectionClasses();
        this.focusTreeForSelection();
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
    // Ctrl+click empties the selection (last one deselected) — nothing owns the
    // keyboard then, so release the tree instead of leaving focus parked.
    if (this.selectedBlocks.size > 0) this.focusTreeForSelection();
    else this.treeEl?.blur();
  }

  clearSelection(): void {
    if (this.selectedBlocks.size === 0) return;
    this.selectedBlocks.clear();
    this.lastClicked = null;
    this.syncSelectionClasses();
    // Nothing owns the keyboard once the selection is gone — hand focus back
    // so Tab returns to Obsidian's own focus traversal.
    this.treeEl?.blur();
  }

  /** Update .is-selected classes in place (no re-render). */
  syncSelectionClasses(): void {
    for (const [b, wrap] of this.selectionElIterator()) {
      wrap.classList.toggle('is-selected', this.selectedBlocks.has(b));
    }
  }

  /**
   * Park keyboard focus on the tree so the selection owns Tab / Shift+Tab.
   *
   * Selecting blocks destroys the focused CM6 (see `selectFromClick`), and the
   * browser then drops focus on <body> — a keydown there never reaches this
   * view's container listener, so the bulk-indent shortcut could not fire. The
   * tree element is the focusable target inside the editor, and because
   * `render()` only empties its children, focus survives the re-render that
   * `indentSelected` triggers (so repeated Tab presses keep working).
   */
  private focusTreeForSelection(): void {
    if (!this.treeEl) return;
    this.treeEl.focus({ preventScroll: true });
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
    // The patch above forces a full re-render, so the selection's keyboard
    // focus has to be re-asserted — otherwise the SECOND Tab (and every one
    // after it) goes nowhere and the shortcut looks like it worked only once.
    this.focusTreeForSelection();
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
    this.dropBlocks([dragged], target, pos);
  }

  /**
   * Move a whole payload (multi-selection drag) into a target position.
   *
   * Delegates to `moveBlockGroup`, NOT a loop over `moveBlock`: each
   * `moveBlock` inserts directly adjacent to the target, so the next member
   * pushes the previous one further out — dropping [a, b] after `c` would
   * yield [c, b, a], exactly reversed. `moveBlockGroup` also drops members
   * that travel inside another member, and refuses the whole group when any
   * member is illegal.
   */
  dropBlocks(blocks: readonly Block[], target: Block, pos: MovePosition): void {
    // EVERY member's original parent, not just the first one's: a multi-select
    // can span levels (`a` plus a child buried under `b`), and each of those
    // lists lost a row. Capturing only `blocks[0].parent` left the other
    // member's old position rendered forever — a ghost row of a block that had
    // already moved.
    const oldParents = dedupeParents(blocks.map((b) => b.parent));
    let moved: Block[] = [];
    this.mutate(
      () => {
        moved = moveBlockGroup(blocks, target, pos);
      },
      // Rebuild the source and destination sibling lists.
      () => ({
        lists: dedupeParents([...oldParents, ...moved.map((b) => b.parent), target.parent]),
      }),
    );
  }

  /**
   * Detach blocks from this document without re-inserting them (the drop half
   * of a cross-file move writes them to another file).
   *
   * Innermost first, and skipping any block that another member already
   * carries: removing a parent first would leave the child's `parent` pointing
   * at a block that is no longer in the document, and the block list rebuilt
   * afterwards would miss the sub-tree entirely.
   */
  dropBlocksToNowhere(blocks: readonly Block[]): void {
    const payload = blocks.filter(Boolean);
    if (payload.length === 0) return;
    const ordered = [...payload]
      .filter((b) => !payload.some((o) => o !== b && isDescendant(o, b)))
      .sort((a, b) => blockDepth(b) - blockDepth(a));
    if (ordered.length === 0) return;
    const parents = dedupeParents(ordered.map((b) => b.parent));
    this.mutate(
      () => {
        for (const b of ordered) removeBlock(b);
      },
      () => ({ lists: parents }),
    );
  }

  /**
   * Another view moved blocks that used to live in this document (cross-view
   * drop). The block objects were already re-parented by the destination view,
   * so this only has to do what that view cannot: push an undo entry, mark the
   * file dirty so it actually re-saves (otherwise the block stays on disk and
   * the "move" is a duplicate), and rebuild the source sibling lists.
   *
   * `sourceLists` must be captured BEFORE the move — afterwards every block's
   * `parent` points into the destination document.
   */
  adoptBlocksMovedAway(sourceLists: (Block | null)[]): void {
    if (sourceLists.length === 0) return;
    this.mutate(
      () => undefined,
      () => ({ lists: dedupeParents(sourceLists) }),
    );
  }

  /**
   * Append already-parsed blocks to the end of this document.
   *
   * Used by a cross-file drop whose destination is this open note: the blocks
   * arrive parsed, so they join the live model (undoable, re-rendered) rather
   * than being written to the file behind the view's back — which would race
   * `onExternalModify`, whose "editor always wins" policy would then discard
   * them.
   */
  appendBlocksAtEnd(blocks: Block[]): void {
    if (blocks.length === 0) return;
    // Skip blocks another one already contains — they arrive nested.
    const tops = blocks.filter((b) => !blocks.some((o) => o !== b && isDescendant(o, b)));
    if (tops.length === 0) return;
    this.mutate(
      () => {
        for (const b of tops) {
          b.parent = null;
          this.doc.blocks.push(b);
        }
      },
      () => ({ lists: [null] }),
    );
  }

  /** The block-tree root, for handlers that need to reach another view's DOM. */
  treeRoot(): HTMLElement {
    return this.treeEl;
  }

  // ------------------------------------------------------------------
  // Links / navigation
  // ------------------------------------------------------------------

  openLink(linktext: string): void {
    this.app.workspace.openLinkText(linktext, this.file?.path ?? '', false);
  }

  /**
   * Scroll to a block and flash-highlight it, WITHOUT entering edit mode.
   * Used by ((ref)) navigation (block id), the outline/search jumps and
   * breadcrumb clicks (Block object — most blocks carry no id). Navigation
   * must never force the editor open (focusBlock both edits and never
   * scrolls — the breadcrumb "click twice, nothing scrolls" report).
   */
  revealBlock(target: string | Block): void {
    const b = typeof target === 'string' ? findBlockById(this.doc.blocks, target) : target;
    if (!b) return;
    this.makeBlockRenderable(b);
    this.ensureCapFor(b);
    this.render();
    this.scrollBlockTopIntoView(b);
    const el = findBlockEl(b);
    if (!el) return;
    el.addClass('block-revealed');
    window.setTimeout(() => el.removeClass('block-revealed'), 1600);
    // The sync render leaves async static content (markdown, images) still
    // growing — re-land once it settles or a beyond-cap target drifts away
    // (the "second click finally scrolls" symptom).
    window.setTimeout(() => this.scrollBlockTopIntoView(b), 350);
  }

  /**
   * Scroll the scroller so `b`'s wrap top sits just below the sticky breadcrumb
   * bar. scrollIntoView(block:'center') centers the ELEMENT — a block whose
   * subtree wrap is thousands of px tall would land its TOP far above the
   * viewport, leaving the focused editor invisible (the breadcrumb-jump bug).
   */
  private scrollBlockTopIntoView(b: Block): void {
    const el = findBlockEl(b);
    if (!el) return;
    const sc = el.closest('.block-editor-scroller') ?? this.contentEl;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = top - 48;
  }

  /** Uncollapse ancestors and leave zoom so `b` can render. A collapsed
   *  ancestor hides `b` from flattenVisible, so ensureCapFor would never grow
   *  the cap for it and focusBlock would silently do nothing visible. */
  private makeBlockRenderable(b: Block): void {
    let p = b.parent;
    while (p) {
      setCollapsed(p, false);
      p = p.parent;
    }
    if (this.zoomedBlock && !isDescendant(this.zoomedBlock, b)) {
      this.zoomedBlock = null;
      this.render();
    }
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
    if (!b) return;
    let nb: Block | null = null;
    const parent = b.parent;
    this.mutate(
      () => {
        // Raw blocks convert to outline blocks (same as the Enter key).
        nb = b.kind === 'raw' ? splitRawToOutline(b, b.text.length) : splitBlock(b, b.text.length);
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

  // Supertags (Tana supertags / Logseq DB new tags)
  // ------------------------------------------------------------------

  /**
   * Add `tag` to the focused block and materialize its inherited field
   * template. Never overwrites an existing property value.
   * Returns false when there is no focused block or nothing to do.
   */
  applySupertag(tag: string): boolean {
    const b = this.focusedBlock;
    const reg = this.plugin.blockIndex?.supertagRegistry();
    if (!b || !reg) return false;
    const t = normalizeTag(tag);
    if (!reg.has(t)) return false; // a plain tag has no template
    if (collectBlockTags(b.text).includes(t)) return false;

    // 1. the tag itself goes into the block TEXT (so it round-trips as markdown)
    const withTag = b.text.trimEnd().length > 0 ? `${b.text.trimEnd()} #${t}` : `#${t}`;
    // 2. the template materializes as `key:: value` props
    const nextProps = applySupertags(b.props, reg, [...collectBlockTags(withTag), t]);
    this.mutate(
      () => {
        b.text = withTag;
        if (nextProps) b.props = nextProps;
      },
      () => ({ lists: [b.parent ?? b] }),
    );
    return true;
  }

  /**
   * Remove `tag` from the focused block and retract the fields it contributed
   * (values the user filled in are kept). Returns false when nothing changed.
   */
  removeSupertag(tag: string): boolean {
    const b = this.focusedBlock;
    const reg = this.plugin.blockIndex?.supertagRegistry();
    if (!b || !reg) return false;
    const t = normalizeTag(tag);
    const before = collectBlockTags(b.text);
    if (!before.includes(t)) return false;

    const after = before.filter((x) => x !== t);
    const text = removeTagFromText(b.text, t);
    const nextProps = removeSupertags(b.props, reg, [t], after);
    this.mutate(
      () => {
        b.text = text;
        if (nextProps) b.props = nextProps;
      },
      () => ({ lists: [b.parent ?? b] }),
    );
    return true;
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

  /**
   * Global DOM keydown — ONLY for keys that cannot be reached any other way.
   *
   * Find / replace / collapse-all are NOT handled here: they are declared as
   * `hotkeys` on real Obsidian commands, because Obsidian's keymap consumes
   * the key event on `window` in the capture phase and a container-level
   * listener never sees it. See `src/interactions/hotkeys.ts`.
   */
  private handleGlobalKeydown(ev: KeyboardEvent): void {
    // Escape exits multi-selection first. While a block or an embed row is
    // being edited we must NOT touch it: those editors install their own
    // capture handler on their own DOM (commit on Escape) which runs AFTER
    // ours (we are on an ancestor), so preventing the default here would drop
    // whatever the user just typed.
    const editing = !!(this.focusedView || this.focusedCode || this.embedEdit);
    if (ev.key === 'Escape' && this.selectedBlocks.size > 0 && !editing) {
      ev.preventDefault();
      this.clearSelection();
      return;
    }
    const action = classifyGlobalKey(ev.key, modifiersOf(ev), {
      hasSelection: this.selectedBlocks.size > 0,
      editing,
      shortcuts: this.plugin.settings.shortcuts,
    });
    // `none` = not ours. Leave the event completely untouched so Obsidian's
    // keymap (and therefore the user's own bindings) can handle it. Calling
    // preventDefault here is what used to kill every global shortcut.
    if (action.kind === 'none') return;
    ev.preventDefault();
    switch (action.kind) {
      case 'bulk':
        if (action.op === 'select-all') {
          this.selectedBlocks = new Set(flattenVisible(this.visibleRoots));
          this.syncSelectionClasses();
          // Same reason as the click path: an empty selection owns no keyboard.
          this.focusTreeForSelection();
        } else if (action.op === 'duplicate') {
          this.duplicateSelected();
        } else {
          void this.copySelectedAsMarkdown(); // cut = copy + delete
          if (action.op === 'cut') this.deleteSelected();
        }
        break;
      case 'undo':
        this.undoRestore();
        break;
      case 'redo':
        this.redoRestore();
        break;
      case 'indent-selection':
        this.indentSelected(action.shift);
        break;
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
    // While an outside file is shown, the borrowed seed note is NOT what is being
    // edited. Logging the edit against it, and snapshotting the seed as a
    // "backup", would both misattribute the change and litter the vault with a
    // copy of a note the user never touched. The external save path writes to
    // the real file directly and logs under its own operation.
    if (!this.isExternal) {
      logOp(this.plugin, 'blocks.edit', this.file?.path ?? '', 'ok');
      const f = this.file;
      if (f) void this.plugin.backups.ensureSessionBackup(f);
    } else {
      // The only signal that separates "the user typed" from "the file merely
      // round-trips" — every edit funnels through here.
      this.externalDirty = true;
    }
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

/** The record the native properties editor shows for the page-props block. */
function nativePropsRecordOf(b: Block): Record<string, unknown> {
  if (b.frontmatter) {
    try {
      const parsed = parseYaml(b.text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* invalid YAML: the editor shows its own error state for an empty record */
    }
    return {};
  }
  const record: Record<string, unknown> = { ...b.props };
  // Obsidian's list-type properties (tags/aliases/cssclasses) render as
  // multi-value editors expecting an ARRAY — a comma-separated Logseq value
  // fed as one string renders as a single "disallowed tag name" invalid pill.
  for (const k of ['tags', 'aliases', 'cssclasses', 'cssclass']) {
    const v = record[k];
    if (typeof v === 'string' && /[，,]/.test(v)) {
      record[k] = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return record;
}

/** Native property values (string | string[] | number | boolean | null) → the Logseq `key:: value` string form. */
function nativePropValueToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(nativePropValueToString).join(', ');
  return typeof v === 'string' ? v : String(v);
}

/** Nesting depth of a block (roots = 0). Used to order a drag payload. */
function blockDepth(b: Block): number {
  let d = 0;
  let p = b.parent;
  while (p) {
    d++;
    p = p.parent;
  }
  return d;
}

/** Distinct sibling-list owners, in first-seen order (null = root list). */
function dedupeParents(parents: (Block | null)[]): (Block | null)[] {
  const seen = new Set<Block | null>();
  const out: (Block | null)[] = [];
  for (const p of parents) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
