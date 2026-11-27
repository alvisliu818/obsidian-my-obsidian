/**
 * 回收站管理器(思源 trash-dialog.ts 对齐):列出回收站条目,支持恢复(移回
 * 原位,同名冲突加「(恢复 …)」后缀)/ 彻底删除 / 清空 / 打开文件夹。
 *
 * 回收站位置可配置(设置→回收站位置):留空 = Obsidian 的 `<库根>/.trash`,
 * 此时管理器同时列出 Obsidian 自己删除的库内条目;配置到库外目录时只管理
 * 插件删除的库外条目。
 *
 * 入口:面板工具栏「回收站」(默认收进「更多」菜单)+ 设置页按钮。
 */

import { Modal, Notice, setIcon, type App } from 'obsidian';
import {
  emptyTrash,
  isObsidianTrashRoot,
  listObsidianTrashItems,
  listTrashItems,
  purgeObsidianTrashItem,
  purgeTrashItem,
  resolveTrashRoot,
  restoreFromTrash,
  restoreObsidianTrashItem,
  trashItemName,
  trashTimeText,
  type ObsidianTrashItem,
  type TrashListItem,
} from '../features/trashStore';

export class TrashManagerModal extends Modal {
  /** 回调:有条目被恢复/清空后通知调用方(通常重新扫描挂载面板)。 */
  private readonly onChanged?: () => void;
  /** 设置里的回收站位置;空 = Obsidian 的 `<库根>/.trash`。 */
  private readonly trashPath: string;

  constructor(app: App, private vaultBase: string, onChanged?: () => void, trashPath = '') {
    super(app);
    this.vaultBase = vaultBase;
    this.onChanged = onChanged;
    this.trashPath = trashPath;
  }

  onOpen(): void {
    this.contentEl.addClass('lgp-trash-modal');
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '回收站' });

    const root = resolveTrashRoot(this.vaultBase, this.trashPath);
    const shared = isObsidianTrashRoot(this.vaultBase, this.trashPath);
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        `位置：${root}。` +
        (shared
          ? '与 Obsidian 共用 .trash：库内删除的条目由 Obsidian 记录，库外删除的条目由插件记录，都可在这里恢复。'
          : '插件删除的库外文件按原路径镜像暂存，可一键恢复。') +
        '位置可在 设置 → 虚拟文档树 → 回收站位置 修改。',
    });

    const barEl = contentEl.createDiv({ cls: 'lgp-trash-modal__bar' });
    const openBtn = barEl.createEl('button', { text: '打开回收站文件夹' });
    openBtn.addEventListener('click', () => {
      // electron shell.openPath:回收站根不存在时先建出来,资源管理器才有得开
      try {
        const fs = (globalThis as { require?: (id: string) => unknown }).require?.('fs') as {
          existsSync(p: string): boolean;
          mkdirSync(p: string, o: { recursive: boolean }): void;
        } | undefined;
        if (fs && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
      } catch {
        /* 建不了目录也照常尝试打开 */
      }
      const { shell } = ((globalThis as { require?: (id: string) => unknown }).require?.('electron') ?? {}) as {
        shell?: { openPath(p: string): Promise<string> };
      };
      if (shell) void shell.openPath(root);
      else new Notice('无法打开系统文件管理器');
    });

    const pluginItems = listTrashItems(this.vaultBase, this.trashPath);
    const obsidianItems = shared ? listObsidianTrashItems(this.vaultBase, this.trashPath) : [];
    const total = pluginItems.length + obsidianItems.length;

    const emptyBtn = barEl.createEl('button', { cls: 'mod-warning', text: '清空回收站' });
    emptyBtn.addEventListener('click', () => {
      if (!total) {
        new Notice('回收站已是空的');
        return;
      }
      new ConfirmPurge(this.app, `清空回收站:${total} 个条目将被彻底删除,此操作不可恢复。`, () => {
        try {
          emptyTrash(this.vaultBase, this.trashPath);
          new Notice('回收站已清空');
          this.onChanged?.();
        } catch (e) {
          new Notice(`清空失败:${(e as Error)?.message ?? '未知错误'}`);
        }
        this.render();
      }).open();
    });

    const listEl = contentEl.createDiv({ cls: 'lgp-trash-modal__list' });
    if (!total) {
      listEl.createDiv({ cls: 'lgp-trash-modal__empty', text: '回收站是空的。' });
      return;
    }
    if (pluginItems.length) {
      listEl.createEl('h4', { text: '库外删除（插件记录）' });
      for (const it of pluginItems) this.renderPluginItem(listEl, it);
    }
    if (obsidianItems.length) {
      listEl.createEl('h4', { text: '库内删除（Obsidian .trash）' });
      for (const it of obsidianItems) this.renderObsidianItem(listEl, it);
    }
  }

  private renderPluginItem(listEl: HTMLElement, it: TrashListItem): void {
    const row = listEl.createDiv({ cls: 'lgp-trash-modal__row' });
    const iconEl = row.createSpan({ cls: 'lgp-trash-modal__icon' });
    setIcon(iconEl, it.isDir ? 'folder' : 'file');
    const mainEl = row.createDiv({ cls: 'lgp-trash-modal__main' });
    mainEl.createDiv({ cls: 'lgp-trash-modal__name', text: trashItemName(it.origin) });
    mainEl.createDiv({ cls: 'lgp-trash-modal__origin', text: it.origin });
    row.createSpan({ cls: 'lgp-trash-modal__time', text: trashTimeText(it.time) });

    const restoreBtn = row.createEl('button', { text: '恢复' });
    restoreBtn.addEventListener('click', () => {
      try {
        const r = restoreFromTrash(this.vaultBase, it.id, this.trashPath);
        new Notice(`已恢复到 ${r.restoredAs}`);
        this.onChanged?.();
        this.render();
      } catch (e) {
        new Notice(`恢复失败:${(e as Error)?.message ?? '未知错误'}`);
      }
    });
    const purgeBtn = row.createEl('button', { cls: 'mod-warning', text: '彻底删除' });
    purgeBtn.addEventListener('click', () => {
      new ConfirmPurge(this.app, `彻底删除「${trashItemName(it.origin)}」?此操作不可恢复。`, () => {
        try {
          purgeTrashItem(this.vaultBase, it.id, this.trashPath);
        } catch (e) {
          new Notice(`删除失败:${(e as Error)?.message ?? '未知错误'}`);
        }
        this.render();
      }).open();
    });
  }

  private renderObsidianItem(listEl: HTMLElement, it: ObsidianTrashItem): void {
    const name = it.rel.includes('/') ? it.rel.slice(it.rel.lastIndexOf('/') + 1) : it.rel;
    const row = listEl.createDiv({ cls: 'lgp-trash-modal__row' });
    const iconEl = row.createSpan({ cls: 'lgp-trash-modal__icon' });
    setIcon(iconEl, it.isDir ? 'folder' : 'file');
    const mainEl = row.createDiv({ cls: 'lgp-trash-modal__main' });
    mainEl.createDiv({ cls: 'lgp-trash-modal__name', text: name });
    mainEl.createDiv({ cls: 'lgp-trash-modal__origin', text: it.rel });
    row.createSpan({ cls: 'lgp-trash-modal__time', text: it.time ? trashTimeText(it.time) : '' });

    const restoreBtn = row.createEl('button', { text: '恢复' });
    restoreBtn.addEventListener('click', () => {
      try {
        const r = restoreObsidianTrashItem(this.vaultBase, it.rel);
        new Notice(`已恢复到 ${r.restoredAs}`);
        this.onChanged?.();
        this.render();
      } catch (e) {
        new Notice(`恢复失败:${(e as Error)?.message ?? '未知错误'}`);
      }
    });
    const purgeBtn = row.createEl('button', { cls: 'mod-warning', text: '彻底删除' });
    purgeBtn.addEventListener('click', () => {
      new ConfirmPurge(this.app, `彻底删除「${it.rel}」?此操作不可恢复。`, () => {
        try {
          purgeObsidianTrashItem(this.vaultBase, it.rel);
        } catch (e) {
          new Notice(`删除失败:${(e as Error)?.message ?? '未知错误'}`);
        }
        this.render();
      }).open();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 危险确认(局部小弹窗,不复用 ConfirmModal 是因为回调里要原地重渲染列表)。 */
class ConfirmPurge extends Modal {
  constructor(
    app: App,
    private body: string,
    private onOk: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.body });
    const row = contentEl.createDiv({ cls: 'lgp-name-prompt-row' });
    const okBtn = row.createEl('button', { cls: 'mod-warning', text: '确认' });
    okBtn.addEventListener('click', () => {
      this.close();
      this.onOk();
    });
    const cancelBtn = row.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
