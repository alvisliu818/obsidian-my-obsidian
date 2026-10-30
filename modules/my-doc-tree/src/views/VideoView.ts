/**
 * Enhanced video player.
 *
 * 与 ImageView 同一套思路（同状态结构、同 open-with 面板）：Obsidian 自带的
 * 视频预览是一个裸 `<video>`——没有倍速、没有循环、没法在同目录的片子里
 * 前后翻。这里补齐，并且**天生支持库外**：挂载树/任意磁盘路径的视频经
 * Node fs（extFs.readExternalBinary）读进来走 blob URL，库里视频走
 * vault.adapter，两种模式共用一套 UI。
 *
 * 库内视频默认由本插件接管(videoOpenMode,用户 2026-10-30 决策):引导时
 * takeOverExtensions 抢注视频扩展名,Obsidian 点击文件按 {file} state 打开
 * 本视图;设置里可选回原生预览。命令与 file-menu 入口则始终可用。
 *
 * 浏览器解不了的容器（avi/wmv/flv 等）仍列为可打开扩展，但 `<video>` 会
 * 报解码错误——错误态给「用系统程序打开」兜底，文件本身不受影响。
 */

import {
  ItemView,
  Menu,
  Notice,
  TFile,
  setIcon,
  type WorkspaceLeaf,
  type ViewStateResult,
} from 'obsidian';
import type DocTreePlugin from '../main';
import { baseOf, copyExternalFile, dirOf, extOf, readExternalBinary, scanExternal } from '../features/extFs';
import { absolutePath, addOpenWithMenuItems, addOpenWithMenuItemsAt, openWithSystemDefaultAt } from '../features/openWith';
import { pickSavePath } from '../features/systemDialog';
import {
  appendMarkToCompanionNote,
  buildTimestampLink,
  companionNotePath,
  ensureCompanionNote,
  formatTimecode,
  insertIntoActiveNote,
  noticeMark,
  openVaultNote,
  parseTimecodeSubpath,
  readMarksFromNote,
  toExtPath,
  type VideoMarkRow,
} from '../features/videoTimestamps';

export const VIEW_TYPE_VIDEO = 'logseq-video';

/**
 * Extensions this player accepts. The browser-decodable ones play in place;
 * the rest show the error state with a system-open escape hatch. avi/wmv/flv
 * are listed ON PURPOSE: they usually have a system player, and the error
 * message names that route instead of failing silently.
 */
export const VIDEO_EXTENSIONS = [
  'mp4', 'webm', 'ogv', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts',
];

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  ts: 'video/mp2t',
};

/** Chrome 可解码概率高的扩展(错误态只为它们兜底;其余直接提示走系统)。 */
const DECODABLE = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'mpg', 'mpeg', '3gp']);

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.includes(extOf(name));
}

export interface VideoViewState {
  /** Vault-relative path (库内). */
  path?: string;
  /** Vault-relative path too — the key Obsidian's registerExtensions route
   * passes when it opens a vault file by extension ({file}, measured on the
   * ExternalCodeView precedent). Normalized into `path`. */
  file?: string;
  /** Absolute path OUTSIDE the vault (库外). */
  abs?: string;
  /** 打开即跳转的时间点(秒)。时间戳链接点击路由时透传。 */
  t?: number;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export class VideoView extends ItemView {
  plugin: DocTreePlugin;
  private path = '';
  /** 库外绝对路径;与 path 互斥(库外模式下 path 恒为空)。 */
  private abs = '';
  private objectUrl = '';

  private stageEl!: HTMLElement;
  private videoEl!: HTMLVideoElement;
  private toolbarEl!: HTMLElement;
  private fallbackEl: HTMLElement | null = null;
  /** 待生效的 seek:state 带 t 但视频还没加载到可 seek 时先记着。 */
  private pendingSeek: number | null = null;
  /** 标记列表面板(懒建,开合切换)。 */
  private marksEl: HTMLElement | null = null;
  private marksOpen = false;

  constructor(leaf: WorkspaceLeaf, plugin: DocTreePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_VIDEO;
  }

  /** 当前文件名（两种模式统一）。 */
  private get fileName(): string {
    return this.abs ? baseOf(this.abs) : this.path.split('/').pop() || this.path;
  }

  getDisplayText(): string {
    const n = this.fileName;
    return n || '视频播放器';
  }

  getIcon(): string {
    return 'play';
  }

  getState(): Record<string, unknown> {
    return this.abs ? { abs: this.abs } : { path: this.path };
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as VideoViewState;
    const nextAbs = typeof s.abs === 'string' ? s.abs : '';
    // Obsidian 扩展名路由带的是 {file}(库内相对路径),视图自己的 state 用 path。
    const nextPath =
      typeof s.path === 'string' ? s.path : typeof s.file === 'string' ? s.file : '';
    if (typeof s.t === 'number' && Number.isFinite(s.t)) this.pendingSeek = s.t;
    if (nextAbs === this.abs && nextPath === this.path) {
      // 同文件复用(时间戳点击的主要场景):文件不动,只把播放位置拨过去。
      this.applyPendingSeek();
      return;
    }
    this.abs = nextAbs;
    this.path = nextAbs ? '' : nextPath;
    await this.load();
  }

  /**
   * 原生 `[[视频.mp4#t=83]]` 点击路由:Obsidian 的 openFile 会把链接 subpath
   * 作为 ephemeral state 送达视图(mx 同款机制)。
   */
  setEphemeralState(state: unknown): void {
    const subpath = (state as { subpath?: string } | null)?.subpath ?? null;
    const t = parseTimecodeSubpath(subpath);
    if (t !== null) {
      this.pendingSeek = t;
      this.applyPendingSeek();
    }
    super.setEphemeralState(state as never);
  }

  /** 把挂起的 seek 应用到 `<video>`;元数据没就绪就等 loadedmetadata。 */
  private applyPendingSeek(): void {
    if (this.pendingSeek === null || !this.videoEl) return;
    const t = this.pendingSeek;
    this.pendingSeek = null;
    const el = this.videoEl;
    const apply = () => {
      try {
        el.currentTime = t;
      } catch {
        /* 元数据仍不可用:放弃这一次(下次点击会再来) */
      }
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
  }

  /** 跳到指定时刻(暂停态;标记面板/命令共用)。 */
  seekTo(seconds: number): void {
    this.pendingSeek = seconds;
    this.applyPendingSeek();
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lg-video-view');

    this.toolbarEl = this.contentEl.createDiv({ cls: 'lg-video-view__toolbar' });
    this.toolbarEl.createDiv({ cls: 'lg-video-view__title' });

    const playGroup = this.toolbarEl.createDiv({ cls: 'lg-video-view__group' });
    const speedSel = playGroup.createEl('select', { cls: 'lg-video-view__speed' });
    for (const s of SPEEDS) {
      speedSel.createEl('option', { text: `${s}x`, value: String(s) });
    }
    speedSel.value = '1';
    speedSel.addEventListener('change', () => {
      this.videoEl.playbackRate = Number(speedSel.value) || 1;
    });
    speedSel.title = '播放速度';
    const loopBtn = this.iconBtn(playGroup, 'repeat', '循环：关', () => {
      this.videoEl.loop = !this.videoEl.loop;
      loopBtn.toggleClass('is-active', this.videoEl.loop);
      loopBtn.title = `循环：${this.videoEl.loop ? '开' : '关'}`;
    });

    const navGroup = this.toolbarEl.createDiv({ cls: 'lg-video-view__group' });
    this.iconBtn(navGroup, 'chevron-left', '上一个（同目录）', () => void this.step(-1));
    this.iconBtn(navGroup, 'chevron-right', '下一个（同目录）', () => void this.step(1));

    const actGroup = this.toolbarEl.createDiv({ cls: 'lg-video-view__group' });
    this.iconBtn(actGroup, 'camera', '截图到剪贴板', () => void this.snapshot());
    this.iconBtn(actGroup, 'save', '另存为…', () => void this.saveAs());
    this.iconBtn(actGroup, 'external-link', '用外部应用打开', () => this.showOpenWith());
    if (this.plugin.settings.videoTimestampsEnabled) {
      const tsGroup = this.toolbarEl.createDiv({ cls: 'lg-video-view__group' });
      this.iconBtn(tsGroup, 'alarm-clock', '在此时间打时间戳标记(Mod+Shift+M)', () => void this.addTimestampMark());
      this.iconBtn(tsGroup, 'list', '标记列表(伴随笔记)', () => this.toggleMarks());
      this.iconBtn(tsGroup, 'file-text', '打开标记笔记', () => void this.openMarksNote());
    }

    // 标记列表面板:工具栏与画面之间,默认收起。
    this.marksEl = this.contentEl.createDiv({ cls: 'lg-video-view__marks' });
    this.marksEl.style.display = 'none';

    this.stageEl = this.contentEl.createDiv({ cls: 'lg-video-view__stage' });
    this.videoEl = document.createElement('video');
    this.videoEl.className = 'lg-video-view__video';
    this.videoEl.controls = true;
    this.videoEl.preload = 'metadata';
    this.videoEl.addEventListener('error', () => this.showDecodeError());
    this.stageEl.appendChild(this.videoEl);

    await this.load();
  }

  async onClose(): Promise<void> {
    try {
      this.videoEl.pause();
    } catch {
      /* already gone */
    }
    this.releaseUrl();
  }

  private iconBtn(parent: HTMLElement, icon: string, title: string, onClick: () => void): HTMLElement {
    const b = parent.createEl('button', { cls: 'lg-video-view__btn' });
    setIcon(b, icon);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  private releaseUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
  }

  private setTitle(): void {
    const t = this.toolbarEl.querySelector('.lg-video-view__title');
    if (t) t.textContent = this.fileName || '';
  }

  async load(): Promise<void> {
    if (!this.videoEl) return;
    this.releaseUrl();
    this.fallbackEl?.remove();
    this.fallbackEl = null;
    this.setTitle();

    let data: Uint8Array<ArrayBuffer>;
    try {
      // 库内库外统一 Node fs 直读：桌面端库内文件也是真实磁盘文件，
      // vault.adapter 与 fs 读同一份字节，少一条分支就少一类 bug。
      const src = this.abs || this.vaultAbs();
      if (!src) {
        this.videoEl.removeAttribute('src');
        return;
      }
      data = readExternalBinary(src);
    } catch (e) {
      this.videoEl.removeAttribute('src');
      new Notice(`无法读取视频：${String(e).slice(0, 120)}`);
      return;
    }
    const mime = MIME[extOf(this.fileName)] || 'application/octet-stream';
    this.objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
    this.videoEl.src = this.objectUrl;
    // 变更 src 后 load() 让浏览器重新探测;自动尝试播放失败也无妨(controls 在)。
    this.videoEl.load();
    this.applyPendingSeek();
  }

  /** 库内模式的磁盘绝对路径（文件不存在/移动端返回 ''）。 */
  private vaultAbs(): string {
    const file = this.path ? this.app.vault.getAbstractFileByPath(this.path) : null;
    return file instanceof TFile ? absolutePath(this.app, file) : '';
  }

  /** `<video>` 报错(通常是容器/编码解不了):错误态 + 系统打开兜底。 */
  private showDecodeError(): void {
    if (this.fallbackEl || !this.fileName) return;
    this.fallbackEl = this.stageEl.createDiv({ cls: 'lg-video-view__fallback' });
    this.fallbackEl.createDiv({
      cls: 'lg-video-view__fallback-text',
      text: DECODABLE.has(extOf(this.fileName))
        ? '无法播放这个视频（文件可能损坏或编码不受支持）。'
        : '浏览器解不了这个容器格式（avi/wmv/flv 常见），请用系统播放器打开。',
    });
    const row = this.fallbackEl.createDiv({ cls: 'lg-video-view__fallback-actions' });
    const b = row.createEl('button', { text: '用系统程序打开' });
    b.addEventListener('click', () => {
      const abs = this.abs || this.vaultAbs();
      if (abs) void openWithSystemDefaultAt(abs);
    });
  }

  /** Video files in the same folder, sorted — the prev/next ring. */
  private siblings(): string[] {
    if (this.abs) {
      const dir = dirOf(this.abs);
      if (!dir) return [];
      const { entries } = scanExternal(dir, {
        shouldEnterDir: () => false,
        keepFile: (_rel, name) => isVideoFile(name),
      });
      return entries
        .map((e) => e.abs)
        .sort((a, b) => baseOf(a).localeCompare(baseOf(b), undefined, { numeric: true }));
    }
    const file = this.path ? this.app.vault.getAbstractFileByPath(this.path) : null;
    if (!(file instanceof TFile) || !file.parent) return [];
    return file.parent.children
      .filter((c): c is TFile => c instanceof TFile && isVideoFile(c.name))
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
      this.plugin.refreshVideoViewTitles();
    }
  }

  /** 把当前帧画进 canvas 并写入剪贴板（blob URL 同源,画布不会被污染）。 */
  private async snapshot(): Promise<void> {
    if (!this.videoEl.videoWidth) {
      new Notice('还没有可截取的画面（视频未加载）。');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = this.videoEl.videoWidth;
      canvas.height = this.videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d 不可用');
      ctx.drawImage(this.videoEl, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('编码 PNG 失败');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      new Notice('截图已复制到剪贴板');
    } catch (e) {
      new Notice(`截图失败：${String(e).slice(0, 120)}`);
    }
  }

  private async saveAs(): Promise<void> {
    const src = this.abs ? this.abs : this.vaultAbs();
    if (!src) return;
    const target = await pickSavePath({
      title: '视频另存为',
      defaultName: this.fileName,
      filters: [{ name: '视频', extensions: VIDEO_EXTENSIONS }],
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
      const file = this.path ? this.app.vault.getAbstractFileByPath(this.path) : null;
      if (!(file instanceof TFile)) return;
      addOpenWithMenuItems(this.plugin.app, file, menu, this.plugin.settings.openWithApps);
    }
    menu.showAtPosition({ x: this.toolbarEl.getBoundingClientRect().left, y: this.toolbarEl.getBoundingClientRect().bottom });
  }

  // ------------------------------------------------------------------
  // 时间戳标记(2026-10-30):打标记 → markdown → 点击回跳;伴随笔记 = 反向列表
  // ------------------------------------------------------------------

  /** 当前视频对应的库内 TFile(库外模式为 null)。 */
  private vaultVideoFile(): TFile | null {
    if (!this.path) return null;
    const f = this.app.vault.getAbstractFileByPath(this.path);
    return f instanceof TFile ? f : null;
  }

  /**
   * 打标记:取当前播放位置生成时间戳链接,优先写进当前活动的笔记光标处;
   * 没有活动笔记就落伴随笔记(`<videoMarksFolder>/<视频名>.md`)。
   */
  async addTimestampMark(): Promise<void> {
    if (!this.plugin.settings.videoTimestampsEnabled) {
      new Notice('视频时间戳功能已在设置里关闭。');
      return;
    }
    const seconds = this.videoEl?.currentTime;
    if (!seconds || Number.isNaN(seconds)) {
      new Notice('视频还没有播放位置(未加载)。');
      return;
    }
    const videoFile = this.vaultVideoFile();
    if (!videoFile && !this.abs) return;

    const folder = this.plugin.settings.videoMarksFolder || 'Video Marks';
    // 活动笔记优先:链接的相对路径计算需要落笔笔记的路径。
    const activePath = this.app.workspace.activeEditor?.file?.path ?? null;
    if (activePath) {
      const link = buildTimestampLink(this.app, videoFile
        ? { videoFile, notePath: activePath, seconds }
        : { videoAbs: this.abs, notePath: activePath, seconds });
      if (insertIntoActiveNote(this.app, link)) {
        noticeMark(`已插入时间戳 ${formatTimecode(seconds)} → ${activePath.split('/').pop()}`);
        return;
      }
    }
    // 无活动笔记 → 伴随笔记。
    const notePath = companionNotePath(folder, this.fileName);
    const link = buildTimestampLink(this.app, videoFile
      ? { videoFile, notePath, seconds }
      : { videoAbs: this.abs, notePath, seconds });
    const saved = await appendMarkToCompanionNote(this.app, {
      folder,
      videoName: this.fileName,
      line: `${link} `,
      linkTargetForHeader: videoFile ? null : toExtPath(this.abs),
    });
    noticeMark(`已写入标记 ${formatTimecode(seconds)} → ${saved.split('/').pop()}`);
    if (this.marksOpen) void this.refreshMarks();
  }

  /** 打开(必要时创建)伴随笔记。 */
  async openMarksNote(): Promise<void> {
    const folder = this.plugin.settings.videoMarksFolder || 'Video Marks';
    const videoFile = this.vaultVideoFile();
    const path = await ensureCompanionNote(this.app, {
      folder,
      videoName: this.fileName,
      linkTargetForHeader: videoFile ? null : toExtPath(this.abs),
    });
    await openVaultNote(this.app, path);
  }

  private toggleMarks(): void {
    this.marksOpen = !this.marksOpen;
    if (!this.marksEl) return;
    this.marksEl.style.display = this.marksOpen ? 'block' : 'none';
    if (this.marksOpen) void this.refreshMarks();
  }

  /** 重新渲染标记列表(读伴随笔记)。 */
  private async refreshMarks(): Promise<void> {
    const panel = this.marksEl;
    if (!panel) return;
    const folder = this.plugin.settings.videoMarksFolder || 'Video Marks';
    const notePath = companionNotePath(folder, this.fileName);
    let rows: VideoMarkRow[] = [];
    try {
      rows = await readMarksFromNote(this.app, notePath);
    } catch {
      rows = [];
    }
    panel.empty();
    const head = panel.createDiv({ cls: 'lg-video-view__marks-head' });
    head.createSpan({ cls: 'lg-video-view__marks-title', text: `标记(${rows.length})` });
    const refreshBtn = head.createEl('button', { cls: 'lg-video-view__btn' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.title = '重新读取';
    refreshBtn.addEventListener('click', () => void this.refreshMarks());
    const openBtn = head.createEl('button', { cls: 'lg-video-view__btn' });
    setIcon(openBtn, 'file-text');
    openBtn.title = '打开标记笔记';
    openBtn.addEventListener('click', () => void this.openMarksNote());

    if (rows.length === 0) {
      panel.createDiv({
        cls: 'lg-video-view__marks-empty',
        text: '还没有标记。按 Mod+Shift+M(或工具栏闹钟按钮)在当前时间打标记;打开其他笔记时标记会插入光标处。',
      });
      return;
    }
    const list = panel.createDiv({ cls: 'lg-video-view__marks-list' });
    for (const row of rows) {
      const item = list.createDiv({ cls: 'lg-video-view__marks-row' });
      const timeEl = item.createSpan({ cls: 'lg-video-view__marks-time', text: row.label });
      timeEl.addEventListener('click', () => {
        this.seekTo(row.seconds);
        noticeMark(`跳到 ${row.label}`);
      });
      item.createSpan({ cls: 'lg-video-view__marks-note', text: row.note || '' });
    }
  }
}
