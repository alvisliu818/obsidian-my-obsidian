/**
 * Office document view — takes over .docx / .xlsx / .pptx (and friends) so an
 * Office file dropped into the vault can be read without leaving Obsidian.
 *
 * Why a dedicated `ItemView` instead of a markdown post-processor: these are
 * binary files, so there is no markdown to post-process, and Obsidian has no
 * text view for them at all (it offers "open in default app" and nothing else).
 * `registerExtensions` in `main.ts` hands the extensions to this view.
 */

import { ItemView, Menu, Notice, setIcon, TFile, type WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import {
  getOfficeKind,
  OFFICE_KIND_LABEL,
  type OfficeEngine,
  type OfficeKind,
} from '../office/types';
import { createDocumentEngine } from '../office/document';
import { createSpreadsheetEngine } from '../office/spreadsheet';
import { createPresentationEngine } from '../office/presentation';
import { createLegacyEngine } from '../office/legacy';
import { addOpenWithMenuItems, openWithSystemDefault } from '../features/openWith';
import { extOf } from '../features/extFs';

export const VIEW_TYPE_OFFICE = 'logseq-office';

/** What a leaf remembers so it can reopen the same document. */
export interface OfficeViewState {
  path?: string;
}

export class OfficeView extends ItemView {
  plugin: LogseqEditorPlugin;
  private path = '';
  private engine: OfficeEngine | null = null;
  private bodyEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private viewTitleEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_OFFICE;
  }

  getDisplayText(): string {
    return this.path ? this.path.split('/').pop() || this.path : 'Office 文档';
  }

  getIcon(): string {
    const k = getOfficeKind(extOf(this.path));
    if (k === 'spreadsheet') return 'table';
    if (k === 'presentation') return 'presentation';
    return 'file-text';
  }

  getState(): Record<string, unknown> {
    return { path: this.path };
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as OfficeViewState;
    const next = typeof s.path === 'string' ? s.path : '';
    if (next !== this.path) {
      this.path = next;
      await this.load();
    }
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lg-office-view');

    this.toolbarEl = this.contentEl.createDiv({ cls: 'lg-office-view__toolbar' });
    this.viewTitleEl = this.toolbarEl.createDiv({ cls: 'lg-office-view__title' });
    const actions = this.toolbarEl.createDiv({ cls: 'lg-office-view__actions' });

    const openBtn = actions.createEl('button', { cls: 'lg-office-view__btn' });
    setIcon(openBtn, 'external-link');
    openBtn.title = '用外部应用打开';
    openBtn.addEventListener('click', () => void this.openExternally());

    const menuBtn = actions.createEl('button', { cls: 'lg-office-view__btn' });
    setIcon(menuBtn, 'ellipsis-vertical');
    menuBtn.title = '更多打开方式';
    menuBtn.addEventListener('click', (e) => this.showOpenWithMenu(e));

    const reloadBtn = actions.createEl('button', { cls: 'lg-office-view__btn' });
    setIcon(reloadBtn, 'refresh-cw');
    reloadBtn.title = '重新加载';
    reloadBtn.addEventListener('click', () => void this.load());

    this.bodyEl = this.contentEl.createDiv({ cls: 'lg-office-view__body' });

    await this.load();
  }

  async onClose(): Promise<void> {
    this.engine?.dispose();
    this.engine = null;
  }

  onResize(): void {
    this.engine?.resize?.();
  }

  /** (Re)read the file from disk and render it. */
  async load(): Promise<void> {
    if (!this.bodyEl) return;
    this.engine?.dispose();
    this.engine = null;
    this.bodyEl.empty();

    const file = this.path ? this.app.vault.getAbstractFileByPath(this.path) : null;
    if (!(file instanceof TFile)) {
      this.viewTitleEl.textContent = this.path || '未选择文件';
      this.bodyEl.createDiv({ cls: 'lg-office-view__error', text: '找不到该文件。' });
      return;
    }

    const ext = extOf(file.name);
    const kind = getOfficeKind(ext);
    this.viewTitleEl.textContent = `${file.name} · ${kind ? OFFICE_KIND_LABEL[kind] : ext.toUpperCase()}`;

    if (!kind) {
      this.bodyEl.createDiv({ cls: 'lg-office-view__error', text: `不支持的格式：.${ext}` });
      return;
    }

    const loading = this.bodyEl.createDiv({ cls: 'lg-office-view__loading', text: '正在解析文档…' });
    try {
      const data = await this.app.vault.adapter.readBinary(file.path);
      this.engine = await this.createEngine(kind, ext, data, file);
      loading.remove();
      this.bodyEl.appendChild(this.engine.root);
      this.renderEngineActions();
      // The container has real dimensions only now, so a fit-to-width engine
      // (the PowerPoint stage) can finally measure itself.
      requestAnimationFrame(() => this.engine?.resize?.());
    } catch (e) {
      loading.remove();
      const msg = e instanceof Error ? e.message : String(e);
      this.bodyEl.createDiv({ cls: 'lg-office-view__error', text: `解析失败：${msg}` });
      console.error('[obsidian-logseq] office parse failed', e);
    }
  }

  private async createEngine(kind: OfficeKind, ext: string, data: ArrayBuffer, file: TFile): Promise<OfficeEngine> {
    switch (kind) {
      case 'spreadsheet':
        return createSpreadsheetEngine(data, ext === 'csv');
      case 'document':
        return createDocumentEngine(data, ext);
      case 'presentation':
        return createPresentationEngine(data);
      case 'legacy':
        return createLegacyEngine({
          fileName: file.name,
          size: data.byteLength,
          kindLabel: OFFICE_KIND_LABEL.legacy,
          onOpenExternal: () => void this.openExternally(),
        });
    }
  }

  private renderEngineActions(): void {
    const acts = this.engine?.toolbarActions;
    if (!acts?.length) return;
    const bar = this.toolbarEl.createDiv({ cls: 'lg-office-view__engine-actions' });
    for (const a of acts) {
      const b = bar.createEl('button', { cls: 'lg-office-view__btn', text: a.label });
      b.addEventListener('click', () => a.onClick());
    }
  }

  private async openExternally(): Promise<void> {
    const file = this.path ? this.app.vault.getAbstractFileByPath(this.path) : null;
    if (!(file instanceof TFile)) {
      new Notice('找不到该文件。');
      return;
    }
    await openWithSystemDefault(this.plugin.app, file);
  }

  private showOpenWithMenu(e: MouseEvent): void {
    const file = this.path ? this.app.vault.getAbstractFileByPath(this.path) : null;
    if (!(file instanceof TFile)) return;
    const menu = new Menu();
    addOpenWithMenuItems(this.plugin.app, file, menu, this.plugin.settings.openWithApps);
    menu.showAtMouseEvent(e);
  }
}
