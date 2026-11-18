/**
 * 回收站管理器(思源 trash-dialog.ts 对齐):列出插件回收站条目,支持
 * 恢复(移回原位,同名冲突加「(恢复 …)」后缀)/ 彻底删除 / 清空 / 打开文件夹。
 *
 * 入口:面板工具栏「回收站」(默认收进「更多」菜单)+ 设置页按钮。
 */

import { Modal, Notice, setIcon, type App } from 'obsidian';
import {
  emptyPluginTrash,
  listTrashItems,
  pluginTrashRoot,
  purgeTrashItem,
  restoreFromTrash,
  trashItemName,
  trashTimeText,
} from '../features/trashStore';

export class TrashManagerModal extends Modal {
  /** 回调:有条目被恢复/清空后通知调用方(通常重新扫描挂载面板)。 */
  private readonly onChanged?: () => void;

  constructor(app: App, private vaultBase: string, onChanged?: () => void) {
    super(app);
    this.vaultBase = vaultBase;
    this.onChanged = onChanged;
  }

  onOpen(): void {
    this.contentEl.addClass('lgp-trash-modal');
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '回收站' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: '插件回收站:删除库外文件时按原路径镜像暂存,可一键恢复。系统回收站模式(设置→删除方式)的条目由操作系统管理,不在这里。',
    });

    const barEl = contentEl.createDiv({ cls: 'lgp-trash-modal__bar' });
    const openBtn = barEl.createEl('button', { text: '打开回收站文件夹' });
    openBtn.addEventListener('click', () => {
      const root = pluginTrashRoot(this.vaultBase);
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
    const emptyBtn = barEl.createEl('button', { cls: 'mod-warning', text: '清空回收站' });
    emptyBtn.addEventListener('click', () => {
      const items = listTrashItems(this.vaultBase);
      if (!items.length) {
        new Notice('回收站已是空的');
        return;
      }
      new ConfirmPurge(this.app, `清空回收站:${items.length} 个条目将被彻底删除,此操作不可恢复。`, () => {
        try {
          emptyPluginTrash(this.vaultBase);
          new Notice('回收站已清空');
          this.onChanged?.();
        } catch (e) {
          new Notice(`清空失败:${(e as Error)?.message ?? '未知错误'}`);
        }
        this.render();
      }).open();
    });

    const listEl = contentEl.createDiv({ cls: 'lgp-trash-modal__list' });
    const items = listTrashItems(this.vaultBase);
    if (!items.length) {
      listEl.createDiv({ cls: 'lgp-trash-modal__empty', text: '回收站是空的。' });
      return;
    }
    for (const it of items) {
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
          const r = restoreFromTrash(this.vaultBase, it.id);
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
            purgeTrashItem(this.vaultBase, it.id);
          } catch (e) {
            new Notice(`删除失败:${(e as Error)?.message ?? '未知错误'}`);
          }
          this.render();
        }).open();
      });
    }
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
