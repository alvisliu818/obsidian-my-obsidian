/**
 * A sidebar-hostable shell that runs the Logseq block editor on a file OUTSIDE
 * the vault.
 *
 * Why this exists, and why it is an ItemView:
 *
 * `BlockEditorView` is a `TextFileView`, and a TextFileView will not mount
 * without a TFile — measured four ways, every route through `openFile` /
 * `setViewState` produces the "empty" placeholder. So a mounted block editor for
 * an outside file required borrowing a real note and retargeting it, which is
 * what put 第12章 on screen for half a second when you opened something else
 * (measured: `openFile` takes ~511 ms, and the seed is genuinely painted in that
 * window). The code editor never had this problem for the obvious reason: it is
 * an ItemView, and an ItemView mounts with no file at all.
 *
 * So this is an ItemView — the framework mounts it with `setViewState` and
 * nothing in the vault is opened — and the real block editor is hosted inside
 * it. Measured to work: 150 blocks rendered, the container gets real height
 * (700 px), and the shell contains only its own view-header/view-content with
 * no leftover placeholder.
 *
 * What the shell does NOT bring: backlinks, page references, the block index
 * search bar, or ((block references)) resolution — all of those are keyed on a
 * vault path, and the whole point is that this file has none. It says so in a
 * banner rather than showing the previous note's results.
 */

import { ItemView, Notice, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { BlockEditorView } from '../view/BlockEditorView';
import type { MountNode } from '../features/mountFilter';
import { applyHeaderPath, headerPathSegments } from './headerPath';

export const VIEW_TYPE_EXTERNAL_BLOCK = 'logseq-external-block';

/** What the shell remembers so it can reopen the same file. */
export interface ExternalBlockViewState {
  abs: string;
  name: string;
  rel?: string;
  /** 挂载名——视图头部路径的第一段（「挂载名 / 子目录 / 文件名」） */
  mountLabel?: string;
  mountPath?: string;
}

export class ExternalBlockView extends ItemView {
  plugin: LogseqEditorPlugin;
  abs = '';
  fileName = '';
  /** Path relative to the mount root — what the header shows. */
  rel = '';
  /** 挂载名与挂载根：视图头部路径的起始段。 */
  mountLabel = '';
  mountPath = '';
  /** The hosted block editor. */
  private inner: BlockEditorView | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_EXTERNAL_BLOCK;
  }

  getDisplayText(): string {
    return this.fileName || '外部笔记';
  }

  getIcon(): string {
    return 'file-text';
  }

  getState(): Record<string, unknown> {
    return {
      abs: this.abs,
      name: this.fileName,
      rel: this.rel,
      mountLabel: this.mountLabel,
      mountPath: this.mountPath,
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as Partial<ExternalBlockViewState>;
    if (typeof s.abs === 'string') this.abs = s.abs;
    if (typeof s.name === 'string') this.fileName = s.name;
    if (typeof s.rel === 'string') this.rel = s.rel;
    if (typeof s.mountLabel === 'string') this.mountLabel = s.mountLabel;
    if (typeof s.mountPath === 'string') this.mountPath = s.mountPath;
    await super.setState(state, result);
    // Mounting waits for the state: Obsidian calls onOpen BEFORE setState, so the
    // path and name are not known yet at onOpen time.
    if (this.abs && !this.inner) this.hostBlockEditor();
    this.syncHeaderPath();
  }

  async onOpen(): Promise<void> {
    if (this.abs) this.hostBlockEditor();
    this.syncHeaderPath();
  }

  // ------------------------------------------------------------------
  // view-header 的完整路径（挂载名 / 子目录 / …，文件名是标题本身）
  // ------------------------------------------------------------------

  /**
   * 库外文件不在库里，Obsidian 不给自定义视图生成目录链，标签页下面于是只剩
   * 一个文件名。这里按原生 FileView 的 DOM 结构补上完整路径。
   */
  syncHeaderPath(): void {
    if (!this.abs) return;
    const rel = this.rel || this.relFromMount();
    const label = this.mountLabel || this.mountLabelFromSettings();
    const segments = headerPathSegments(this.abs, rel, label);
    if (segments.length) segments[0].isMount = true;
    applyHeaderPath(this.containerEl, segments, this.plugin);
  }

  /** 没有 rel（老 state 恢复的标签页）时，用挂载根现算一个相对路径。 */
  private relFromMount(): string {
    const root = (this.mountPath || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const full = this.abs.replace(/\\/g, '/');
    if (root && full.toLowerCase().startsWith(root + '/')) return full.slice(root.length + 1);
    return this.fileName;
  }

  /** 老 state 没有挂载名时，按最长前缀匹配在挂载配置里找回来。 */
  private mountLabelFromSettings(): string {
    const mounts = this.plugin.settings.externalMounts ?? [];
    const full = this.abs.replace(/\\/g, '/').toLowerCase();
    let best = '';
    let bestLen = -1;
    for (const m of mounts) {
      const root = String(m.path ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
      if (!root || !full.startsWith(root + '/')) continue;
      if (root.length > bestLen) {
        bestLen = root.length;
        best = m.label || '';
      }
    }
    return best;
  }

  async onClose(): Promise<void> {
    // The hosted view is not owned by the framework, so its teardown is ours:
    // save the outside file and release the editor.
    const inner = this.inner;
    this.inner = null;
    if (!inner) return;
    try {
      await inner.save();
    } catch {
      /* a failed save on close must not block the tab closing */
    }
    try {
      inner.onunload();
    } catch {
      /* already torn down */
    }
    inner.containerEl?.detach?.();
  }

  // ------------------------------------------------------------------

  /**
   * Build a block editor and put it inside this shell.
   *
   * The editor is constructed rather than opened: it is a TextFileView, so the
   * framework will not mount one without a file, and asking it to would mean
   * opening a vault note — the thing this design exists to avoid. Constructing
   * gives an editor whose content is driven entirely by us, and the shell is
   * what the framework mounts.
   */
  private hostBlockEditor(): void {
    if (this.inner) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-external-block-view');

    const inner = new BlockEditorView(this.leaf, this.plugin);
    this.inner = inner;
    // Build the editor's DOM skeleton (the same one onload() builds) and adopt
    // the outside file's content into it.
    inner.adoptIntoView();
    const host = contentEl.createDiv({ cls: 'logseq-external-block-host' });
    const innerEl = (inner.containerEl as unknown as HTMLElement[] | undefined)?.[0] ?? inner.containerEl;
    if (innerEl) host.appendChild(innerEl);

    void this.pushContent(inner);
  }

  private async pushContent(inner: BlockEditorView): Promise<void> {
    try {
      await inner.openExternalFile(this.abs, this.fileName);
    } catch (e) {
      new Notice(`无法打开 ${this.fileName}：${String(e).slice(0, 100)}`);
    }
  }

  /** True when this shell is showing the given entry. */
  matches(node: MountNode): boolean {
    return this.abs === node.abs;
  }

  // Forwarded from the hosted editor, so callers do not have to know that there
  // is a shell at all: `isExternal`, `externalAbs`, `externalDisplayPath` and
  // the block model all live on the inner BlockEditorView.
  get blockEditor(): BlockEditorView | null {
    return this.inner;
  }

  get isExternal(): boolean {
    return this.abs !== '';
  }

  get externalAbs(): string {
    return this.abs;
  }

  /** Mount-relative path for the header; falls back to the file name. */
  get displayPath(): string {
    return this.rel || this.fileName;
  }

  get doc(): BlockEditorView['doc'] | null {
    return this.inner?.doc ?? null;
  }

  /** Save through to the original file (the editor's own redirect to fs). */
  async save(): Promise<void> {
    await this.inner?.save();
  }

  getViewData(): string {
    return this.inner?.getViewData() ?? '';
  }

  /** Re-render the hosted editor after a settings change. */
  rerender(): void {
    this.inner?.rerender();
  }
}