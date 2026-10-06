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

import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon, type ViewStateResult } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { Block } from '../types';
import { parseDocument } from '../core/parser';
import { serializeDocument } from '../core/serializer';
import { logOp } from '../features/logger';
import { extOf, readExternalText, writeExternalText } from '../features/extFs';
import { isTextMount } from '../features/mountFilter';

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
    if (!this.readOnly) {
      banner.createEl('button', { cls: 'logseq-external-save', text: '保存' }).addEventListener('click', () => {
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

    if (b.children.length > 0) {
      const container = wrap.createDiv({ cls: 'block-children-container' });
      container.createDiv({ cls: 'block-children-left-border' });
      const kids = container.createDiv({ cls: 'block-children' });
      for (const c of b.children) this.renderBlock(kids, c, depth + 1);
    }
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
}

/**
 * Route an external file: text-like extensions go to the block view, everything
 * else to the system. The extension list in `mountFilter.ts` is deliberately
 * conservative — a wrong guess here would mean writing text over a binary file.
 */
export function classifyExternalFile(name: string): 'text' | 'system' {
  return isTextMount(extOf(name)) ? 'text' : 'system';
}
