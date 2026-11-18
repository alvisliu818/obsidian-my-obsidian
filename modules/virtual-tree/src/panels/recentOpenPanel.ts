/**
 * 最近打开独立面板(用户 2026-11-19:不要内嵌在挂载面板里,树被推下去——
 * 拆成单独 dock 面板)。数据源 = virtual-tree recordRecentOpen 记录(库内挂载
 * 文件 + 库外/remote 打开),与 md-editor 的「最近使用」(纯库内 file-open)
 * 是两套列表、两个面板。
 *
 * 结构照 RecentPanelView(最近使用)同款:标题栏 + 清空 + 扩展名 chips 筛选 +
 * 条目列表;点击经 openRecentEntry 回跳(挂载解析→openExternalEntry)。
 */
import { ItemView, Menu, setIcon, type WorkspaceLeaf } from 'obsidian';
import type VirtualTreePlugin from '../main';
import { recentExtChips, RECENT_FILTER_ALL } from './recentOpen';

export const VIEW_TYPE_RECENT_OPEN_PANEL = 'vt-recent-open-panel';

export class RecentOpenPanelView extends ItemView {
  plugin: VirtualTreePlugin;
  private listEl!: HTMLElement;
  private chipHostEl: HTMLElement | null = null;
  private filter = RECENT_FILTER_ALL;

  constructor(leaf: WorkspaceLeaf, plugin: VirtualTreePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RECENT_OPEN_PANEL;
  }

  getDisplayText(): string {
    return '最近打开';
  }

  getIcon(): string {
    return 'history';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('vt-recent-open');

    const bar = this.contentEl.createDiv({ cls: 'logseq-mount-section' });
    bar.style.display = 'flex';
    bar.style.alignItems = 'center';
    bar.createSpan({ cls: 'logseq-mount-name', text: '最近打开' });
    const clear = bar.createEl('button', { text: '清空' });
    clear.style.cssText =
      'border:none;background:transparent;cursor:pointer;color:var(--text-faint);font-size:11px;margin-left:auto';
    clear.addEventListener('click', () => {
      this.plugin.clearRecentOpen();
      this.render();
    });

    this.chipHostEl = this.contentEl.createDiv();
    this.chipHostEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:2px 8px 4px';
    this.chipHostEl.hide();

    this.listEl = this.contentEl.createDiv({ cls: 'vt-recent-open__list' });
    this.render();
  }

  /** 面板重绘(onOpen / 记录变更 / 清空 / 筛选切换都会走)。 */
  render(): void {
    if (!this.listEl) return;
    const entries = this.plugin.recentEntries(this.filter);
    this.listEl.empty();

    // 扩展名 chips:多于一种扩展名才显示(单一类型没有筛的意义)
    const chips = recentExtChips(this.plugin.recentEntries(RECENT_FILTER_ALL));
    if (this.chipHostEl) {
      this.chipHostEl.empty();
      if (chips.length > 1) {
        this.chipHostEl.show();
        for (const chip of chips) {
          const b = this.chipHostEl.createEl('button', { text: chip.ext });
          b.style.cssText =
            'font-size:10px;border:1px solid var(--background-modifier-border);border-radius:8px;padding:0 6px;cursor:pointer;background:none;color:var(--text-muted)';
          if (chip.ext === this.filter) {
            b.style.background = 'var(--background-modifier-active-hover)';
            b.style.color = 'var(--text-accent)';
          }
          b.addEventListener('click', () => {
            this.filter = chip.ext;
            this.render();
          });
        }
      } else {
        this.chipHostEl.hide();
      }
    }

    if (!entries.length) {
      this.listEl.createDiv({
        cls: 'lg-recent__empty',
        text: '还没有记录。打开挂载条目后它会显示在这里。',
      });
      return;
    }
    for (const entry of entries.slice(0, 60)) {
      const row = this.listEl.createDiv({ cls: 'logseq-mount-row' });
      row.style.paddingInlineStart = '14px';
      row.setAttribute('title', entry.path);
      const icon = row.createSpan({ cls: 'logseq-mount-icon' });
      setIcon(icon, entry.kind === 'vault' ? 'file-text' : 'external-link');
      icon.style.marginRight = '4px';
      row.createSpan({ cls: 'logseq-mount-name', text: this.baseName(entry.path) });
      row.addEventListener('click', () => void this.plugin.openRecentEntry(entry));
      row.addEventListener('contextmenu', (e) => {
        const menu = new Menu();
        menu.addItem((i) =>
          i.setTitle('打开').setIcon('arrow-up-right' as never).onClick(() => {
            void this.plugin.openRecentEntry(entry);
          }),
        );
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle('从最近打开中移除').setIcon('x' as never).onClick(() => {
            this.plugin.settings.recentOpen = (this.plugin.settings.recentOpen ?? []).filter(
              (x) => x.path !== entry.path,
            );
            void this.plugin.saveSettings();
            this.render();
          }),
        );
        menu.showAtMouseEvent(e);
      });
    }
  }

  /** 条目显示名:路径最后一段(库外绝对路径也只亮文件名)。 */
  private baseName(p: string): string {
    return p.split(/[\\/]/).pop() || p;
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
