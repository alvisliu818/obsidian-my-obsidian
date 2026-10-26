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
  Notice,
  TFile,
  TFolder,
  setIcon,
  type App,
  type WorkspaceLeaf,
  type ViewStateResult,
} from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { baseOf, copyExternalFile, dirOf, extOf, readExternalBinary, scanExternal } from '../features/extFs';
import {
  absolutePath,
  addOpenWithMenuItems,
  addOpenWithMenuItemsAt,
  revealInSystemExplorer,
} from '../features/openWith';
import { pickSavePath } from '../features/systemDialog';

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
  /** Vault-relative path (库内). */
  path?: string;
  /** Absolute path OUTSIDE the vault (库外,挂载树/任意磁盘位置). */
  abs?: string;
}

export class ImageView extends ItemView {
  plugin: LogseqEditorPlugin;
  private path = '';
  /** 库外绝对路径;与 path 互斥(库外模式下 path 恒为空)。 */
  private abs = '';
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
  // titleEl: 基类 View 自带 public titleEl（obsidian ^1.14 typings），直接用
  private zoomLabelEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_IMAGE;
  }

  /** 当前文件名（两种模式统一）。 */
  private get fileName(): string {
    return this.abs ? baseOf(this.abs) : this.path.split('/').pop() || this.path;
  }

  getDisplayText(): string {
    const n = this.fileName;
    return n || '图片查看器';
  }

  getIcon(): string {
    return 'image';
  }

  getState(): Record<string, unknown> {
    return this.abs ? { abs: this.abs } : { path: this.path };
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as ImageViewState;
    const nextAbs = typeof s.abs === 'string' ? s.abs : '';
    const nextPath = typeof s.path === 'string' ? s.path : '';
    if (nextAbs === this.abs && nextPath === this.path) return;
    this.abs = nextAbs;
    this.path = nextAbs ? '' : nextPath;
    await this.load();
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

    // 库外模式：abs 优先，Node fs 直读（vault.adapter 会把绝对路径解析成
    // `<库根>\E:\...`，见 extFs.ts 文件头）。
    if (this.abs) {
      this.titleEl.textContent = baseOf(this.abs);
      try {
        const data = readExternalBinary(this.abs);
        const mime = MIME[extOf(baseOf(this.abs))] || 'application/octet-stream';
        this.objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
        this.imgEl.src = this.objectUrl;
        this.imgEl.onload = () => {
          this.naturalW = this.imgEl.naturalWidth;
          this.naturalH = this.imgEl.naturalHeight;
          this.fitToWindow();
        };
      } catch (e) {
        this.imgEl.removeAttribute('src');
        new Notice(`无法读取图片：${String(e).slice(0, 120)}`);
      }
      return;
    }

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

  /** Image files in the same folder, sorted — the prev/next ring. 库外时是同目录的绝对路径列表。 */
  private siblings(): string[] {
    if (this.abs) {
      const dir = dirOf(this.abs);
      if (!dir) return [];
      // shouldEnterDir=false: 只列本层,不递归(同目录导航语义)。
      const { entries } = scanExternal(dir, {
        shouldEnterDir: () => false,
        keepFile: (_rel, name) => isImageFile(name),
      });
      return entries
        .map((e) => e.abs)
        .sort((a, b) => baseOf(a).localeCompare(baseOf(b), undefined, { numeric: true }));
    }
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile) || !file.parent) return [];
    return file.parent.children
      .filter((c): c is TFile => c instanceof TFile && isImageFile(c.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => f.path);
  }

  private async step(dir: -1 | 1): Promise<void> {
    const list = this.siblings();
    if (list.length === 0) return;
    const cur = this.abs || this.path;
    const i = list.indexOf(cur);
    const next = list[(i + dir + list.length) % list.length];
    if (next && next !== cur) {
      if (this.abs) this.abs = next;
      else this.path = next;
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
      // so fall back to copying a reference — still useful.
      try {
        const text = this.abs || `![[${this.path.split('/').pop()}]]`;
        await navigator.clipboard.writeText(text);
        new Notice('已复制图片引用');
      } catch {
        new Notice(`复制失败：${String(e)}`);
      }
    }
  }

  private async saveAs(): Promise<void> {
    // 两种模式统一走系统保存对话框 + Node fs 二进制复制：库内文件在桌面端
    // 也是真实磁盘文件（vault.adapter 只在移动端不是）。
    const src = this.abs
      ? this.abs
      : (() => {
          const file = this.app.vault.getAbstractFileByPath(this.path);
          return file instanceof TFile ? absolutePath(this.app, file) : '';
        })();
    if (!src) return;
    const target = await pickSavePath({
      title: '图片另存为',
      defaultName: this.fileName,
      filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
    });
    if (!target) return;
    const r = copyExternalFile(src, target);
    if (r.ok) new Notice(`已保存到 ${target}`);
    else new Notice(`保存失败：${r.error ?? ''}`);
  }

  private showOpenWith(): void {
    const menu = new Menu();
    if (this.abs) {
      addOpenWithMenuItemsAt(this.abs, menu, this.plugin.settings.openWithApps);
    } else {
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (!(file instanceof TFile)) return;
      addOpenWithMenuItems(this.plugin.app, file, menu, this.plugin.settings.openWithApps);
    }
    menu.showAtPosition({ x: this.toolbarEl.getBoundingClientRect().left, y: this.toolbarEl.getBoundingClientRect().bottom });
  }

  /** Context menu hook used by the file explorer integration. */
  static reveal(app: App, file: TFile): void {
    revealInSystemExplorer(app, file);
  }
}

/** Files (not folders) under a folder, used by the file-menu integration. */
export function firstImageIn(folder: TFolder): TFile | null {
  for (const c of folder.children) {
    if (c instanceof TFile && isImageFile(c.name)) return c;
  }
  return null;
}
