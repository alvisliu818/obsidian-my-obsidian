/**
 * 虚拟文档树 (virtual document tree) — mounts outside the vault.
 *
 * Owns: the mount panel tree, the extFs layer for out-of-vault files, the
 * image / video / office viewers, the "open with" system menu, and the
 * ROUTING of an out-of-vault file click to the right editor (openExternalEntry).
 *
 * 2026-10-27 module split: this surface used to live in the logseq module's
 * main.ts. The editors themselves stay in higher layers and register here as
 * openers (see openers.ts) — logseq owns the markdown/block-editor routes,
 * the code-editor module owns the code route. doc-tree is the bottom layer
 * and imports neither of them; cross-module contact runs through the app's
 * plugin table (legacy alias ids), never through static imports.
 */

import { Notice, Platform, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { DocTreeSettingTab } from './settings/tab';
import { MountPanelView, VIEW_TYPE_MOUNT_PANEL } from './panels/mountPanel';
import { MountEditorModal, MountListModal, MountPositionModal } from './panels/mountModals';
import { ImageView, VIEW_TYPE_IMAGE, IMAGE_EXTENSIONS, isImageFile } from './views/ImageView';
import { VideoView, VIEW_TYPE_VIDEO, VIDEO_EXTENSIONS, isVideoFile } from './views/VideoView';
import { OfficeView, VIEW_TYPE_OFFICE } from './views/OfficeView';
import { OFFICE_EXTENSIONS } from './office/types';
import { registerFreeExtensions } from '../../../src/extensionRegistry';
import { pickExternalPath } from './features/systemDialog';
import { openWithSystemDefault, revealInSystemExplorer } from './features/openWith';
import {
  exists,
  linkTargetFor,
  linkVaultPath,
  readExternalText,
  safeSegment,
  sameVolume,
  scanExternal,
} from './features/extFs';
import {
  compileFilter,
  extOfName,
  isMarkdownFile,
  isTextFileName,
  type MountNode,
  type ScanEntry,
} from './features/mountFilter';
import { applyMarkedTabIcons, markLeafTabIcon } from './features/tabIcon';
import { ICON_THEME_CHANGED_EVENT } from './extensions/iconThemeLoader';
import {
  DEFAULT_DOCTREE_SETTINGS,
  docTreeSettingsFrom,
  editorChoiceFromExternalText,
  mountDisplayName,
  mountHostOf,
  type DocTreeSettings,
  type EditorChoice,
  type ExternalMount,
} from './types';
import { runOpeners, type OpenerCtx } from './openers';

/** The id this instance is re-published under in the app's plugin table. */
export const DOC_TREE_ALIAS_ID = 'obsidian-doc-tree';

/**
 * Look up the live doc-tree module (or null when it is disabled).
 *
 * Runtime lookup on purpose: higher layers (logseq, code-editor) use this to
 * reach the routing surface and the mount settings without a static import —
 * the layering rule (doc-tree imports nothing above it) survives because this
 * is an app-registry read, resolved at runtime.
 */
export function docTreeOf(app: unknown): DocTreePlugin | null {
  const table = (app as { plugins?: { plugins?: Record<string, unknown> } } | null | undefined)?.plugins
    ?.plugins;
  const hit = table?.[DOC_TREE_ALIAS_ID];
  return (hit as DocTreePlugin | undefined) ?? null;
}

export default class DocTreePlugin extends Plugin {
  settings: DocTreeSettings = DEFAULT_DOCTREE_SETTINGS;

  /** Timer id for the mount panel's optional auto-refresh; 0 = not scheduled. */
  private mountRefreshTimer = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new DocTreeSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_MOUNT_PANEL, (leaf) => new MountPanelView(leaf, this));
    this.registerView(VIEW_TYPE_IMAGE, (leaf) => new ImageView(leaf, this));
    this.registerView(VIEW_TYPE_OFFICE, (leaf) => new OfficeView(leaf, this));
    this.registerView(VIEW_TYPE_VIDEO, (leaf) => new VideoView(leaf, this));

    // Hand Office files to the previewer. Obsidian has no viewer for these at
    // all (it offers "open in default app" and nothing else), so taking the
    // extension costs nothing and gains an in-app read path.
    // 走 registerFreeExtensions:registerExtensions 整批原子,一个已占用扩展名
    // (核心的、别的插件的、或本插件宿主随后要注册的)就会整体抛异常打死
    // onload。跳过已占用项 + 兜底,详见 extensionRegistry.ts。
    if (this.settings.officeViewerEnabled) {
      registerFreeExtensions(this, OFFICE_EXTENSIONS, VIEW_TYPE_OFFICE, 'office viewer');
    }
    // Images are different: Obsidian already previews them, so this is opt-in.
    // svg 之类核心已占用,同样靠 registerFreeExtensions 跳过。
    if (this.settings.imageViewerTakeOver) {
      registerFreeExtensions(this, IMAGE_EXTENSIONS, VIEW_TYPE_IMAGE, 'image viewer');
    }
    // Videos: same opt-in story (Obsidian previews bare <video>); enhanced
    // player = speed / loop / same-folder navigation. mkv 之类核心未占用;
    // mp4 等被占用时靠 registerFreeExtensions 跳过。
    if (this.settings.videoPlayerTakeOver) {
      registerFreeExtensions(this, VIDEO_EXTENSIONS, VIEW_TYPE_VIDEO, 'video player');
    }

    // 图标主题就绪/切换 → 挂载面板行内图标重绘（iconForEntry 每次渲染时查询）
    // 自定义事件不走 registerDomEvent（其重载只收已知事件名），register 兜底注销。
    const onIconThemeChanged = () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOUNT_PANEL)) {
        (leaf.view as MountPanelView).render();
      }
    };
    window.addEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged);
    this.register(() => window.removeEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged));

    // ---------- Commands ----------
    this.addCommand({
      id: 'open-mount-panel',
      name: 'Open the mount panel (folders outside the vault)',
      callback: () => void this.activatePanel(VIEW_TYPE_MOUNT_PANEL),
    });
    this.addCommand({
      id: 'add-external-mount',
      name: 'Mount an external folder',
      callback: () => this.promptAddMount(),
    });
    this.addCommand({
      id: 'manage-external-mounts',
      name: 'Manage external mounts',
      callback: () => new MountListModal(this).open(),
    });
    this.addCommand({
      id: 'refresh-external-mounts',
      name: 'Rescan external mounts',
      callback: () => this.refreshMounts(),
    });

    // ---------- 库外媒体:任意磁盘路径的图片/视频,系统文件选择器 ----------
    // 不限于挂载目录:picker 直达盘上任何位置,选中即开增强查看器。
    const openExternalMedia = async (kind: 'image' | 'video'): Promise<void> => {
      const exts = kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
      const picked = await pickExternalPath({
        kind: 'file',
        title: kind === 'image' ? '选择要打开的图片' : '选择要打开的视频',
        filters: [{ name: kind === 'image' ? '图片' : '视频', extensions: exts }],
      });
      if (!picked) return;
      if (kind === 'image' && !isImageFile(picked)) {
        new Notice('所选文件不是可显示的图片格式。');
        return;
      }
      if (kind === 'video' && !isVideoFile(picked)) {
        new Notice('所选文件不是支持的视频格式。');
        return;
      }
      await this.openExternalInView(kind === 'image' ? VIEW_TYPE_IMAGE : VIEW_TYPE_VIDEO, {
        abs: picked,
        name: picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? picked,
      });
    };
    this.addCommand({
      id: 'open-external-image',
      name: '打开库外图片…（任意磁盘路径）',
      callback: () => void openExternalMedia('image'),
    });
    this.addCommand({
      id: 'open-external-video',
      name: '打开库外视频…（任意磁盘路径）',
      callback: () => void openExternalMedia('video'),
    });

    // ---------- External applications ----------
    // 系统打开/资源管理器定位是**文件域**能力（doc-tree 的 openWith 层），
    // 命令对当前活动文件生效——库内文件同样可用，所以命令留在模块内，
    // 而 logseq 的库内右键菜单直接复用这里的函数。
    this.addCommand({
      id: 'open-with-system-default',
      name: 'Open the current file with its system default app',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        void openWithSystemDefault(this.app, file);
        return true;
      },
    });
    this.addCommand({
      id: 'reveal-in-explorer',
      name: 'Reveal the current file in the system file manager',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        revealInSystemExplorer(this.app, file);
        return true;
      },
    });
  }

  onunload(): void {
    if (this.mountRefreshTimer) {
      window.clearInterval(this.mountRefreshTimer);
      this.mountRefreshTimer = 0;
    }
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Record<string, unknown> | null;
    this.settings = docTreeSettingsFrom(raw);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ------------------------------------------------------------------
  // Operation log forwarding (runtime, no static import of logseq)
  // ------------------------------------------------------------------

  /**
   * Forward an operation record to the logseq module's operation log, where
   * the JSONL trail and the viewer modal live. Runtime lookup through the
   * plugin table: doc-tree boots before logseq and must not import it; when
   * logseq is disabled the record is dropped (logging never breaks the caller).
   */
  logOp(op: string, file: string, status: 'ok' | 'error' | 'skip', detail = ''): void {
    try {
      const lg = (
        this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }
      ).plugins?.plugins?.['obsidian-logseq'] as
        | { logOpPublic?: (op: string, file: string, status: 'ok' | 'error' | 'skip', detail?: string) => void }
        | undefined;
      lg?.logOpPublic?.(op, file, status, detail);
    } catch {
      /* logging must never break the caller */
    }
  }

  // ------------------------------------------------------------------
  // Mount CRUD (the panel and the modals drive these)
  // ------------------------------------------------------------------

  /** The vault's own root path — where links get created. */
  vaultBasePath(): string {
    const adapter = this.app.vault.adapter as unknown as {
      basePath?: string;
      getBasePath?: () => string;
    };
    return adapter.basePath ?? adapter.getBasePath?.() ?? '';
  }

  /** Open the add-mount dialog. */
  promptAddMount(): void {
    new MountEditorModal(this).open();
  }

  /** Edit an existing mount. */
  editMount(mount: ExternalMount): void {
    new MountEditorModal(this, mount).open();
  }

  /**
   * Mount a tree row (folder OR file) as its own panel entry. Path and label
   * come from the row; the user only picks where in the mount list it lands.
   * With no existing mounts there is no position to choose — add directly.
   */
  promptMountEntry(draft: Omit<ExternalMount, 'id' | 'enabled'>): void {
    if ((this.settings.externalMounts ?? []).length === 0) {
      void this.addMount(draft).then((m) => new Notice(`已挂载 ${mountDisplayName(m)}`));
      return;
    }
    new MountPositionModal(this, draft).open();
  }

  /** Persist a new mount and show the panel; `atIndex` places it in the panel list. */
  async addMount(draft: Omit<ExternalMount, 'id' | 'enabled'>, atIndex?: number): Promise<ExternalMount> {
    const trimmed = draft.path.trim().replace(/[\\/]+$/, '');
    const base = this.vaultBasePath() || 'mount';
    let id = safeSegment(draft.label.trim() || trimmed.split(/[\\/]+/).pop() || base);
    // Ids become folder names under Mounts/, so they must stay unique there.
    let n = 2;
    while (this.settings.externalMounts.some((m) => m.id === id)) id = `${safeSegment(draft.label || base)}_${n++}`;
    const mount: ExternalMount = { ...draft, path: trimmed, id, enabled: true };
    if (atIndex === undefined || atIndex >= this.settings.externalMounts.length) {
      this.settings.externalMounts.push(mount);
    } else {
      // Clamp negatives to 0 rather than wrapping from the end: callers mean
      // "before the i-th mount", and -1 would silently hide the entry.
      this.settings.externalMounts.splice(Math.max(0, atIndex), 0, mount);
    }
    await this.saveSettings();
    this.startMountRefresh();
    this.refreshMounts();
    await this.activatePanel(VIEW_TYPE_MOUNT_PANEL);
    this.logOp('mount.add', mount.path, 'ok');
    return mount;
  }

  /** Remove a mount. Never touches the target folder.
   *  嵌套在其下的挂载提升为顶层(各自有独立真实路径,不连带删除)。 */
  async removeMount(mount: ExternalMount): Promise<void> {
    const list = this.settings.externalMounts;
    const i = list.findIndex((m) => m.id === mount.id);
    if (i < 0) return;
    list.splice(i, 1);
    let promoted = 0;
    for (const m of list) {
      // 卸一个宿主，它上面（含内部任意子节点上）的嵌套挂载一并回落顶层：
      // attachTo 现在可能是 `hostId/rel`，所以按 hostId 判。
      if (m.attachTo && mountHostOf(m.attachTo).hostId === mount.id) {
        delete m.attachTo;
        promoted++;
      }
    }
    await this.saveSettings();
    this.startMountRefresh();
    this.refreshMounts();
    this.logOp('mount.remove', mount.path, 'ok');
    new Notice(
      promoted > 0
        ? `已卸载 ${mountDisplayName(mount)}（${promoted} 个嵌套挂载已移到顶层）`
        : `已卸载 ${mountDisplayName(mount)}`,
    );
  }

  /** Move a mount so that `fromId` sits immediately before `toId`. */
  async reorderMount(fromId: string, toId: string): Promise<void> {
    const list = this.settings.externalMounts ?? [];
    const from = list.findIndex((m) => m.id === fromId);
    const to = list.findIndex((m) => m.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    await this.saveSettings();
  }

  /** Re-scan every open mount panel. */
  refreshMounts(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOUNT_PANEL)) {
      (leaf.view as MountPanelView | null)?.refreshMounts();
    }
    // 广播「挂载已刷新」：omnisearch / unified-search 据此重索引库外文件。
    // 事件名沿用拆分前的 logseq: 前缀——两个消费方都按这个名字监听，不能改。
    this.app.workspace.trigger('logseq:external-mounts-refreshed');
  }

  /**
   * Poll the panel for mounts that asked for a timed refresh.
   *
   * A single shared timer rather than one per mount: the panel is the only
   * consumer, and several timers would each re-render the same view.
   */
  private startMountRefresh(): void {
    if (this.mountRefreshTimer) {
      window.clearInterval(this.mountRefreshTimer);
      this.mountRefreshTimer = 0;
    }
    const interval = (this.settings.externalMounts ?? []).reduce(
      (min, m) => (m.enabled && m.refreshSeconds > 0 ? Math.min(min, m.refreshSeconds) : min),
      Infinity,
    );
    if (!Number.isFinite(interval)) return;
    this.mountRefreshTimer = window.setInterval(() => {
      if ((this.settings.externalMounts ?? []).some((m) => m.enabled && m.refreshSeconds > 0)) {
        this.refreshMounts();
      }
    }, Math.max(5, interval) * 1000);
  }

  /** Reveal a sidebar panel, creating its leaf on first use. */
  async activatePanel(viewType: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    // The mount tree opens in the LEFT sidebar, to the LEFT of the native
    // file explorer: a tree browsing folders OUTSIDE the vault belongs next
    // to the tree that browses the vault. First open only — after that the
    // user's own arrangement wins and reveal is all that happens.
    if (viewType === VIEW_TYPE_MOUNT_PANEL) {
      const explorer = workspace.getLeavesOfType('file-explorer')[0];
      const leaf = workspace.getLeftLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: viewType, active: true });
      if (explorer && leaf.parent === explorer.parent) {
        // Same tab group as the explorer: move this tab to sit before it.
        // insertChild/removeChild are Obsidian-internal but stable, and the
        // probe measured getLeftLeaf landing in this exact container.
        const tabs = explorer.parent as unknown as {
          children: WorkspaceLeaf[];
          insertChild: (index: number, child: WorkspaceLeaf) => void;
          removeChild: (child: WorkspaceLeaf) => void;
        };
        const at = tabs.children.indexOf(explorer);
        if (at > -1) {
          tabs.removeChild(leaf);
          tabs.insertChild(at, leaf);
        }
      }
      workspace.revealLeaf(leaf);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: viewType, active: true });
    workspace.revealLeaf(leaf);
  }

  // ------------------------------------------------------------------
  // External-file routing (openExternalEntry) + native route
  // ------------------------------------------------------------------

  /** Can THIS Obsidian open out-of-vault files natively? (desktop, 1.14.4+ installer) */
  canOpenNativeExternal(): boolean {
    return (Platform as unknown as { canOpenExternalFiles?: boolean }).canOpenExternalFiles === true;
  }

  /**
   * Open an external mount file with Obsidian's NATIVE editor.
   *
   * The route is the one Obsidian's own "Open file from outside the vault…"
   * uses underneath: resolve the absolute path to a `TExternalFile` (the
   * `file:`-prefixed form is what `getAbstractFileByPath` hands to the external
   * file manager — measured), then `leaf.openFile` it like any vault file. The
   * logseq module's setViewState take-over patch explicitly leaves these alone,
   * so this really lands in the native markdown editor, not in the block editor.
   */
  async openExternalInNativeEditor(node: MountNode): Promise<boolean> {
    if (!this.canOpenNativeExternal()) {
      new Notice('用原生编辑器打开库外文件需要 Obsidian 1.14.4+，并通过最新安装器安装。');
      return false;
    }
    const key = `file:${node.abs.replace(/\\/g, '/')}`;
    const af = this.app.vault.getAbstractFileByPath(key) as TFile | null;
    if (!af || typeof (af as unknown as { getRealPath?: unknown }).getRealPath !== 'function') {
      new Notice('无法打开：文件不存在，或此版本不支持库外文件。');
      return false;
    }
    const leaf = this.app.workspace.getLeaf(this.settings.externalSplitView === true ? 'split' : 'tab');
    await leaf.openFile(af);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.logOp('external.open', node.abs, 'ok', 'native-editor');
    return true;
  }

  /**
   * 库外 markdown 文件的默认编辑器决策（openExternalEntry 与挂载面板菜单共用）。
   *
   * 文件自己的 `editor` 属性最优先 —— 库外文件没有 metadataCache 条目也没有
   * 页面属性注册表，唯一的来源是文件本身（frontmatter `editor:` 或顶部
   * `editor::`，见 editorChoiceFromExternalText）；读不出来按无属性处理。
   * 没有属性时用设置 externalMarkdownEditor，未设置 = 'native'
   * （用户 2026-10-25 决策：库外 md 默认 Obsidian 原生编辑器）。
   *
   * 同步读整个文件：菜单构建（contextmenu）也会调它来让主项标题跟上实际
   * 行为，挂载面板已有的 isLinked 等菜单期检查本来就是同步 fs，量级相同。
   */
  externalMarkdownChoice(node: Pick<MountNode, 'abs' | 'name'>): EditorChoice {
    if (isMarkdownFile(node.name)) {
      try {
        const fromFile = editorChoiceFromExternalText(readExternalText(node.abs));
        if (fromFile) return fromFile;
      } catch {
        /* 读不了按无属性处理，走设置 */
      }
    }
    return this.settings.externalMarkdownEditor === 'logseq' ? 'logseq' : 'native';
  }

  /**
   * Open one entry of a mount.
   *
   * Text-like files go to a REGISTERED opener (logseq owns the markdown/block
   * route and the code route until the code-editor module exists; see
   * openers.ts). Media is routed to doc-tree's own viewers, binaries to the
   * system. A synthetic `TFile` would be the shortcut here, but it does not
   * work: measured, `leaf.openFile(fake)` resolves and then mounts the "empty"
   * placeholder, so the content never appears.
   */
  async openExternalEntry(
    mount: ExternalMount,
    node: MountNode,
    opts?: { readOnly?: boolean; forceCodeEditor?: boolean; forceBlockEditor?: boolean },
  ): Promise<void> {
    if (node.isDir) return;
    // 媒体文件最先路由(先于 readOnly):查看器/播放器本身就是只读的,
    // 「只读打开」对二进制塞文本 shim 只会得到乱码。
    if (isImageFile(node.name)) {
      await this.openExternalInView(VIEW_TYPE_IMAGE, { abs: node.abs, name: node.name });
      return;
    }
    if (isVideoFile(node.name)) {
      await this.openExternalInView(VIEW_TYPE_VIDEO, { abs: node.abs, name: node.name });
      return;
    }
    // Read-only means "show me, change nothing", and it is also the fallback
    // whenever a real editor cannot be given the file. Creating a link is a
    // genuine change to the user's library, so it happens only when they ask
    // for it from the row's context menu — never because they clicked a file.
    const ctx: OpenerCtx = { docTree: this };
    if (opts?.readOnly) {
      if (await runOpeners('shim', ctx, mount, node, opts)) return;
      new Notice('块编辑器模块未启用，无法只读打开。');
      return;
    }
    // An already-linked file has a real vault path, so open that and let
    // Obsidian dispatch on the extension as it would for any vault note.
    if (this.isLinkedInto(node)) {
      await this.app.workspace.openLinkText(linkVaultPath(safeSegment(node.name)), '', false);
      return;
    }
    // .ipynb 优先交给 jupyter notebook 插件（库外绝对路径 fs 直读直写）。
    // 未装/未启用时走原路由（通常被二进制门控交给系统）。
    if (extOfName(node.name) === 'ipynb') {
      // App 类型不暴露 plugins（iconTheme 同款防御式访问）
      const host = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
      const jupyter = host?.plugins?.['obsidian-jupyter-notebook'] as
        | { openExternalNotebook?: (p: string) => Promise<void> }
        | undefined;
      if (typeof jupyter?.openExternalNotebook === 'function') {
        await jupyter.openExternalNotebook(node.abs);
        return;
      }
    }
    // Routing is by CONTENT, not by file type: markdown is prose. Its default
    // editor is externalMarkdownChoice — the file's own `editor` property
    // first, then the setting (default 'native', the TExternalFile route that
    // Obsidian itself uses). Everything else — code, config, `.gitignore`,
    // `.env`, plain text — is something you read line by line and belongs in
    // the code editor route. An allowlist of "code extensions" was the wrong
    // shape: it sends every file the list forgot to the wrong editor, which is
    // how a `.gitignore` ended up rendered as a document with headings.
    if (isMarkdownFile(node.name)) {
      // 默认原生时先试原生编辑器；打开失败（文件刚被移走等）落回块编辑器。
      // 本机不支持库外原生打开（pre-1.14.4）时直接走块编辑器——shim 是只读兜底,
      // 不该成为可编辑 md 的默认目的地。
      if (
        !opts?.forceBlockEditor &&
        this.externalMarkdownChoice(node) === 'native' &&
        this.canOpenNativeExternal()
      ) {
        if (await this.openExternalInNativeEditor(node)) return;
      }
      if (await runOpeners('markdown', ctx, mount, node, opts)) return;
    } else {
      // (媒体文件已在函数开头路由进应用内查看器。)
      // Real binaries have nothing to edit, so hand them to the system. Judged
      // by whole name as well as extension: `Dockerfile` and friends have no
      // extension and were being treated as binary, which sent them off to some
      // unrelated program instead of opening.
      if (!isTextFileName(node.name)) {
        this.openWithSystem(node.abs);
        return;
      }
      // 默认:代码文件路由(混合视图/纯 Monaco,由上层的 code opener 决定)。
      if (await runOpeners('code', ctx, mount, node, opts)) return;
    }
    // Everything declined: the shim (read-only fallback) is the last resort.
    if (await runOpeners('shim', ctx, mount, node, opts)) return;
    new Notice(`无法打开 ${node.name}：块编辑器模块未启用。`);
  }

  /** True when a link for this entry is already present in the vault. */
  isLinkedInto(node: MountNode): boolean {
    const base = this.vaultBasePath();
    if (!base) return false;
    return exists(linkTargetFor(base, node.name, safeSegment(node.name)));
  }

  /**
   * True when a file at `abs` can be given a real path in this vault.
   *
   * A hard link needs both paths on the same volume (measured: cross-volume
   * fails with "系统无法将文件复制到不同的磁盘驱动器"), while a directory
   * junction crosses volumes fine. So the check is about the volume, not the
   * file type — and it is why the shim view still exists as a fallback.
   */
  canOpenNatively(abs: string): boolean {
    const base = this.vaultBasePath();
    if (!base) return false;
    return sameVolume(base, abs);
  }

  /**
   * Wait until the vault has indexed `path`, so a link created a moment ago can
   * be opened by name.
   *
   * A link made while Obsidian is running is on disk immediately but reaches the
   * indexer on its own schedule; opening it in that window resolves to nothing
   * and leaves the "empty" placeholder view. Measured: with the link present at
   * startup, `openLinkText` works on the first try, so this only has to cover
   * the just-created case.
   */
  async waitForIndex(path: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // The indexer reacts to a vault event, so yield to it between checks rather
    // than spinning on a tight loop.
    while (Date.now() < deadline) {
      if (this.app.vault.getAbstractFileByPath(path)) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  /** Open an entry that has been linked into the vault, natively. */
  async openLinked(linkName: string, rel = ''): Promise<void> {
    await this.app.workspace.openLinkText(linkVaultPath(linkName, rel), '', false);
  }

  /** Hand a path to the OS default program. */
  openWithSystem(abs: string): void {
    try {
      const electron = (window as unknown as { require?: (id: string) => unknown }).require?.('electron') as
        | { shell?: { openPath?: (p: string) => Promise<string> } }
        | undefined;
      if (electron?.shell?.openPath) {
        void electron.shell.openPath(abs);
        return;
      }
    } catch {
      /* fall through to the notice below */
    }
    new Notice(`没有可用的系统打开方式：${abs}`);
  }

  /** Reveal a path in Explorer. */
  revealInSystem(abs: string): void {
    try {
      const electron = (window as unknown as { require?: (id: string) => unknown }).require?.('electron') as
        | { shell?: { showItemInFolder?: (p: string) => void } }
        | undefined;
      if (electron?.shell?.showItemInFolder) {
        electron.shell.showItemInFolder(abs);
        return;
      }
    } catch {
      /* fall through */
    }
    new Notice(abs);
  }

  // ------------------------------------------------------------------
  // Media viewers (out-of-vault mode) + omniscience helpers
  // ------------------------------------------------------------------

  /**
   * 库外媒体（图片/视频）→ ImageView / VideoView 的库外模式。
   *
   * 叶策略与库外代码/块编辑器一致（externalSplitView ? 'split' : 'tab'），
   * 同一文件已开着时复用叶而不是叠标签；媒体文件没有「接管」包袱，也不进
   * setViewState 补丁的路径（ItemView 自有 state）。
   */
  async openExternalInView(viewType: string, spec: { abs: string; name?: string }): Promise<void> {
    const state = { abs: spec.abs, name: spec.name ?? '' };
    // 复用同一文件的同型视图叶。
    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      const vs = leaf.getViewState().state as { abs?: string } | undefined;
      if (vs?.abs && vs.abs.toLowerCase() === spec.abs.toLowerCase()) {
        await leaf.setViewState({ type: viewType, state, active: true });
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }
    const leaf = this.app.workspace.getLeaf(this.settings.externalSplitView === true ? 'split' : 'tab');
    const name = spec.name ?? spec.abs.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? spec.abs;
    markLeafTabIcon(leaf, { name, rel: name });
    await leaf.setViewState({ type: viewType, state, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.refreshTabIcons();
    this.refreshTabIconsSoon();
    this.logOp('external.open', spec.abs, 'ok', viewType === VIEW_TYPE_IMAGE ? 'image-viewer' : 'video-player');
  }

  /** Keep every open image viewer's tab title in sync after prev/next. */
  refreshImageViewTitles(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_IMAGE)) {
      const view = leaf.view as ImageView | null;
      if (!view) continue;
      // Obsidian caches the tab label; assigning the display text again is not
      // enough, so the leaf's own title element is refreshed through the
      // workspace's update path.
      (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }
  }

  /** Keep every open video player's tab title in sync after prev/next. */
  refreshVideoViewTitles(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VIDEO)) {
      const view = leaf.view as VideoView | null;
      if (!view) continue;
      (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }
  }

  /**
   * 给 doc-tree 自己打开的标签页补主题文件图标。
   * 标签页头重建/setIcon 重设后 marker 元素丢失,layout-change 时重应用。
   */
  private refreshTabIcons(): void {
    const leaves = [VIEW_TYPE_IMAGE, VIEW_TYPE_VIDEO].flatMap((t) =>
      this.app.workspace.getLeavesOfType(t),
    );
    applyMarkedTabIcons(this.app, leaves);
  }

  /**
   * setIcon(view.getIcon()) 会在 setViewState 之后的某个时点覆盖标签页图标
   * (实测:立即应用的主题图标被清掉),延迟补一次;applyMarkedTabIcons 幂等。
   */
  private refreshTabIconsSoon(): void {
    window.setTimeout(() => this.refreshTabIcons(), 120);
  }

  /**
   * 库根的绝对路径（小写、正斜杠、无尾斜杠）。挂载指向库内（例如直接挂了
   * vault 根）时，扫出来的「库外文件」其实是库内文件——它们已由 vault 路径
   * 进过索引，再以 ext: 伪路径进第二遍纯属翻倍内存与索引时间。
   */
  private vaultRootNorm(): string {
    try {
      const base = (this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? '';
      return base.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * 供其它模块（omnisearch / unified-search）列举库外可搜索文件——「库外搜索」
   * 的数据源。logseq 模块保留了同名门面方法，历史消费方不断。
   *
   * 返回扁平的 `{abs, name, mtime}`（绝对路径）。纯只读：不打开、不建链接、
   * 不写盘；调用方自己转成 `ext:` 伪路径并判断是否可索引。
   *
   * 走与面板同源的 `scanExternal` + mount 的 include/exclude 过滤，保证
   * 「能搜到的」与「面板里看得见的」是同一批文件。单个挂载扫描失败只跳过
   * 它，不影响其余挂载，也绝不抛给调用方。
   */
  public listExternalSearchFiles(): Array<{ abs: string; name: string; mtime: number }> {
    const out: Array<{ abs: string; name: string; mtime: number }> = [];
    const mounts = this.settings.externalMounts ?? [];
    const vaultRoot = this.vaultRootNorm();
    for (const mount of mounts) {
      if (!mount?.enabled || !mount.path) continue;
      const filter = compileFilter({
        include: mount.include ?? '',
        exclude: mount.exclude ?? '',
      });
      // exclude 优先、其次 include —— 与 buildTree 的判定保持一致。
      const keep = (rel: string): boolean => {
        if (filter.exclude?.test(rel)) return false;
        if (filter.include && !filter.include.test(rel)) return false;
        return true;
      };
      let entries: ScanEntry[];
      try {
        entries = scanExternal(mount.path, {
          shouldEnterDir: () => true,
          keepFile: keep,
        }).entries;
      } catch (e) {
        console.warn('[doc-tree] listExternalSearchFiles: scan failed for', mount.path, e);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDir) continue;
        if (vaultRoot && entry.abs.replace(/\\/g, '/').toLowerCase().startsWith(`${vaultRoot}/`)) {
          continue;
        }
        out.push({ abs: entry.abs, name: entry.name, mtime: entry.mtime ?? 0 });
      }
    }
    return out;
  }

  /**
   * 反查一个绝对路径属于哪个挂载，返回 `{mount, rel}`（rel 用 `/` 分隔）。
   * omnisearch 打开库外搜索结果时用它拼 `openExternalEntry` 需要的
   * mount + node。不在任何启用挂载下（或就是挂载根本身）返回 null。
   *
   * 嵌套挂载取**最长匹配**（最具体的那个），比较按 Windows 习惯忽略大小写。
   */
  public resolveExternalMount(abs: string): { mount: ExternalMount; rel: string } | null {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const target = norm(abs);
    const targetLower = target.toLowerCase();
    let best: { mount: ExternalMount; rel: string } | null = null;
    for (const mount of this.settings.externalMounts ?? []) {
      if (!mount?.enabled || !mount.path) continue;
      const root = norm(mount.path);
      if (!targetLower.startsWith(root.toLowerCase())) continue;
      const rel = target.slice(root.length).replace(/^\//, '');
      if (!rel) continue; // 挂载根本身不是文件
      if (!best || root.length > norm(best.mount.path).length) {
        best = { mount, rel };
      }
    }
    return best;
  }
}
