// 扩展市场 Modal：搜索（双来源）+ 已安装管理（启停/重装/卸载）。
// 逻辑对齐 siyuan-virtual-tree market-ui.ts，思源 Dialog → Obsidian Modal，
// b3-* 类 → Obsidian 原生类 + lgp-ext-* 自有段。

import { Modal, Notice, setIcon } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { getInstalledExtensions, installFromSearchEntry, search, toggleExtension, uninstallExtension, reinstallExtension } from './extensionManager';
import { getIconThemesWithMissingIcons } from './iconThemeLoader';
import type { ExtensionSource, InstalledExtension, SearchEntry } from './types';

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class ExtensionMarketModal extends Modal {
  private plugin: LogseqEditorPlugin;
  private listEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private sourceSelect!: HTMLSelectElement;

  constructor(plugin: LogseqEditorPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('lgp-ext-market');
    contentEl.createEl('h2', { text: '扩展市场（VSCode 扩展）' });

    // 搜索栏
    const bar = contentEl.createDiv({ cls: 'lgp-ext-market__search' });
    this.sourceSelect = bar.createEl('select', { cls: 'dropdown' });
    this.sourceSelect.createEl('option', { value: 'openvsx', text: 'Open VSX Registry' });
    this.sourceSelect.createEl('option', { value: 'vscode-marketplace', text: 'VSCode Marketplace' });
    this.searchInput = bar.createEl('input', {
      cls: 'lgp-ext-market__input',
      type: 'text',
      placeholder: '搜索扩展（如 python、theme、snippet…）',
    });
    bar.createEl('button', { cls: 'mod-cta', text: '搜索' }).addEventListener('click', () => void this.doSearch());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.doSearch();
    });

    // Tab 切换
    const tabs = contentEl.createDiv({ cls: 'lgp-ext-market__tabs' });
    const searchTab = tabs.createEl('button', { cls: 'lgp-ext-market__tab is-active', text: '搜索结果' });
    const installedTab = tabs.createEl('button', { cls: 'lgp-ext-market__tab', text: '已安装' });
    searchTab.addEventListener('click', () => {
      searchTab.classList.add('is-active');
      installedTab.classList.remove('is-active');
      this.listEl.innerHTML = '<div class="lgp-ext-market__empty">输入关键词搜索扩展</div>';
    });
    installedTab.addEventListener('click', () => {
      installedTab.classList.add('is-active');
      searchTab.classList.remove('is-active');
      void this.renderInstalled();
    });

    this.listEl = contentEl.createDiv({ cls: 'lgp-ext-market__list' });
    this.listEl.innerHTML = '<div class="lgp-ext-market__empty">输入关键词搜索扩展</div>';
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async doSearch(): Promise<void> {
    const query = this.searchInput.value.trim();
    if (!query) return;
    const source = this.sourceSelect.value as ExtensionSource;
    this.listEl.innerHTML = '<div class="lgp-ext-market__empty">搜索中…</div>';
    try {
      const result = await search(query, 30, source);
      this.renderSearchResults(result.extensions);
    } catch (e) {
      this.listEl.innerHTML = `<div class="lgp-ext-market__empty">搜索失败: ${escapeHTML(String(e))}</div>`;
    }
  }

  private renderSearchResults(entries: SearchEntry[]): void {
    if (entries.length === 0) {
      this.listEl.innerHTML = '<div class="lgp-ext-market__empty">未找到匹配的扩展</div>';
      return;
    }
    this.listEl.empty();
    for (const e of entries) {
      const card = this.listEl.createDiv({ cls: 'lgp-ext-card' });
      const iconWrap = card.createDiv({ cls: 'lgp-ext-card__icon' });
      if (e.iconLink) iconWrap.createEl('img', { attr: { src: e.iconLink, alt: '' } });
      else iconWrap.createDiv({ cls: 'lgp-ext-card__icon-default', text: '📦' });
      const info = card.createDiv({ cls: 'lgp-ext-card__info' });
      info.createDiv({ cls: 'lgp-ext-card__title', text: e.displayName || e.name });
      info.createDiv({
        cls: 'lgp-ext-card__meta',
        text: `${e.namespace}.${e.name} · v${e.version} · ${e.source === 'vscode-marketplace' ? 'Marketplace' : 'Open VSX'}`,
      });
      if (e.description) info.createDiv({ cls: 'lgp-ext-card__desc', text: e.description });
      const action = card.createDiv({ cls: 'lgp-ext-card__action' });
      const btn = action.createEl('button', { cls: 'mod-cta', text: '安装' });
      btn.addEventListener('click', async () => {
        btn.textContent = '安装中…';
        (btn as HTMLButtonElement).disabled = true;
        try {
          await installFromSearchEntry(this.plugin, e);
          btn.textContent = '已安装';
          new Notice(`扩展 ${e.namespace}.${e.name} 安装成功`);
        } catch (err) {
          btn.textContent = '安装';
          (btn as HTMLButtonElement).disabled = false;
          new Notice(`安装失败: ${String(err)}`);
        }
      });
    }
  }

  private async renderInstalled(): Promise<void> {
    this.listEl.innerHTML = '<div class="lgp-ext-market__empty">加载中…</div>';
    const extensions = await getInstalledExtensions(this.plugin);
    this.listEl.empty();
    if (extensions.length === 0) {
      this.listEl.innerHTML = '<div class="lgp-ext-market__empty">尚未安装任何扩展</div>';
      return;
    }
    for (const e of extensions) {
      this.renderInstalledCard(e);
    }
  }

  private renderInstalledCard(e: InstalledExtension): void {
    const card = this.listEl.createDiv({ cls: 'lgp-ext-card' });
    const iconWrap = card.createDiv({ cls: 'lgp-ext-card__icon' });
    if (e.icon) iconWrap.createEl('img', { attr: { src: e.icon, alt: '' } });
    else iconWrap.createDiv({ cls: 'lgp-ext-card__icon-default', text: '📦' });

    const info = card.createDiv({ cls: 'lgp-ext-card__info' });
    info.createDiv({ cls: 'lgp-ext-card__title', text: e.displayName });
    info.createDiv({
      cls: 'lgp-ext-card__meta',
      text: `${e.namespace}.${e.name} · v${e.version} · ${e.enabled ? '已启用' : '已禁用'}`,
    });
    if (e.description) info.createDiv({ cls: 'lgp-ext-card__desc', text: e.description });
    const contrib = info.createDiv({ cls: 'lgp-ext-card__contrib' });
    const tags: string[] = [];
    if (e.contributes.grammars?.length) tags.push(`语法 ×${e.contributes.grammars.length}`);
    if (e.contributes.themes?.length) tags.push(`主题 ×${e.contributes.themes.length}`);
    if (e.contributes.iconThemes?.length) tags.push(`图标 ×${e.contributes.iconThemes.length}`);
    if (e.contributes.snippets?.length) tags.push(`片段 ×${e.contributes.snippets.length}`);
    for (const t of tags) contrib.createSpan({ cls: 'lgp-ext-tag', text: t });
    // 图标主题声明了图标但 SVG 全部缺失（历史安装数据不完整）→ 提示重装
    if (getIconThemesWithMissingIcons().some((t) => t.extensionId === e.id)) {
      contrib.createSpan({
        cls: 'lgp-ext-tag is-warn',
        text: '图标缺失',
        attr: { title: '图标文件缺失，请点「重装」重新下载' },
      });
    }

    const action = card.createDiv({ cls: 'lgp-ext-card__action' });
    const iconBtn = (icon: string, tooltip: string, onClick: () => Promise<void>): HTMLElement => {
      const b = action.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tooltip, title: tooltip } });
      // lucide 图标直接用 setIcon（obsidian 全局），不依赖 innerHTML
      setIcon(b, icon);
      b.addEventListener('click', () => void onClick());
      return b;
    };
    iconBtn(e.enabled ? 'pause' : 'play', e.enabled ? '禁用' : '启用', async () => {
      await toggleExtension(this.plugin, e.id);
      new Notice('已切换（重载插件后完全生效）');
      void this.renderInstalled();
    });
    iconBtn('refresh-cw', '重装（重新下载解包，修复文件缺失）', async () => {
      try {
        await reinstallExtension(this.plugin, e.id);
        new Notice('重装完成');
      } catch (err) {
        new Notice(`重装失败: ${String(err)}`);
      }
      void this.renderInstalled();
    });
    iconBtn('trash-2', '卸载', async () => {
      try {
        await uninstallExtension(this.plugin, e.id);
        new Notice('已卸载（重载插件后完全清理）');
      } catch (err) {
        new Notice(`卸载失败: ${String(err)}`);
      }
      void this.renderInstalled();
    });
  }
}
