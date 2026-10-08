/**
 * Enhanced image viewer.
 *
 * Ported from `siyuan-editor/src/tabs/image-tab.ts`. Obsidian's built-in image
 * preview is a bare `<img>`: no zoom controls, no rotation, no way to walk the
 * rest of the folder. This adds all of that.
 *
 * It is NOT registered as the default handler for image extensions by default —
 * take-over is a setting (`imageViewerTakeOver`), because replacing the native
 * preview for every image in a vault is a bigger change than most people want
 * from a Logseq-flavoured editor. The command and the file-menu entry work
 * either way.
 */

import {
  ItemView,
  Menu,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  setIcon,
  type App,
  type WorkspaceLeaf,
  type ViewStateResult,
} from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { extOf } from '../features/extFs';
import { addOpenWithMenuItems, revealInSystemExplorer } from '../features/openWith';

export const VIEW_TYPE_IMAGE = 'logseq-image';

/** Extensions this viewer can display. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'];

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(extOf(name));
}

export interface ImageViewState {
  path?: string;
}

export class ImageView extends ItemView {
  plugin: LogseqEditorPlugin;
  private path = '';
  private objectUrl = '';
  /** Current zoom factor (1 = natural size). */
  private zoom = 1;
  private rotation = 0;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private naturalW = 0;
  private naturalH = 0;
  /** Fit-to-window mode: zoom is derived from the container instead. */
  private fitted = true;

  private stageEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private toolbarEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_IMAGE;
  }

  getDisplayText(): string {
    return this.path ? this.path.split('/').pop() || this.path : '图片查看器';
  }

  getIcon(): string {
    return 'image';
  }

  getState(): Record<string, unknown> {
    return { path: this.path };
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as ImageViewState;
    const next = typeof s.path === 'string' ? s.path : '';
    if (next !== this.path) {
      this.path = next;
      await this.load();
    }
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lg-image-view');

    this.toolbarEl = this.contentEl.createDiv({ cls: 'lg-image-view__toolbar' });
    this.titleEl = this.toolbarEl.createDiv({ cls: 'lg-image-view__title' });

    const zoomGroup = this.toolbarEl.createDiv({ cls: 'lg-image-view__group' });
    this.zoomLabelEl = zoomGroup.createEl('span', { cls: 'lg-image-view__zoom' });
    this.iconBtn(zoomGroup, 'zoom-out', '缩小', () => this.zoomBy(-0.1));
    this.iconBtn(zoomGroup, 'zoom-in', '放大', () => this.zoomBy(0.1));
    this.iconBtn(zoomGroup, 'maximize', '适应窗口', () => this.fitToWindow());
    this.iconBtn(zoomGroup, 'rotate-cw', '旋转 90°', () => {
      this.rotation = (this.rotation + 90) % 360;
      this.applyTransform();
    });

    const navGroup = this.toolbarEl.createDiv({ cls: 'lg-image-view__group' });
    this.iconBtn(navGroup, 'chevron-left', '上一张（同目录）', () => void this.step(-1));
    this.iconBtn(navGroup, 'chevron-right', '下一张（同目录）', () => void this.step(1));

    const actGroup = this.toolbarEl.createDiv({ cls: 'lg-image-view__group' });
    this.iconBtn(actGroup, 'clipboard-copy', '复制图片', () => void this.copyImage());
    this.iconBtn(actGroup, 'save', '另存为…', () => this.saveAs());
    this.iconBtn(actGroup, 'external-link', '用外部应用打开', () => this.showOpenWith());

    this.stageEl = this.contentEl.createDiv({ cls: 'lg-image-view__stage' });
    this.imgEl = document.createElement('img');
    this.imgEl.className = 'lg-image-view__img';
    this.imgEl.draggable = false;
    this.stageEl.appendChild(this.imgEl);

    this.bindInteractions();
    await this.load();
  }

  async onClose(): Promise<void> {
    this.releaseUrl();
  }

  onResize(): void {
    if (this.fitted) this.fitToWindow();
  }

  private iconBtn(parent: HTMLElement, icon: string, title: string, onClick: () => void): void {
    const b = parent.createEl('button', { cls: 'lg-image-view__btn' });
    setIcon(b, icon);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
  }

  private releaseUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
  }

  private bindInteractions(): void {
    // Wheel zoom anchored at the pointer, like every image viewer.
    this.stageEl.addEventListener(
      'wheel',
      (e) => {
        if (!this.objectUrl) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        this.setZoom(this.zoom * factor);
      },
      { passive: false },
    );

    // Double click toggles between 100% and fit.
    this.stageEl.addEventListener('dblclick', () => {
      if (this.fitted) this.setZoom(1);
      else this.fitToWindow();
    });

    this.imgEl.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.dragStartX = e.clientX - this.panX;
      this.dragStartY = e.clientY - this.panY;
      this.imgEl.addClass('is-dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.panX = e.clientX - this.dragStartX;
      this.panY = e.clientY - this.dragStartY;
      this.applyTransform();
    });
    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.imgEl.removeClass('is-dragging');
    });
  }

  async load(): Promise<void> {
    if (!this.imgEl) return;
    this.releaseUrl();
    this.zoom = 1;
    this.rotation = 0;
    this.panX = 0;
    this.panY = 0;
    this.fitted = true;

    const file = this.path ? this.app.vault.getAbstractFileByPath(this.path) : null;
    if (!(file instanceof TFile)) {
      this.titleEl.textContent = this.path || '未选择图片';
      this.imgEl.removeAttribute('src');
      return;
    }
    this.titleEl.textContent = file.name;

    try {
      const data = await this.app.vault.adapter.readBinary(file.path);
      const mime = MIME[extOf(file.name)] || 'application/octet-stream';
      this.objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
      this.imgEl.src = this.objectUrl;
      this.imgEl.onload = () => {
        this.naturalW = this.imgEl.naturalWidth;
        this.naturalH = this.imgEl.naturalHeight;
        this.fitToWindow();
      };
    } catch (e) {
      new Notice(`无法读取图片：${String(e)}`);
    }
  }

  private applyTransform(): void {
    this.imgEl.style.transform = `translate(${this.panX}px, ${this.panY}px) rotate(${this.rotation}deg) scale(${this.zoom})`;
    this.zoomLabelEl.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private setZoom(z: number): void {
    this.zoom = Math.min(20, Math.max(0.05, z));
    this.fitted = false;
    this.applyTransform();
  }

  private zoomBy(delta: number): void {
    this.setZoom(this.zoom + delta);
  }

  private fitToWindow(): void {
    const box = this.stageEl.getBoundingClientRect();
    if (!this.naturalW || !this.naturalH || box.width <= 0) {
      this.applyTransform();
      return;
    }
    // Rotating by 90°/270° swaps the effective aspect ratio.
    const swap = this.rotation % 180 !== 0;
    const w = swap ? this.naturalH : this.naturalW;
    const h = swap ? this.naturalW : this.naturalH;
    this.zoom = Math.min(box.width / w, box.height / h);
    this.fitted = true;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
  }

  /** Image files in the same folder, sorted — the prev/next ring. */
  private siblings(): TFile[] {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile) || !file.parent) return [];
    return file.parent.children
      .filter((c): c is TFile => c instanceof TFile && isImageFile(c.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  private async step(dir: -1 | 1): Promise<void> {
    const list = this.siblings();
    if (list.length === 0) return;
    const i = list.findIndex((f) => f.path === this.path);
    const next = list[(i + dir + list.length) % list.length];
    if (next && next.path !== this.path) {
      this.path = next.path;
      await this.load();
      this.plugin.refreshImageViewTitles();
    }
  }

  private async copyImage(): Promise<void> {
    if (!this.objectUrl) return;
    try {
      const blob = await fetch(this.objectUrl).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      new Notice('图片已复制到剪贴板');
    } catch (e) {
      // Chrome refuses ClipboardItem for some MIME types (notably image/avif),
      // so fall back to copying the markdown embed — still useful.
      try {
        await navigator.clipboard.writeText(`![[${this.path.split('/').pop()}]]`);
        new Notice('已复制为 Obsidian 嵌入语法');
      } catch {
        new Notice(`复制失败：${String(e)}`);
      }
    }
  }

  private saveAs(): void {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    new SaveAsModal(this.app, file.name, async (target) => {
      try {
        const data = await this.app.vault.adapter.readBinary(file.path);
        await this.app.vault.adapter.writeBinary(target, data);
        new Notice(`已保存到 ${target}`);
      } catch (e) {
        new Notice(`保存失败：${String(e)}`);
      }
    }).open();
  }

  private showOpenWith(): void {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    const menu = new Menu();
    addOpenWithMenuItems(this.plugin.app, file, menu, this.plugin.settings.openWithApps);
    menu.showAtPosition({ x: this.toolbarEl.getBoundingClientRect().left, y: this.toolbarEl.getBoundingClientRect().bottom });
  }

  /** Context menu hook used by the file explorer integration. */
  static reveal(app: App, file: TFile): void {
    revealInSystemExplorer(app, file);
  }
}

class SaveAsModal extends Modal {
  private name: string;
  private onOk: (path: string) => void;

  constructor(app: App, initial: string, onOk: (path: string) => void) {
    super(app);
    this.name = initial;
    this.onOk = onOk;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '另存为' });
    let value = this.name;
    new Setting(contentEl).setName('文件名').addText((t) =>
      t
        .setValue(this.name)
        .onChange((v) => {
          value = v.trim();
        }),
    );
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('保存').setCta().onClick(() => {
          if (!value) {
            new Notice('请输入文件名');
            return;
          }
          this.close();
          this.onOk(value);
        }),
      )
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Files (not folders) under a folder, used by the file-menu integration. */
export function firstImageIn(folder: TFolder): TFile | null {
  for (const c of folder.children) {
    if (c instanceof TFile && isImageFile(c.name)) return c;
  }
  return null;
}
