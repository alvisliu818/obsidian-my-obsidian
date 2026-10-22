/**
 * Recent-files panel.
 *
 * Ported from `siyuan-editor/src/dock/recent-dock.ts`. Obsidian ships a
 * "Recent files" core plugin, but it shows a flat list you cannot act on and it
 * forgets everything on reload — this one keeps a bounded, persisted list and
 * gives every row the same right-click menu the file explorer has (open with,
 * reveal, copy path).
 *
 * The list is filled from the workspace's own `file-open` event, so it reflects
 * what was actually opened, not what was merely touched.
 */

import { ItemView, Menu, TFile, setIcon, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { addOpenWithMenuItems } from '../features/openWith';

export const VIEW_TYPE_RECENT_PANEL = 'logseq-recent-panel';

/** How many entries are kept; the list is trimmed on every insert. */
export const RECENT_LIMIT = 60;

export class RecentPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private listEl!: HTMLElement;
  /** Only show entries that still exist in the vault. */
  private hideMissing = true;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RECENT_PANEL;
  }

  getDisplayText(): string {
    return '最近使用';
  }

  getIcon(): string {
    return 'history';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lg-recent');

    const bar = this.contentEl.createDiv({ cls: 'lg-recent__bar' });
    bar.createSpan({ cls: 'lg-recent__title', text: '最近使用' });
    const clear = bar.createEl('button', { cls: 'lg-recent__btn' });
    setIcon(clear, 'trash');
    clear.title = '清空列表';
    clear.addEventListener('click', async () => {
      this.plugin.settings.recentFiles = [];
      await this.plugin.saveSettings();
      this.render();
    });

    this.listEl = this.contentEl.createDiv({ cls: 'lg-recent__list' });
    this.render();
  }

  render(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const paths = this.plugin.settings.recentFiles ?? [];
    const rows: TFile[] = [];
    let missing = 0;
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) rows.push(f);
      else missing++;
    }

    if (rows.length === 0) {
      this.listEl.createDiv({
        cls: 'lg-recent__empty',
        text: '还没有记录。打开任意文件后它会显示在这里。',
      });
      return;
    }

    for (const file of rows) {
      const row = this.listEl.createDiv({ cls: 'lg-recent__row' });
      const text = row.createDiv({ cls: 'lg-recent__text' });
      text.createDiv({ cls: 'lg-recent__name', text: file.basename });
      // 第二行只显示所在目录，文件名已经占第一行；根目录文件显示 "/"
      const dir = file.parent && file.parent.path !== '/' ? file.parent.path : '/';
      text.createDiv({ cls: 'lg-recent__path', text: dir });
      row.title = file.path;
      row.addEventListener('click', () => {
        void this.app.workspace.openLinkText(file.path, '', false);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle('打开').setIcon('file-text' as never).onClick(() => {
            void this.app.workspace.openLinkText(file.path, '', false);
          }),
        );
        if (file instanceof TFile) {
          addOpenWithMenuItems(this.plugin.app, file, menu, this.plugin.settings.openWithApps);
        }
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle('从列表中移除')
            .setIcon('x' as never)
            .onClick(async () => {
              this.plugin.settings.recentFiles = (this.plugin.settings.recentFiles ?? []).filter(
                (p) => p !== file.path,
              );
              await this.plugin.saveSettings();
              this.render();
            }),
        );
        menu.showAtMouseEvent(e);
      });
    }

    if (missing > 0 && !this.hideMissing) {
      this.listEl.createDiv({ cls: 'lg-recent__note', text: `${missing} 个条目已不在库中。` });
    }
  }
}

/**
 * Push a path onto the front of the recent list.
 *
 * Pure so it is unit-testable: takes and returns the raw array rather than
 * reaching for the plugin.
 */
export function pushRecent(list: string[], path: string): string[] {
  const next = [path, ...list.filter((p) => p !== path)];
  return next.slice(0, RECENT_LIMIT);
}
