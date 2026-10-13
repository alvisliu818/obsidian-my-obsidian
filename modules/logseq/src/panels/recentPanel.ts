/**
 * Recent-files panel — every file the user opened, vault and external.
 *
 * Obsidian ships a "Recent files" core plugin, but it shows a flat list you
 * cannot act on and it forgets everything on reload — this one keeps a
 * bounded, persisted list and gives every row the same right-click menu the
 * file explorer has (open with, reveal, copy path).
 *
 * The list is filled from the workspace's `file-open` event AND the
 * external-open routes (see `recordRecentOpen` in main.ts), so a file opened
 * from a folder mounted outside the vault lands here as well. Rows can be
 * narrowed by file type with the chips above the list.
 *
 * 数据形态、上限与筛选逻辑都在 ./recentOpen.ts（纯函数，单测覆盖）；
 * 本文件只负责 DOM 与菜单。
 */

import { ItemView, Menu, Notice, TFile, setIcon, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { addOpenWithMenuItems } from '../features/openWith';
import { exists } from '../features/extFs';
import { iconForEntry } from '../features/iconTheme';
import { mountDisplayName } from '../types';
import {
  RECENT_FILTER_ALL,
  baseNameOf,
  extChipLabel,
  filterRecentOpen,
  recentExtChips,
  resolveMountForAbs,
  type RecentOpenEntry,
} from './recentOpen';

export const VIEW_TYPE_RECENT_PANEL = 'logseq-recent-panel';

export class RecentPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private chipsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  /** 当前类型筛选：RECENT_FILTER_ALL 或小写扩展名（'' = 无扩展名）。 */
  private filter = RECENT_FILTER_ALL;

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
    this.countEl = bar.createSpan({ cls: 'lg-recent__count' });
    const clear = bar.createEl('button', { cls: 'lg-recent__btn' });
    setIcon(clear, 'trash');
    clear.title = '清空列表';
    clear.addEventListener('click', () => void this.clearAll());

    this.chipsEl = this.contentEl.createDiv({ cls: 'lg-recent__chips' });
    this.listEl = this.contentEl.createDiv({ cls: 'lg-recent__list' });
    this.render();
  }

  render(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    this.chipsEl.empty();

    // ---- 解析：哪些记录现在还打得开 ----
    // 库内按 TFile、库外按磁盘存在性。打不开的不显示，但也不从列表里删：
    // 移动硬盘插回来它们就该回来，删了得等下次打开才补。
    const alive: Array<{ entry: RecentOpenEntry; file: TFile | null }> = [];
    let hidden = 0;
    for (const entry of this.plugin.settings.recentOpenFiles ?? []) {
      if (entry.kind === 'vault') {
        const f = this.app.vault.getAbstractFileByPath(entry.path);
        if (f instanceof TFile) alive.push({ entry, file: f });
        else hidden++;
      } else if (exists(entry.path)) {
        alive.push({ entry, file: null });
      } else hidden++;
    }
    this.countEl.setText(alive.length > 0 ? String(alive.length) : '');

    if (alive.length === 0) {
      this.chipsEl.style.display = 'none';
      this.listEl.createDiv({
        cls: 'lg-recent__empty',
        text: hidden > 0 ? '记录里的文件都已不在库中。' : '还没有记录。打开任意文件后它会显示在这里。',
      });
      return;
    }
    this.chipsEl.style.display = '';

    // ---- 类型筛选 chips：从现存记录里出现过的扩展名生成 ----
    const mkChip = (value: string, label: string): void => {
      const chip = this.chipsEl.createEl('button', {
        cls: 'lg-recent__chip' + (this.filter === value ? ' is-active' : ''),
        text: label,
      });
      chip.addEventListener('click', () => {
        this.filter = value;
        this.render();
      });
    };
    mkChip(RECENT_FILTER_ALL, '全部');
    for (const { ext, count } of recentExtChips(alive.map((a) => a.entry))) {
      mkChip(ext, `${extChipLabel(ext)} ${count}`);
    }

    // ---- 行 ----
    const byKey = new Map(alive.map((a) => [`${a.entry.kind}:${a.entry.path}`, a] as const));
    const shown = filterRecentOpen(alive.map((a) => a.entry), this.filter)
      .map((e) => byKey.get(`${e.kind}:${e.path}`))
      .filter((p): p is { entry: RecentOpenEntry; file: TFile | null } => p !== undefined);
    if (shown.length === 0) {
      this.listEl.createDiv({ cls: 'lg-recent__empty', text: '当前筛选下没有文件。' });
    }
    for (const { entry, file } of shown) {
      const isVault = entry.kind === 'vault';
      const name = file ? file.name : baseNameOf(entry.path);
      const row = this.listEl.createDiv({ cls: 'lg-recent__row' });
      row.appendChild(
        iconForEntry(this.plugin.app, {
          name,
          isDir: false,
          mountPath: isVault ? this.plugin.vaultBasePath() : '',
          // 库内文件给库内相对路径，图标主题才能按它匹配；库外给裸名。
          rel: isVault ? entry.path : name,
          fallback: '📄',
        }),
      );
      const text = row.createDiv({ cls: 'lg-recent__text' });
      text.createDiv({ cls: 'lg-recent__name', text: name });
      let sub: string;
      if (file) {
        sub = file.parent && file.parent.path !== '/' ? file.parent.path : '/';
      } else {
        // 库外行显示「挂载名 / 相对目录」，认不出挂载就退到绝对目录。
        const hit = resolveMountForAbs(
          (this.plugin.settings.externalMounts ?? []).filter((m) => m.enabled),
          entry.path,
        );
        if (hit) {
          const dirRel = parentRelOf(hit.rel);
          sub = mountDisplayName(hit.mount) + (dirRel ? ` / ${dirRel}` : '');
        } else {
          const slash = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'));
          sub = slash > 0 ? entry.path.slice(0, slash) : '';
        }
      }
      text.createDiv({ cls: 'lg-recent__path', text: sub });
      row.title = entry.path;
      if (!isVault) row.createSpan({ cls: 'lg-recent__flag', text: '库外' });
      row.addEventListener('click', () => void this.openEntry(entry));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle('打开').setIcon('file-text' as never).onClick(() => void this.openEntry(entry)),
        );
        if (file) {
          addOpenWithMenuItems(this.plugin.app, file, menu, this.plugin.settings.openWithApps);
        }
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle('复制路径')
            .setIcon('copy' as never)
            .onClick(() => {
              void navigator.clipboard?.writeText(entry.path);
              new Notice('已复制路径');
            }),
        );
        if (!isVault) {
          menu.addItem((item) =>
            item
              .setTitle('在资源管理器中显示')
              .setIcon('folder-open' as never)
              .onClick(() => this.plugin.revealInSystem(entry.path)),
          );
        }
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle('从列表中移除')
            .setIcon('x' as never)
            .onClick(async () => {
              this.plugin.settings.recentOpenFiles = (this.plugin.settings.recentOpenFiles ?? []).filter(
                (x) => !(x.path === entry.path && x.kind === entry.kind),
              );
              await this.plugin.saveSettings();
              this.render();
            }),
        );
        menu.showAtMouseEvent(e);
      });
    }

    if (hidden > 0) {
      this.listEl.createDiv({
        cls: 'lg-recent__note',
        text: `${hidden} 个记录已打不开（文件已删或挂载已卸）。`,
      });
    }
  }

  /** 打开一条记录：库内走 openLinkText，库外还原挂载后走外部打开链。 */
  private async openEntry(entry: RecentOpenEntry): Promise<void> {
    if (entry.kind === 'vault') {
      await this.app.workspace.openLinkText(entry.path, '', false);
      return;
    }
    const abs = entry.path;
    const hit = resolveMountForAbs(
      (this.plugin.settings.externalMounts ?? []).filter((m) => m.enabled),
      abs,
    );
    if (hit) {
      const name = baseNameOf(abs);
      await this.plugin.openExternalEntry(hit.mount, { name, rel: hit.rel || name, abs, isDir: false, children: [] });
      return;
    }
    // 挂载已卸载：文件还在磁盘上就还给原生编辑器，再不行交给系统程序。
    const name = baseNameOf(abs);
    const node = { name, rel: name, abs, isDir: false, children: [] };
    if (this.plugin.canOpenNativeExternal()) {
      await this.plugin.openExternalInNativeEditor(node);
      return;
    }
    this.plugin.openWithSystem(abs);
  }

  private async clearAll(): Promise<void> {
    this.plugin.settings.recentOpenFiles = [];
    await this.plugin.saveSettings();
    this.filter = RECENT_FILTER_ALL;
    this.render();
  }
}

/** rel 的父目录相对路径；顶层返回 ''（挂载根）。 */
function parentRelOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}
