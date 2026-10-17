/**
 * 库外文件标签页的 ⋮ / 右键菜单（pane menu）。
 *
 * 为什么需要这个文件：库内文件走 Obsidian 自己的 `FileView.onPaneMenu`——
 * 它加重命名/删除并触发 `file-menu` 事件，核心插件与第三方插件随之补项，
 * 于是一个库内标签页的 ⋮ 菜单有十几项。库外文件由我们自己的 ItemView 承载
 * （实测：TextFileView 没有 TFile 挂不起来，见 ExternalBlockView 注释），
 * 继承链上只有基类的分屏项，⋮ 菜单于是只剩「左右/上下分屏」。
 *
 * 这里的策略与挂载面板行右键菜单完全一致（那套已经 shellcommands 20/20 验证）：
 *   1. 先以中性 source 转发 `file-menu`（hop-1 TExternalFile + hop-2 TFile 伪
 *      适配器），让其他插件补项；
 *   2. 再补我们自己的项——全部作用在真实绝对路径上，且放在转发之后：
 *      标题去重是 LAST wins（见 forwardFileMenuEvent），我们自己的实现因此
 *      赢过核心 file-explorer 那些对库外假路径无效的同名项。
 *
 * 纯逻辑（适配器路径逃逸、改名目标路径）不碰 DOM，可单测；弹窗与菜单构建
 * 依赖 obsidian，由 e2e 覆盖。
 */

import { Menu, Notice, TFile, TFolder, type App, type ViewState } from 'obsidian';
import {
  deletePermanent,
  exists,
  linkTargetFor,
  removeLink,
  renameEntry,
  renameTarget,
  safeSegment,
  trashEntry,
  validateEntryName,
} from './extFs';
import { NamePromptModal, ConfirmModal } from '../panels/promptModals';

/** 菜单宿主需要的插件能力（结构化类型，免得反向依赖 main.ts）。 */
export interface PaneMenuHost {
  app: App;
  /** 此 Obsidian 能否原生打开库外文件（desktop 1.14.4+）。 */
  canOpenNativeExternal(): boolean;
  revealInSystem(abs: string): void;
  openWithSystem(abs: string): void;
  /** 重命名/删除后刷新挂载面板树。 */
  refreshMounts(): void;
  /** 库根路径（链接同步用）；取不到返回空串。 */
  vaultBasePath(): string;
}

/** 一个库外文件在当前标签页里的上下文。 */
export interface ExternalPaneTarget {
  abs: string;
  fileName: string;
  /** 目录行（目前只有挂载面板用，标签页恒为文件）。 */
  isDir?: boolean;
  /** 「在新窗口中打开」：用哪个视图类型、带什么 state 重建。 */
  popout?: { viewType: string; getState: () => Record<string, unknown> };
  /** 重命名落盘后的视图更新（新路径已由调用方刷新挂载树）。 */
  onRenamed?: (newAbs: string, newName: string) => void;
  /** 删除落盘后的视图更新（通常是关标签页）。 */
  onDeleted?: () => void;
}

// ------------------------------------------------------------------
// file-menu 双跳转发（与挂载面板同一套实现，抽出来共用）
// ------------------------------------------------------------------

/**
 * 把库外文件解析成 `vault.getAbstractFileByPath` 认得的 `file:` 形式。
 * 文件夹没有 TExternalFile 查找，返回 null（hop-2 适配器仍然会跑）。
 */
function externalFileLookupKey(abs: string): string {
  return `file:${abs.replace(/\\/g, '/')}`;
}

/**
 * 相对库根的逃逸路径：`E:/Vault` 之外的 `E:/Other/x.md` 变成 `../Other/x.md`。
 *
 * 为什么不能直接用绝对路径：插件（Shell Commands 是典型）把变量值拼成
 * `getVaultAbsolutePath() + '/' + file.path`，绝对路径会产出
 * `<vault>/E:/...` 这种垃圾，而 `../` 链经 OS 解析正好落在真实文件上
 * （绝对模式直接拼，相对模式用 Shell Commands spawn 时的 vault cwd）。
 */
export function vaultEscapePath(abs: string, vault: unknown): string {
  try {
    const adapter = (vault as { adapter?: { getBasePath?: () => string } } | undefined)?.adapter;
    const base = adapter?.getBasePath?.();
    if (!base) return abs;
    const a = abs.replace(/\\/g, '/').replace(/\/+$/, '');
    const b = base.replace(/\\/g, '/').replace(/\/+$/, '');
    const as = a.split('/');
    const bs = b.split('/');
    if (as[0].toLowerCase() !== bs[0].toLowerCase()) return abs; // 不同盘
    let i = 0;
    while (i < as.length && i < bs.length && as[i].toLowerCase() === bs[i].toLowerCase()) i++;
    const ups = bs.length - i;
    if (ups <= 0) return as.slice(i).join('/') || '/'; // 在库内
    return '../'.repeat(ups) + as.slice(i).join('/');
  } catch (e) {
    console.error('vaultEscapePath failed for', abs, e);
    return abs;
  }
}

/**
 * hop-2：一个 `instanceof TFile` 能过、path 却逃逸到库外的伪 TFile。
 * 只填第三方插件真正会读的字段（path/name/basename/extension/stat/parent）。
 */
export function makeExternalTFileAdapter(abs: string, vault: unknown): TFile | null {
  try {
    const norm = abs.replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    const name = slash >= 0 ? norm.slice(slash + 1) : norm;
    const dot = name.lastIndexOf('.');
    const fake = Object.create(TFile.prototype) as TFile;
    const f = fake as unknown as Record<string, unknown>;
    f.vault = vault;
    f.path = vaultEscapePath(abs, vault);
    f.name = name;
    f.basename = dot > 0 ? name.slice(0, dot) : name;
    f.extension = dot > 0 ? name.slice(dot + 1) : '';
    f.stat = { ctime: 0, mtime: 0, size: 0 };
    const parent = Object.create(TFolder.prototype) as TFolder;
    const p = parent as unknown as Record<string, unknown>;
    p.path = slash > 0 ? norm.slice(0, slash) : '/';
    p.name = slash > 0 ? norm.slice(0, slash).split('/').pop() || '' : '/';
    p.children = [];
    f.parent = parent;
    return fake;
  } catch (e) {
    console.error('makeExternalTFileAdapter failed for', abs, e);
    return null;
  }
}

/** hop-2 的文件夹版（挂载面板的目录行用）。 */
export function makeExternalTFolderAdapter(abs: string, vault: unknown): TFolder | null {
  try {
    const norm = abs.replace(/\\/g, '/').replace(/\/+$/, '');
    const slash = norm.lastIndexOf('/');
    const name = slash >= 0 ? norm.slice(slash + 1) : norm;
    const fake = Object.create(TFolder.prototype) as TFolder;
    const f = fake as unknown as Record<string, unknown>;
    f.vault = vault;
    f.path = vaultEscapePath(abs, vault);
    f.name = name || '/';
    f.children = [];
    f.isRoot = () => f.path === '/';
    const parent = Object.create(TFolder.prototype) as TFolder;
    const p = parent as unknown as Record<string, unknown>;
    p.path = slash > 0 ? norm.slice(0, slash) : '/';
    p.name = slash > 0 ? norm.slice(0, slash).split('/').pop() || '' : '/';
    p.children = [];
    p.isRoot = () => p.path === '/';
    f.parent = parent;
    return fake;
  } catch (e) {
    console.error('makeExternalTFolderAdapter failed for', abs, e);
    return null;
  }
}

/**
 * 转发原生 `file-menu` 事件，让这个菜单带上文件管理器该有的一切——
 * 最重要的是其他插件加的项。
 *
 * hop-1 把文件解析成 `TExternalFile`（`file:` 前缀查找，Obsidian 1.14.4+），
 * 处理器收到真 TAbstractFile，走 vault API 的项原样可用。中性 source 把核心
 * file-explorer 自己的 新建/重命名/删除 挡在外面（它们要么由上方的自建项
 * 提供，要么对库外文件无效）。hop-2 再以 TFile 伪适配器重发一次：按
 * `instanceof TFile` 门控的处理器（Shell Commands 等）会整个跳过
 * TExternalFile。
 *
 * 两跳都会把全套处理器重放一遍，所以按标题去重：LAST wins——hop-1 留下的项
 * 捕获的是 `file:` 前缀路径（插件拿它拼变量是垃圾），hop-2 适配器带的逃逸
 * 路径才能正确解析。分隔符没有标题，原样保留。`items` 是未公开字段（故
 * cast），去重是原地 splice，改的就是菜单正在显示的那个数组。
 *
 * 返回 hop-1 是否真的跑了（目录行没有 TExternalFile 查找），调用方可据此
 * 决定要不要补自己的「复制绝对路径」兜底。
 */
export function forwardFileMenuEvent(
  host: PaneMenuHost,
  menu: Menu,
  abs: string,
  isDir: boolean,
  source: string,
): boolean {
  if (!host.canOpenNativeExternal()) return false;
  const af = host.app.vault.getAbstractFileByPath(externalFileLookupKey(abs));
  if (af) {
    menu.addSeparator();
    try {
      host.app.workspace.trigger('file-menu', menu, af, source);
    } catch (e) {
      console.error('file-menu handler failed for', abs, e);
      return false;
    }
  }
  try {
    const adapter = isDir ? makeExternalTFolderAdapter(abs, host.app.vault) : makeExternalTFileAdapter(abs, host.app.vault);
    if (adapter) {
      host.app.workspace.trigger('file-menu', menu, adapter, isDir ? `${source}-tfolder` : `${source}-tfile`);
    }
  } catch (e) {
    console.error('file-menu (adapter) handler failed for', abs, e);
  }
  dedupeMenuByTitle(menu);
  return af != null;
}

/** 同标题只留最后一项（见 forwardFileMenuEvent 的 LAST wins 说明）。 */
export function dedupeMenuByTitle(menu: Menu): void {
  const items = (menu as unknown as { items: Array<{ titleEl?: { textContent?: string | null }; title?: unknown } | null> }).items;
  if (!Array.isArray(items)) return;
  const seen = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const t = (it?.titleEl?.textContent ?? (typeof it?.title === 'string' ? it.title : '') ?? '').trim();
    if (!t) continue;
    if (seen.has(t)) items.splice(i, 1);
    else seen.add(t);
  }
}

// ------------------------------------------------------------------
// 重命名 / 删除（弹窗 + fs + 链接同步），挂载面板与标签页菜单共用
// ------------------------------------------------------------------

/**
 * 重命名一个库外条目（同目录改名）。
 *
 * 已链接进库的节点跟着改名：链接名就是旧文件名，不拆链的话 isLinked 会继续
 * 「看见」旧名并误报已链接。注意 renameEntry(abs, newName) 在 abs 自己的父
 * 目录下改名，所以链接那里传裸名——传完整路径会被 validateEntryName 的非法
 * 字符检查拒掉（挂载面板实测踩过）。
 */
export function promptExternalRename(
  host: PaneMenuHost,
  abs: string,
  name: string,
  onRenamed: (newAbs: string, newName: string) => void,
): void {
  new NamePromptModal(
    host.app,
    { title: '重命名', initial: name, validate: validateEntryName },
    (input) => {
      if (!input || input === name) return;
      const r = renameEntry(abs, input);
      if (!r.ok) {
        new Notice(`重命名失败：${r.error ?? '未知错误'}`);
        return;
      }
      const base = host.vaultBasePath();
      const oldLink = base ? linkTargetFor(base, name, safeSegment(name)) : '';
      if (base && exists(oldLink)) {
        const rr = renameEntry(oldLink, input);
        if (!rr.ok) new Notice(`链接未同步改名：${rr.error ?? '未知错误'}`);
      }
      new Notice(`已重命名为 ${input}`);
      onRenamed(renameTarget(abs, input), input);
    },
  ).open();
}

/**
 * 删除一个库外条目：优先系统回收站，没有回收站（或系统拒绝）时二次确认后
 * 永久删除，绝不静默走不可恢复路径。
 */
export function promptExternalDelete(
  host: PaneMenuHost,
  abs: string,
  name: string,
  isDir: boolean,
  onDeleted: () => void,
): void {
  const typeStr = isDir ? '文件夹' : '文件';
  new ConfirmModal(
    host.app,
    {
      title: `删除${typeStr}`,
      body: `确定删除${typeStr}「${name}」${isDir ? '及其全部内容' : ''}吗？将移入系统回收站。`,
      confirmText: '删除',
      dangerous: true,
    },
    (ok) => {
      if (!ok) return;
      // 先拆链接：硬链接删掉只是去掉目录项，但留着会指向一个不再存在的名字。
      const base = host.vaultBasePath();
      const oldLink = base ? linkTargetFor(base, name, safeSegment(name)) : '';
      if (base && exists(oldLink)) removeLink(oldLink);
      void trashEntry(abs).then((r) => {
        if (r.ok) {
          new Notice('已移入回收站');
          onDeleted();
          return;
        }
        // 没有回收站（或系统拒绝）：二次确认后永久删除，绝不静默。
        new ConfirmModal(
          host.app,
          {
            title: '无法移入回收站',
            body: `${r.error ?? '此系统不支持回收站'}。要永久删除「${name}」吗？此操作不可恢复。`,
            confirmText: '永久删除',
            dangerous: true,
          },
          (ok2) => {
            if (!ok2) return;
            const rr = deletePermanent(abs, isDir);
            if (!rr.ok) new Notice(`删除失败：${rr.error ?? '未知错误'}`);
            else new Notice('已永久删除');
            onDeleted();
          },
        ).open();
      });
    },
  ).open();
}

// ------------------------------------------------------------------
// 菜单构建
// ------------------------------------------------------------------

/** 剪贴板写入，失败时把路径显示出来（总比无声失败好）。 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice('已复制绝对路径');
  } catch {
    new Notice(`路径：${text}`);
  }
}

/**
 * 给一个库外文件标签页构建完整的 pane 菜单。
 *
 * 调用方（视图的 onPaneMenu）应先 `super.onPaneMenu(menu, source)` 拿到底层
 * 分屏项，再调这里。注意转发用的 source 恒为中性（'logseq-external-pane'），
 * 不随调用方的 'more-options'/'tab-header' 变化：按 source 门控的核心处理器
 * （发布等）对库外文件无效，中性 source 正好把它们挡在外面——与挂载面板
 * 行右键菜单同一套取舍。
 */
export function buildExternalPaneMenu(
  host: PaneMenuHost,
  menu: Menu,
  target: ExternalPaneTarget,
): void {
  const { abs, fileName } = target;
  // 1) 先转发：其他插件的项先进来。中性 source（logseq-external-pane）把核心
  //    file-explorer 自己的新建/重命名/删除挡在外面；它能过的项（收藏、打开
  //    方式、合并…）对库外文件同样成立——它们走 hop-2 适配器的逃逸路径。
  forwardFileMenuEvent(host, menu, abs, target.isDir === true, 'logseq-external-pane');

  // 2) 自建项：全部作用在真实绝对路径上。放在转发之后，标题去重（LAST wins）
  //    时赢过核心那些对库外假路径无效的同名项。
  menu.addItem((item) =>
    item
      .setTitle('重命名')
      .setIcon('text-cursor-input' as never)
      .setSection('action')
      .onClick(() =>
        promptExternalRename(host, abs, fileName, (newAbs, newName) => {
          host.refreshMounts();
          target.onRenamed?.(newAbs, newName);
        }),
      ),
  );
  menu.addItem((item) =>
    item
      .setTitle('删除文件')
      .setIcon('trash-2' as never)
      .setSection('danger')
      .setWarning(true)
      .onClick(() =>
        promptExternalDelete(host, abs, fileName, target.isDir === true, () => {
          host.refreshMounts();
          target.onDeleted?.();
        }),
      ),
  );
  menu.addItem((item) =>
    item
      .setTitle('复制绝对路径')
      .setIcon('clipboard-copy' as never)
      .onClick(() => void copyText(abs)),
  );
  menu.addItem((item) =>
    item
      .setTitle('在系统资源管理器中显示')
      .setIcon('folder-open' as never)
      .setSection('system')
      .onClick(() => host.revealInSystem(abs)),
  );
  menu.addItem((item) =>
    item
      .setTitle('用系统默认应用打开')
      .setIcon('arrow-up-right' as never)
      .setSection('system')
      .onClick(() => host.openWithSystem(abs)),
  );
  // 「在新窗口中打开」：库内标签页有这一项（popout 窗口），库外同样能给——
  // 用本视图自己的 state 在新叶子里重建，内容从磁盘重读。
  if (target.popout && canPopout(host)) {
    const { viewType, getState } = target.popout;
    menu.addItem((item) =>
      item
        .setTitle('在新窗口中打开')
        .setIcon('picture-in-picture-2' as never)
        .setSection('open')
        .onClick(() => {
          const leaf = host.app.workspace.openPopoutLeaf?.();
          if (!leaf) return;
          void leaf.setViewState({ type: viewType, state: getState(), active: true } as ViewState);
        }),
    );
  }
  // 3) 自建项加完再去重一次：转发时那一遍去重发生在自建项之前，同标题的
  //    核心项（典型：「在系统资源管理器中显示」——它对库外假路径无效）会
  //    存活下来。LAST wins，我们自己的实现是后加的那个，因此赢。
  dedupeMenuByTitle(menu);
}

/** popout 窗口是否可用（仅桌面；openPopoutLeaf 只在支持时存在）。 */
function canPopout(host: PaneMenuHost): boolean {
  return typeof (host.app.workspace as { openPopoutLeaf?: unknown }).openPopoutLeaf === 'function';
}
