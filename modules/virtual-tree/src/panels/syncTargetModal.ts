/**
 * 「同步到库」的目标选择：库内文件夹 + 链接名。
 *
 * 只选库内文件夹，不接受手输路径——库内相对路径的合法性由选择器保证，
 * 免得把一个绝对路径或 `../` 拼进 mklink 的参数里。链接名走
 * `validateEntryName`（Windows 非法字符那套规则），与树上的新建/重命名一致。
 *
 * 本文件故意不 import `features/syncToVault`（那边 import 本文件）：UI 只
 * 依赖 obsidian + extFs，纯逻辑留在服务里可单测。
 */

import { FuzzySuggestModal, Modal, TFolder, type App } from 'obsidian';
import { safeSegment, validateEntryName } from '../features/extFs';

/** 选中的库内文件夹：`folder` 是相对路径，库根为 ''。 */
export interface VaultFolderPick {
  folder: string;
  name: string;
}

/** 库内文件夹选择器（含库根那一行）。 */
export class VaultFolderPickModal extends FuzzySuggestModal<TFolder> {
  private readonly onPick: (p: VaultFolderPick) => void;

  constructor(app: App, opts: { title?: string; onPick: (p: VaultFolderPick) => void }) {
    super(app);
    this.onPick = opts.onPick;
    this.setPlaceholder('搜索库内文件夹…');
    if (opts.title) this.titleEl.setText(opts.title);
  }

  getItems(): TFolder[] {
    const root = this.app.vault.getRoot();
    const out: TFolder[] = [root];
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFolder) {
          out.push(child);
          walk(child);
        }
      }
    };
    walk(root);
    return out;
  }

  getItemText(f: TFolder): string {
    return f.path === '/' ? '/（库根）' : `${f.path}/`;
  }

  onChooseItem(f: TFolder): void {
    this.onPick({
      folder: f.path === '/' ? '' : f.path.replace(/^\/+/, '').replace(/\/+$/, ''),
      name: f.path === '/' ? '库根' : f.name,
    });
  }
}

/** 「每次选择目录」模式下的一次性弹窗。 */
export interface SyncTargetPick {
  folder: string;
  name: string;
}

export class SyncTargetModal extends Modal {
  private folder: string;
  private name: string;
  private readonly isDir: boolean;
  private readonly onSubmit: (p: SyncTargetPick) => void;
  private folderLabel: HTMLElement | null = null;

  constructor(
    app: App,
    opts: { initialFolder: string; initialName: string; isDir: boolean; onSubmit: (p: SyncTargetPick) => void },
  ) {
    super(app);
    this.folder = opts.initialFolder || '';
    this.name = safeSegment(opts.initialName) || 'mount';
    this.isDir = opts.isDir;
    this.onSubmit = opts.onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText('同步到库');
    const { contentEl } = this;
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        `用 mklink 把${this.isDir ? '文件夹' : '文件'}链接进库：` +
        `${this.isDir ? '文件夹用目录联接 /J（可跨盘）' : '同盘文件用硬链接 /H，跨盘文件用符号链接'}。` +
        '链接指向原路径，编辑库内副本即编辑外部文件；取消同步只删链接，不动源文件。',
    });

    const folderRow = contentEl.createDiv({ cls: 'lgp-sync-row' });
    folderRow.createSpan({ text: '目标文件夹：' });
    this.folderLabel = folderRow.createSpan({ text: this.folder || '/（库根）' });
    const pickBtn = folderRow.createEl('button', { text: '选择文件夹…' });
    pickBtn.addEventListener('click', () => {
      new VaultFolderPickModal(this.app, {
        title: '选择库内目标文件夹',
        onPick: (p) => {
          this.folder = p.folder;
          if (this.folderLabel) this.folderLabel.textContent = p.folder || '/（库根）';
        },
      }).open();
    });

    const nameRow = contentEl.createDiv({ cls: 'lgp-sync-row' });
    nameRow.createSpan({ text: '链接名：' });
    const nameInput = nameRow.createEl('input', { type: 'text', attr: { spellcheck: 'false' } });
    nameInput.value = this.name;
    nameInput.select();

    const errEl = contentEl.createDiv({ cls: 'setting-item-description' });
    errEl.style.display = 'none';

    const commit = (): void => {
      const name = nameInput.value.trim();
      const bad = validateEntryName(name);
      if (bad) {
        errEl.textContent = bad;
        errEl.style.display = '';
        return;
      }
      this.close();
      this.onSubmit({ folder: this.folder, name: safeSegment(name) });
    };

    const btnRow = contentEl.createDiv({ cls: 'lgp-sync-row' });
    btnRow.createEl('button', { cls: 'mod-cta', text: '同步' }).addEventListener('click', commit);
    btnRow.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit();
    });
  }
}
