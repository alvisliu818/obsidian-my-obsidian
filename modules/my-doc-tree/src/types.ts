/**
 * Core data types for the virtual document tree (虚拟文档树): mounts outside
 * the vault, the system "open with" list, and the media-viewer take-over
 * switches. Dependency-free (no obsidian / DOM) — unit-tested under plain
 * Node via vitest.
 *
 * 2026-10-27 模块拆分:这些类型原先住在 logseq 模块的 types.ts;挂载面板 /
 * 库外文件系统 / 查看器整体划给 doc-tree 模块后随之搬家。与块编辑器相关的
 * 设置(externalBanner、externalCodeHybrid 等)仍归 logseq。
 */

import { PRESET_OPEN_WITH } from './features/openWith';

/** Editor for out-of-vault markdown: Obsidian's native editor or the block editor. */
export type EditorChoice = 'logseq' | 'native';

/**
 * One mount: an absolute path to a folder outside the vault.
 *
 * Nothing is copied into the vault — a mounted file is read from and written
 * back to where it actually lives. `include` / `exclude` are regular
 * expressions matched against the path relative to `path`.
 */
export interface ExternalMount {
  /** Stable id; also used as the link folder name, so it must be path-safe. */
  id: string;
  /** Absolute Windows path, e.g. `D:\\notes`. */
  path: string;
  /** Label shown in the panel; '' = use the folder's own name. */
  label: string;
  /** Only entries matching this survive. '' = keep everything. */
  include: string;
  /** Entries matching this are dropped even when they match `include`. '' = none. */
  exclude: string;
  /** Re-scan this mount every N seconds. 0 = manual only. */
  refreshSeconds: number;
  /** Hide the mount without deleting it. */
  enabled: boolean;
  /** Keep the mount at the top of the panel regardless of drag order. */
  pinned: boolean;
  /**
   * 嵌套挂载:宿主位置。设置后本挂载渲染在该位置之下(si-yuan 虚拟文档树
   * 的 MountItem.children 语义:显式嵌套挂载在前,宿主的真实内容在后),
   * 而不是面板顶层。宿主被卸载/停用时兜底渲染为顶层。
   *
   * 两种形态(以第一个 `/` 分隔,挂载 id 由 safeSegment 生成、不含 `/`):
   *   - `hostId`            挂到宿主挂载项的**根部**
   *   - `hostId/sub/dir`    挂到宿主内部某个**子文件夹**下
   *   - `hostId/file.md`    挂到宿主内部某个**文件**下
   * 于是挂载的文件或文件夹、以及它们下面的子文件或子文件夹,都可以再挂载。
   */
  attachTo?: string;
}

/**
 * Split an `attachTo` into the host mount id and the path inside that host.
 *
 * Mount ids are produced by `safeSegment` and so never contain a slash, which
 * makes the FIRST slash an unambiguous separator. An empty or malformed value
 * degrades to `hostRel: ''` (the host's own root) rather than throwing —
 * `data.json` is user-editable.
 */
export function mountHostOf(attachTo: string): { hostId: string; hostRel: string } {
  const slash = attachTo.indexOf('/');
  if (slash < 0) return { hostId: attachTo, hostRel: '' };
  return {
    hostId: attachTo.slice(0, slash),
    hostRel: attachTo.slice(slash + 1).replace(/^\/+/, '').replace(/\/+$/, ''),
  };
}

/** Human-readable host label for the mount lists: `Folder / sub / dir`. */
export function mountHostLabel(m: ExternalMount, mounts: readonly ExternalMount[]): string {
  if (!m.attachTo) return '';
  const { hostId, hostRel } = mountHostOf(m.attachTo);
  const host = mounts.find((h) => h.id === hostId);
  const name = host ? mountDisplayName(host) : hostId;
  return hostRel ? `${name} / ${hostRel}` : name;
}

/** Drop anything malformed — `data.json` is user-editable. */
export function mountFrom(raw: unknown): ExternalMount | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<ExternalMount>;
  if (typeof m.id !== 'string' || !m.id.trim()) return null;
  if (typeof m.path !== 'string' || !m.path.trim()) return null;
  const secs = Number(m.refreshSeconds);
  // attachTo 保留三种形态:裸 hostId、hostId/子路径。自引用(宿主是自己)丢弃,
  // 其余按顶层渲染;data.json 用户可编辑,故一律容错。
  const at = typeof m.attachTo === 'string' && m.attachTo.trim() ? m.attachTo.trim().replace(/\/+$/, '') : undefined;
  const selfHost = at ? mountHostOf(at).hostId === m.id.trim() : false;
  const attachTo = at && !selfHost ? at : undefined;
  return {
    id: m.id.trim(),
    path: m.path.trim(),
    label: typeof m.label === 'string' ? m.label : '',
    include: typeof m.include === 'string' ? m.include : '',
    exclude: typeof m.exclude === 'string' ? m.exclude : '',
    refreshSeconds: Number.isFinite(secs) && secs >= 0 ? Math.min(secs, 3600) : 0,
    // absent = enabled, so a config written before this field existed still works
    enabled: m.enabled !== false,
    pinned: m.pinned === true,
    ...(attachTo ? { attachTo } : {}),
  };
}

/** Sanitize the stored mount list (see `mountFrom` for the per-entry rules). */
export function mountsFrom(raw: unknown): ExternalMount[] {
  if (!Array.isArray(raw)) return [];
  const out: ExternalMount[] = [];
  for (const item of raw) {
    const m = mountFrom(item);
    if (m) out.push(m);
  }
  // 环检测:attachTo 的宿主链走回自己(A→B→A,手改 data.json 才可能)整环降为顶层,
  // 否则渲染会双显/死循环。按 hostId 追(子路径只是宿主内的位置,不影响归属)。
  const byId = new Map(out.map((m) => [m.id, m]));
  for (const m of out) {
    if (!m.attachTo) continue;
    const seen = new Set<string>([m.id]);
    let cur = byId.get(mountHostOf(m.attachTo).hostId);
    let cyclic = false;
    while (cur) {
      if (seen.has(cur.id)) {
        cyclic = true;
        break;
      }
      seen.add(cur.id);
      cur = cur.attachTo ? byId.get(mountHostOf(cur.attachTo).hostId) : undefined;
    }
    if (cyclic) delete m.attachTo;
  }
  return out;
}

/**
 * Sanitize the tree display-order overrides read from user-editable data.json:
 * keep only well-shaped `mountId -> dirRel -> string[]` records, dropping
 * anything malformed so a hand-edited config cannot poison rendering.
 */
export function mountTreeOrderFrom(raw: unknown): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [mountId, dirs] of Object.entries(raw as Record<string, unknown>)) {
    if (!dirs || typeof dirs === 'string') continue;
    if (typeof dirs !== 'object') continue;
    const clean: Record<string, string[]> = {};
    for (const [rel, names] of Object.entries(dirs as Record<string, unknown>)) {
      if (!Array.isArray(names)) continue;
      const list = names.filter((n): n is string => typeof n === 'string' && n.length > 0);
      if (list.length) clean[rel] = list;
    }
    if (Object.keys(clean).length) out[mountId] = clean;
  }
  return out;
}

/** Display name for a mount: its label, else the folder's own name. */
export function mountDisplayName(m: ExternalMount): string {
  if (m.label.trim()) return m.label.trim();
  const parts = m.path.replace(/[\\/]+$/, '').split(/[\\/]+/);
  return parts[parts.length - 1] || m.path;
}

/**
 * One "open with" entry: an external application that can be handed a file.
 * `%1` in `args` is the file's absolute path, `%d` its containing folder.
 */
export interface OpenWithApp {
  id: string;
  /** Label shown in the menu. */
  name: string;
  /** Executable path, or a bare command resolvable on PATH. */
  command: string;
  args: string;
  /** Hide without deleting. */
  enabled: boolean;
}

/** Drop malformed entries — `data.json` is user-editable. */
export function openWithAppFrom(raw: unknown): OpenWithApp | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<OpenWithApp>;
  if (typeof a.id !== 'string' || !a.id.trim()) return null;
  if (typeof a.command !== 'string' || !a.command.trim()) return null;
  return {
    id: a.id.trim(),
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : a.id.trim(),
    command: a.command.trim(),
    args: typeof a.args === 'string' ? a.args : '%1',
    enabled: a.enabled !== false,
  };
}

export function openWithAppsFrom(raw: unknown): OpenWithApp[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenWithApp[] = [];
  for (const item of raw) {
    const a = openWithAppFrom(item);
    if (a) out.push(a);
  }
  return out;
}

/**
 * One entry in the mount panel's「最近打开」区.
 *
 * `kind` decides how the row is opened: a vault path goes through
 * `openLinkText` like any note; an absolute path is resolved back to its
 * mount and opened through the external-file routes. Keeping the two apart
 * in the data (rather than sniffing the path at render time) means a vault
 * file whose name happens to look absolute still opens correctly.
 */
export interface RecentOpenEntry {
  /** Vault-relative path when kind is 'vault'; absolute path when 'ext'. */
  path: string;
  kind: 'vault' | 'ext';
  /** Epoch ms of the last open; ordering only. */
  at: number;
}

/** doc-tree 模块自己的设置片(data.json 的 modules['doc-tree'].data)。 */
export interface DocTreeSettings {
  /**
   * Apply each mount's include/exclude regexes to the virtual document tree.
   *
   * Off by default: the tree then shows everything under a mounted folder —
   * "挂载不过滤". The regexes stay configured per mount and take effect again
   * the moment this is switched on, so nothing has to be re-entered.
   */
  mountFilterEnabled: boolean;
  /**
   * Offer 「链接到库」 in the mount panel's right-click menu.
   *
   * On by default. Off hides the whole group — 链接到库 / 从库中取消链接 /
   * 链接整个上级文件夹 — for people who never link into the vault. Links
   * already on disk keep working either way: an existing link still opens
   * through its vault path.
   */
  mountLinkEnabled: boolean;
  /**
   * Show the 「已加载 N 文件 · M 文件夹」 line under a mount's header.
   *
   * On by default; the tree is filled in lazily, so the numbers only ever
   * describe the layers read so far — users who find the line noisy can turn
   * it off without losing anything.
   */
  mountShowLoadedCount: boolean;
  /**
   * Drag mode for the virtual document tree: when on, tree rows can be
   * dragged to a custom DISPLAY order (persisted in `mountTreeOrder`).
   * The filesystem is never touched - this is purely how the panel draws.
   * Off by default so rows keep the stock folders-first A-to-Z order.
   */
  mountDragMode: boolean;
  /**
   * Display-order overrides for the tree, `mountId -> dir rel -> keys`.
   * A key is a real child's NAME, or `mount:<id>` for a nested mount head
   * hanging at that level — both share one key space so drags can interleave
   * mounts among real siblings. Only keys the user actually dragged are
   * recorded; anything unlisted keeps the default sort after them. Stale
   * keys (renamed/deleted/unmounted) are skipped at apply time, so no
   * cleanup pass is needed.
   */
  mountTreeOrder: Record<string, Record<string, string[]>>;
  /**
   * 面板顶栏工具栏配置(思源虚拟文档树同款结构):按钮顺序 + 收进「更多」的归属。
   * order 空 = 按注册表默认顺序;hidden = 收进「更多」菜单的按钮 key。
   * 未配置(undefined)时按注册表默认渲染。
   */
  mountToolbar?: { order: string[]; hidden: string[] };
  /**
   * 虚拟文档树「新建笔记」的落盘目录。
   *
   * 笔记不一定和它挂载到的位置在同一棵磁盘树里：文件写在**这个**目录下，
   * 再以 attachTo 挂成右键那个条目的子文档（思源「新建笔记」就是这个语义
   * ——文档归库管，位置归树管）。留空 = 落到库根目录。
   */
  mountNewNotePath: string;
  /**
   * 系统文件对话框（挂载编辑里的「浏览文件夹 / 选择文件」）上次停留的目录。
   *
   * 只在用户真的用系统对话框选过东西之后才写入，空串 = 用系统默认位置。
   * 下一次打开对话框就从这里起步：同一片目录里连续挂几个东西时不用每次都
   * 从「此电脑」重新点进去。手动输入路径不受影响（那是用户自己指的地方）。
   */
  mountPickDir: string;
  /**
   * Folders OUTSIDE the vault listed in the mount panel. Each is shown as a
   * virtual tree; any entry can also be linked into the vault as a real path
   * (junction for folders, hard link for files), which makes it open in the
   * native block editor. See `notes/mounts.md`.
   */
  externalMounts: ExternalMount[];
  /**
   * Open a mounted file in a split pane rather than replacing the current tab.
   *
   * Obsidian refuses to mount a text view without a file, so opening one seeds
   * the leaf with a real note first (measured: every other route yields the
   * "empty" placeholder). A split keeps that seeding out of the way of whatever
   * the user is working in; a tab keeps the window uncluttered. Tab is the
   * default because it is what a click on a file usually means.
   */
  externalSplitView: boolean;
  /**
   * 库外 markdown 文件的默认编辑器（挂载面板点击、搜索结果等一切走
   * openExternalEntry 的入口）。'native' = Obsidian 原生编辑器（1.14.4+ 的
   * TExternalFile 路线，反链/大纲/链接解析都是原生行为）；'logseq' = logseq
   * 模块的 ExternalBlockView 壳（折叠/缩放/块引用，但没有反链）。
   *
   * 单个文件可以用自己的属性覆盖这里：frontmatter `editor: logseq|native` 或
   * 文件顶部 `editor:: logseq|native`（见 editorChoiceFromExternalText）——
   * 与库内页面的 `editor` 属性同一套语义。本机不支持库外原生打开
   * （canOpenNativeExternal 为 false）时，选了 'native' 也会落回块编辑器。
   */
  externalMarkdownEditor: EditorChoice;
  /**
   * Take over Office files (.docx/.xlsx/.pptx/…) with the built-in previewer.
   * On by default: Obsidian has no viewer for these at all, so there is nothing
   * to displace — and "open with the system app" stays one click away in the
   * view's toolbar.
   */
  officeViewerEnabled: boolean;
  /**
   * Take over image files with the enhanced viewer (zoom / rotate / pan /
   * prev-next). Off by default, unlike Office: Obsidian already previews
   * images, so replacing that for every image in the vault is a real change.
   * The command and the file-menu entry work either way.
   */
  imageViewerTakeOver: boolean;
  /**
   * Take over video files with the enhanced player (speed / loop / snapshot /
   * prev-next). Off by default for the same reason — Obsidian already previews
   * bare video. Out-of-vault videos (mount tree, system picker) always open
   * in the player regardless of this setting.
   */
  videoPlayerTakeOver: boolean;
  /**
   * 视频时间戳标记(2026-10-30):播放器里打标记写进 markdown,点击回跳;
   * 伴随笔记即「视频 → 笔记」方向的标记列表。默认开——入口只有播放器工具栏
   * 与命令,不改变任何既有行为。
   */
  videoTimestampsEnabled: boolean;
  /** 标记伴随笔记的落盘目录(vault 相对路径)。 */
  videoMarksFolder: string;
  /** Configured external applications for the "open with" menu. */
  openWithApps: OpenWithApp[];
}

export const DEFAULT_DOCTREE_SETTINGS: DocTreeSettings = {
  mountFilterEnabled: false,
  mountLinkEnabled: true,
  mountShowLoadedCount: true,
  mountDragMode: false,
  mountTreeOrder: {},
  mountPickDir: '',
  mountNewNotePath: '',
  externalMounts: [],
  externalSplitView: false,
  // 库外 md 默认 Obsidian 原生编辑器(用户 2026-10-25 决策);块编辑器保留在
  // 右键菜单,文件自己的 editor 属性可逐文件覆盖。
  externalMarkdownEditor: 'native',
  officeViewerEnabled: true,
  imageViewerTakeOver: false,
  videoPlayerTakeOver: false,
  videoTimestampsEnabled: true,
  videoMarksFolder: 'Video Marks',
  openWithApps: [],
};

/** Normalize one raw property value to an editor choice (unknown → null). */
function editorChoiceValue(raw: unknown): EditorChoice | null {
  const v = String(raw).trim().toLowerCase();
  if (v === 'logseq') return 'logseq';
  if (v === 'native') return 'native';
  return null;
}

/**
 * The per-FILE default-editor property of an OUT-OF-VAULT markdown file, read
 * from the file's own text — it has no metadataCache entry and no page
 * registry, so the file itself is the only source. Same two channels and the
 * same value rules as the per-page property: frontmatter `editor: logseq|native`
 * and top-of-file Logseq page properties `editor:: logseq|native`. No property
 * (or an unknown value) yields null.
 *
 * This mirrors the parser's two channels without running the full parser:
 * frontmatter is a leading `---` fence that actually closes, page properties
 * are the run of UNindented `key:: value` lines before any block content.
 * CRLF is normalized first for the same reason the parser does it —
 * `$`-anchored matches never see `\r`. When frontmatter exists, `editor:`
 * inside it decides and the post-fence `editor::` run is not consulted.
 */
export function editorChoiceFromExternalText(text: string): EditorChoice | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // --- frontmatter (`editor:`): leading fence, only when it closes ---
  if ((lines[0] ?? '').trim() === '---') {
    let close = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') {
        close = j;
        break;
      }
    }
    for (let j = 1; close > 0 && j < close; j++) {
      const m = /^editor[ \t]*:[ \t]*(.*)$/i.exec(lines[j]);
      if (m) return editorChoiceValue(m[1]);
    }
  }
  // --- Logseq page properties (`editor::`): unindented run before content ---
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (/^[\t ]/.test(line)) break; // indented = inside a block, not a page prop
    const m = /^editor[ \t]*::[ \t]*(.*)$/i.exec(line);
    if (m) return editorChoiceValue(m[1]);
    if (!/^[A-Za-z][A-Za-z0-9_-]*::/.test(line)) break; // real content ends the run
  }
  return null;
}

/**
 * Sanitize the whole doc-tree settings slice read from user-editable data.json.
 * Mirrors what logseq's loadSettings used to do for these fields before the
 * 2026-10-27 module split: absent keys fall to defaults, malformed records are
 * dropped, and every per-entry rule lives in its own `*From` helper.
 */
export function docTreeSettingsFrom(raw: unknown): DocTreeSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s: DocTreeSettings = { ...DEFAULT_DOCTREE_SETTINGS };
  s.mountFilterEnabled = o.mountFilterEnabled === true;
  s.mountLinkEnabled = o.mountLinkEnabled !== false;
  s.mountShowLoadedCount = o.mountShowLoadedCount !== false;
  s.mountDragMode = o.mountDragMode === true;
  s.mountTreeOrder = mountTreeOrderFrom(o.mountTreeOrder);
  // 工具栏配置:结构非法/未配置时保持 undefined(= 注册表默认渲染)
  if (o.mountToolbar && typeof o.mountToolbar === 'object') {
    const tb = o.mountToolbar as { order?: unknown; hidden?: unknown };
    s.mountToolbar = {
      order: Array.isArray(tb.order) ? tb.order.filter((k): k is string => typeof k === 'string') : [],
      hidden: Array.isArray(tb.hidden) ? tb.hidden.filter((k): k is string => typeof k === 'string') : [],
    };
  }
  if (typeof o.mountPickDir === 'string') s.mountPickDir = o.mountPickDir;
  if (typeof o.mountNewNotePath === 'string') s.mountNewNotePath = o.mountNewNotePath;
  s.externalMounts = mountsFrom(o.externalMounts);
  s.externalSplitView = o.externalSplitView === true;
  s.externalMarkdownEditor =
    editorChoiceValue(o.externalMarkdownEditor) ?? DEFAULT_DOCTREE_SETTINGS.externalMarkdownEditor;
  s.officeViewerEnabled = o.officeViewerEnabled !== false;
  s.imageViewerTakeOver = o.imageViewerTakeOver === true;
  s.videoPlayerTakeOver = o.videoPlayerTakeOver === true;
  // 时间戳标记:缺省开;空目录名回落默认(设置 UI 承诺「留空用默认」)。
  s.videoTimestampsEnabled = o.videoTimestampsEnabled !== false;
  const marksFolder = typeof o.videoMarksFolder === 'string' ? o.videoMarksFolder.trim() : '';
  s.videoMarksFolder = marksFolder || DEFAULT_DOCTREE_SETTINGS.videoMarksFolder;
  // "Open with": a config that never had the key gets the presets, so a fresh
  // install has something in the menu; once the key exists (even as []) the
  // user's own list — including an empty one — is respected.
  s.openWithApps =
    o.openWithApps === undefined
      ? PRESET_OPEN_WITH.map((a) => ({ ...a }))
      : openWithAppsFrom(o.openWithApps);
  return s;
}
