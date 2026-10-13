/**
 * Editor view for an EXTERNAL markdown file (one shown in the mount panel).
 *
 * Why its own view rather than reusing `BlockEditorView`:
 * `BlockEditorView` is a `TextFileView` bound to a vault `TFile`, and its render
 * path (`renderBlockTree`) needs the full editor state object — zoom, undo, dnd,
 * block index. Measured, a synthetic `TFile` is not a shortcut: `leaf.openFile()`
 * with one resolves but silently mounts the "empty" placeholder, so the content
 * never appears (see `notes/mounts.md`).
 *
 * So this reuses the parts that carry the project's guarantees — `parseDocument`
 * / `serializeDocument`, and the same `.block-tree` DOM classes — while skipping
 * the vault-bound features. Markdown stays the single source of truth: the file
 * on disk IS the note, and saving writes back to that same file. Nothing is ever
 * copied into the vault.
 */

import { ItemView, MarkdownRenderer, Menu, Notice, WorkspaceLeaf, setIcon, type ViewStateResult } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { Block } from '../types';
import { parseDocument } from '../core/parser';
import { serializeDocument } from '../core/serializer';
import { logOp } from '../features/logger';
import { extOf, readExternalText, writeExternalText } from '../features/extFs';
import { isTextMount } from '../features/mountFilter';
import { setLeafTitle } from '../features/leafTitle';
import { buildExternalPaneMenu } from '../features/externalPaneMenu';

export const VIEW_TYPE_EXTERNAL_FILE = 'logseq-external-file';

/** What a leaf remembers so it can reopen the same external file. */
export interface ExternalFileViewState {
  abs: string;
  name: string;
  readOnly?: boolean;
}

export class ExternalFileView extends ItemView {
  plugin: LogseqEditorPlugin;
  /** Absolute path of the file on disk — the real location, not a vault path. */
  abs = '';
  fileName = '';
  readOnly = false;
  private doc = parseDocument('');
  private dirty = false;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_EXTERNAL_FILE;
  }

  getDisplayText(): string {
    return this.fileName || '外部文件';
  }

  getIcon(): string {
    return 'file-text';
  }

  getState(): Record<string, unknown> {
    return { abs: this.abs, name: this.fileName, readOnly: this.readOnly };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as Partial<ExternalFileViewState>;
    if (typeof s.abs === 'string') this.abs = s.abs;
    if (typeof s.name === 'string') this.fileName = s.name;
    this.readOnly = s.readOnly === true;
    await super.setState(state, result);
  }

  /** Point this leaf at a file and show it. */
  async openExternal(opts: { abs: string; name: string; content: string; readOnly?: boolean }): Promise<void> {
    this.abs = opts.abs;
    this.fileName = opts.name;
    this.readOnly = opts.readOnly === true;
    this.doc = parseDocument(opts.content);
    this.dirty = false;
    this.render();
  }

  async onOpen(): Promise<void> {
    if (this.abs && isTextMount(extOf(this.fileName))) {
      try {
        this.doc = parseDocument(readExternalText(this.abs));
      } catch (e) {
        new Notice(`无法读取 ${this.fileName}：${String(e).slice(0, 100)}`);
      }
    }
    this.render();
  }

  async onClose(): Promise<void> {
    await this.flush();
  }

  /**
   * ⋮ 菜单 / 标签页右键菜单（库外文件与库内标签页对齐）。
   *
   * 库内文件的这类菜单由 `FileView.onPaneMenu` 提供；本视图是 ItemView，
   * 继承链上只有分屏项。`buildExternalPaneMenu` 先以中性 source 转发
   * `file-menu`（hop-1 TExternalFile + hop-2 TFile 适配器）让其他插件补项，
   * 再补作用在真实绝对路径上的自建项。source 原样透传：'more-options'（⋮）
   * 与 'tab-header'（右键）都走这里。
   */
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (!this.abs) return;
    buildExternalPaneMenu(this.plugin, menu, {
      abs: this.abs,
      fileName: this.fileName,
      popout: { viewType: VIEW_TYPE_EXTERNAL_FILE, getState: () => this.getState() },
      onRenamed: (newAbs, newName) => {
        this.abs = newAbs;
        this.fileName = newName;
        // 改名不动内容，但按新路径重读一次最稳（拾起别处的修改）。
        if (isTextMount(extOf(newName))) {
          try {
            this.doc = parseDocument(readExternalText(newAbs));
            this.dirty = false;
          } catch (e) {
            new Notice(`无法读取 ${newName}：${String(e).slice(0, 100)}`);
          }
        }
        setLeafTitle(this.leaf, newName);
        (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
        this.render();
      },
      onDeleted: () => {
        // 文件已经没了：先落盘再关（onClose 里 flush）。
        void this.onClose();
        this.leaf.detach();
      },
    });
  }

  // ------------------------------------------------------------------

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-external-view');

    // The banner is the honesty requirement: this file lives OUTSIDE the vault,
    // and editing it writes through to disk. Say so, every time.
    const banner = contentEl.createDiv({ cls: 'logseq-external-banner' });
    const icon = banner.createSpan({ cls: 'logseq-external-banner-icon' });
    setIcon(icon, this.readOnly ? 'eye' : 'file-text');
    banner.createSpan({
      cls: 'logseq-external-banner-text',
      text: this.readOnly ? `${this.fileName}（只读）` : this.fileName,
    });
    banner.createSpan({ cls: 'logseq-external-banner-path', text: this.abs });
    banner.createSpan({ cls: 'logseq-external-badge', text: '库外' });
    if (this.readOnly) {
      banner.createSpan({ cls: 'logseq-external-hint', text: '双击块可编辑' });
    } else {
      // Only offer the affordances that apply right now: an unsaved marker so a
      // pending edit is never invisible, and a hint for how to edit at all.
      if (this.dirty) banner.createSpan({ cls: 'logseq-external-dirty', text: '未保存' });
      else banner.createSpan({ cls: 'logseq-external-hint', text: '双击块可编辑' });
      banner.createEl('button', { cls: 'logseq-external-save', text: '保存到原文件' }).addEventListener('click', () => {
        void this.flush(true);
      });
    }

    const tree = contentEl.createDiv({ cls: 'block-tree logseq-external-tree' });
    if (this.doc.blocks.length === 0) {
      tree.createDiv({ cls: 'block-editor-empty', text: '（空文件）' });
      return;
    }
    for (const b of this.doc.blocks) this.renderBlock(tree, b, 0);
  }

  /**
   * One block, rendered with the SAME DOM classes as the vault block editor so
   * `styles.css` applies unchanged.
   *
   * Double-click puts ONE block into a plain textarea and commits on blur or
   * Ctrl+Enter. This is deliberately a small editor rather than the full CM6 one:
   * reaching the vault's editor needs a real vault path, and making an opening
   * click write a link into the library uninvited is worse than a modest editor.
   * A verbatim block (heading, fence, table) is edited as its raw markdown.
   */
  private renderBlock(parent: HTMLElement, b: Block, depth: number): void {
    const wrap = parent.createDiv({ cls: 'block-wrap' });
    const main = wrap.createDiv({ cls: 'block-main' });
    const controls = main.createDiv({ cls: 'block-controls' });
    controls.createDiv({ cls: 'block-bullet' });

    const content = main.createDiv({ cls: 'block-content' });
    if (b.kind === 'list') {
      if (b.marker) {
        const mk = main.createDiv({ cls: 'block-marker ' + b.marker.toLowerCase() });
        mk.setAttribute('aria-label', b.marker);
      }
      content.setText(b.text || (depth === 0 ? '空块' : ''));
      // Logseq properties are part of the note: show them as `key:: value`
      // lines, exactly as the vault editor does.
      for (const [k, v] of Object.entries(b.props)) {
        if (k === 'collapsed') continue; // view state, not content
        content.createDiv({ cls: 'block-prop', text: `${k}:: ${v}` });
      }
    } else {
      // Verbatim content (headings, paragraphs, fences) renders as markdown.
      void this.renderRaw(content, b.text);
    }

    if (!this.readOnly) this.makeEditable(wrap, content, b);

    if (b.children.length > 0) {
      const container = wrap.createDiv({ cls: 'block-children-container' });
      container.createDiv({ cls: 'block-children-left-border' });
      const kids = container.createDiv({ cls: 'block-children' });
      for (const c of b.children) this.renderBlock(kids, c, depth + 1);
    }
  }

  /**
   * Turn a block's content element into a single-block editor on double-click.
   *
   * Escape abandons the edit, Ctrl+Enter or blur commits. The tree is
   * re-rendered after a commit so a block that gained or lost a line (and the
   * markdown that follows from it) is rebuilt from the parser rather than
   * patched in the DOM.
   */
  private makeEditable(wrap: HTMLElement, content: HTMLElement, b: Block): void {
    wrap.addClass('logseq-external-editable');
    const start = (ev: MouseEvent) => {
      ev.stopPropagation();
      // A verbatim block is edited as its source; a list block as its text.
      const original = b.kind === 'list' ? b.text : b.text;
      const ta = document.createElement('textarea');
      ta.className = 'logseq-external-block-editor';
      ta.value = original;
      ta.rows = Math.max(1, original.split('\n').length);
      content.empty();
      content.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);

      let done = false;
      const finish = (commit: boolean): void => {
        if (done) return;
        done = true;
        if (commit && ta.value !== original) {
          b.text = ta.value;
          this.dirty = true;
          // Re-parse so the stored markdown is regenerated from the tree, then
          // rebuild: a multi-line block may now split differently.
          this.doc = parseDocument(serializeDocument(this.doc));
          this.render();
        } else {
          this.render();
        }
      };
      ta.addEventListener('blur', () => finish(true));
      ta.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Escape') {
          ke.preventDefault();
          finish(false);
        } else if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
          ke.preventDefault();
          finish(true);
        }
        // A newline inside a list block is part of its text, so Enter is not
        // intercepted; the user adds sibling blocks in the vault editor.
        ke.stopPropagation();
      });
    };
    wrap.addEventListener('dblclick', start);
  }

  private async renderRaw(host: HTMLElement, text: string): Promise<void> {
    if (!text.trim()) return;
    try {
      await MarkdownRenderer.render(this.app, text, host, '', this.plugin);
      host.addClass('logseq-external-raw');
    } catch {
      host.setText(text);
    }
  }

  // ------------------------------------------------------------------

  /**
   * Serialize back to markdown and write it to the ORIGINAL file.
   *
   * This is the whole point of mounting: the bytes on disk are the note, so the
   * save goes straight back to where the file already lives. The project rule
   * "markdown is the only source of truth" is respected by never introducing a
   * second copy.
   */
  async flush(notify = false): Promise<void> {
    if (!this.abs || this.readOnly || !this.dirty) return;
    const md = serializeDocument(this.doc);
    try {
      writeExternalText(this.abs, md);
      this.dirty = false;
      if (notify) new Notice(`已保存 ${this.fileName}`);
      logOp(this.plugin, 'external.save', this.abs, 'ok');
    } catch (e) {
      new Notice(`保存失败：${String(e).slice(0, 120)}`);
      logOp(this.plugin, 'external.save', this.abs, 'error', String(e).slice(0, 200));
    }
  }

  /** Re-read from disk (after the file changed elsewhere). */
  reload(): void {
    try {
      this.doc = parseDocument(readExternalText(this.abs));
      this.dirty = false;
      this.render();
    } catch (e) {
      new Notice(`重新读取失败：${String(e).slice(0, 100)}`);
    }
  }

  /** 是否有未落盘的改动（save-control 模块的脏状态探针）。 */
  isDirty(): boolean {
    return this.dirty;
  }
}

/**
 * Route an external file: text-like extensions go to the block view, everything
 * else to the system. The extension list in `mountFilter.ts` is deliberately
 * conservative — a wrong guess here would mean writing text over a binary file.
 */
export function classifyExternalFile(name: string): 'text' | 'system' {
  return isTextMount(extOf(name)) ? 'text' : 'system';
}
