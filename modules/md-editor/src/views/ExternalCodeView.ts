/**
 * Code editor for a file OUTSIDE the vault.
 *
 * Why this exists rather than deferring to Code Files: that plugin's view is a
 * TextFileView, and measured, `setViewState` on `code-editor` with no TFile
 * mounts the "empty" placeholder — so there is no way to hand it a file the
 * vault has never indexed. It also exposes no plugin API (its only entry point
 * is a static method on the view class). Owning the view is the way to actually
 * open a code file.
 *
 * CodeMirror 6 is already a dependency of this plugin, so this is the same
 * editing substrate used in the block editor — real cursor handling, selection,
 * undo, and the language modes below — with saving redirected to Node fs.
 *
 * Markdown deliberately does NOT come here: it opens in the mount's block view,
 * which is what the user asked for.
 */

import { ItemView, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, parseLinktext, type ViewStateResult } from 'obsidian';
import { clipboard as electronClipboard } from 'electron';
import type * as monacoNS from 'monaco-editor';
// 运行时命名空间(Range/MouseTargetType 等枚举值)——与 code-editor 的
// monaco.ts 同一个 bundled 实例,不会产生第二份 Monaco。
import { monaco as monacoRuntime } from '../../../code-editor/src/editor/lazyMonaco';
// 代码编辑器:Monaco(开源 VS Code 内核)。语言解析/高亮/worker 见 src/editor/monaco.ts;
// LSP(补全/悬停/诊断/语义 token)的 Monaco 接线在 code-editor/src/lsp(与 SiYuan 同源)。
import { createEditor, setupMonaco, getLanguageByPath } from '../../../code-editor/src/editor/monaco';
import { encodeFileUri } from '../../../code-editor/src/lsp/lspHost';
import { monacoLspAttach } from '../../../code-editor/src/lsp/monacoLspBridge';
import { readTextAny, writeTextAny } from '../../../virtual-tree/src/features/remoteIO';
import { logOp } from '../features/logger';
import type LogseqEditorPlugin from '../main';
import { relativeDisplayPath } from '../features/codeFileKind';
import { setLeafTitle } from '../features/leafTitle';
import { virtualTreeOf } from '../../../virtual-tree/src/main';
import { applyHeaderPath, headerSegmentsFor, isUnderMount, matchMountFor } from './headerPath';
import { markLeafTouched } from './tabTouch';
import { HybridCodeEditor } from './hybridCodeEditor';
import { buildCodeExtLink, toExtPath } from '../../../virtual-tree/src/features/codeFileLinks';
import { buildExternalPaneMenu } from '../../../virtual-tree/src/features/externalPaneMenu';
import { isMarkdownFile } from '../../../virtual-tree/src/features/mountFilter';
import { applyMarkedTabIcons, markLeafTabIcon } from '../../../virtual-tree/src/features/tabIcon';
import { buildDiffOverlayDom } from '../../../virtual-tree/src/features/diffOverlayDom';
import { runFile, langFromExt } from '../../../code-editor/src/exec/runner';
import type { RunHandle } from '../../../code-editor/src/exec/pythonRunner';

export { relativeDisplayPath };

export const VIEW_TYPE_EXTERNAL_CODE = 'logseq-external-code';

export class ExternalCodeView extends ItemView {
  plugin: LogseqEditorPlugin;
  abs = '';
  fileName = '';
  /** Path shown in the header: relative to the mount root, which is what the
   *  user recognises. The absolute path stays available as a tooltip. */
  displayPath = '';
  /** The mount this file came from, so the header can say where it lives. */
  mountPath = '';
  /** 挂载名——视图头部路径的第一段（「挂载名 / 子目录 / 文件名」） */
  mountLabel = '';
  /**
   * 文件来自库内（宿主把库内代码扩展名也映射到本视图）还是库外挂载。
   * 只影响提示文案（「库内」/「库外」徽标），读写完全一样——都是文件本体。
   */
  inVault = false;
  /** 库内文件的 TFile（registerExtensions / openVaultFileInCodeEditor 路径解析）。
   *  save-control 的探针据此把目标归为 vault 目标——快照键、File History、
   *  右键菜单都按 vault 路径走，与普通笔记一致。库外文件为 null。 */
  vaultFile: TFile | null = null;
  /** 运行输出区(首次运行时创建) */
  private runOutputEl: HTMLPreElement | null = null;
  private runHandle: RunHandle | null = null;
  /** LSP 接线(补全/悬停/诊断/语义 token;无 server 或 LSP 关闭时为空数组) */
  private lspDisposables: monacoNS.IDisposable[] = [];
  /** 视图级 disposables(行号右键菜单等;disposeEditors 一并释放) */
  private viewDisposables: monacoNS.IDisposable[] = [];
  /**
   * 待跳转的文件行:`[[file#L42]]` 行锚 / openExternalInView 的 line 进来时
   * 编辑器可能尚未挂载(setState 先于编辑器就绪、或叶子复用不重挂),先存这里,
   * 由 mount() 末尾或 setState 的「编辑器已在」分支消费。
   */
  private pendingRevealLine: number | null = null;
  /** 行范围锚的结束行(mount 晚于 setEphemeralState 的竞态里与 pendingRevealLine 同批消费) */
  private pendingRevealEnd: number | null = null;

  /** 老 state 没有挂载名时，按最长前缀匹配在挂载配置里找回来。 */
  private mountLabelFromSettings(): string {
    const mounts = virtualTreeOf(this.app)?.settings.externalMounts ?? [];
    const full = this.abs.replace(/\\/g, '/').toLowerCase();
    let best = '';
    let bestLen = -1;
    for (const m of mounts) {
      const root = String(m.path ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
      if (!root || !full.startsWith(root + '/')) continue;
      if (root.length > bestLen) {
        bestLen = root.length;
        best = m.label || '';
      }
    }
    return best;
  }
  /** Public so the e2e probe can read the buffer without reaching into privates. */
  editor: monacoNS.editor.IStandaloneCodeEditor | null = null;
  /** 库记录修改对比(2026-11-21 用户):当前文件的库内相对路径与装点状态。 */
  private vaultPath: string | null = null;
  private diffCollection: monacoNS.editor.IEditorDecorationsCollection | null = null;
  private diffCollectionOwner: monacoNS.editor.IStandaloneCodeEditor | null = null;
  private diffLineSet = new Set<number>();
  private diffHandlerFor: monacoNS.editor.IStandaloneCodeEditor | null = null;
  private diffZoneId: string | null = null;
  private diffZoneOwner: monacoNS.editor.IStandaloneCodeEditor | null = null;
  private diffZoneOpen = false;
  private lastDiskData = '';
  // 加载失败标记:挡住 flush,防止把空缓冲覆盖回远端(BlockEditorView 同款)
  private loadFailed = false;
  private saveTimer: number | null = null;
  /**
   * 是否有未落盘的编辑。
   *
   * 必须有这个标记:混合模式下重建会把注释行的前导缩进归一到列 0(见
   * features/codeDoc 的 v1 边界),所以「没动过的文件」重建结果也可能与原文件
   * 不同。只靠「重建结果 ≠ lastDiskData」判断该不该写,会让打开即关的文件被
   * 悄悄改格式。现在改成只写真正编辑过的。
   */
  private dirty = false;

  /**
   * 混合模式引擎:非 null 表示当前以「注释区 = Logseq 块编辑器(view zone 内嵌)」
   * 呈现,此时代码区与注释区分居两处,保存要走引擎重建而不是整台 Monaco 的
   * getValue()。纯源码模式下为 null。
   */
  private hybridEngine: HybridCodeEditor | null = null;
  /**
   * 当前文件对混合模式的呈现覆盖。null = 跟随设置里的默认值。
   * 来源:打开入口的 state.hybrid / 布局恢复的持久化 state(视图头部的切换按钮
   * 已按用户 2026-10-29 要求移除,不再产生新的运行时覆盖)。
   */
  private hybridOverride: boolean | null = null;
  /** 原文件是否 CRLF(混合模式落盘时还原) */
  private crlf = false;

  /** 设置里的默认值,可被本文件的临时覆盖反向取值。
   *  默认纯代码编辑器(用户 2026-10-18 决策):externalCodeHybrid 缺省/为 false
   *  都走纯源码;显式存过 true 的老设置仍可翻回混合模式。 */
  private hybridDefault(): boolean {
    return this.plugin.settings.externalCodeHybrid === true;
  }

  /** 当前生效的混合模式(临时覆盖优先,否则设置默认) */
  get hybrid(): boolean {
    return this.hybridOverride ?? this.hybridDefault();
  }

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_EXTERNAL_CODE;
  }

  getDisplayText(): string {
    return this.fileName || '代码文件';
  }

  getIcon(): string {
    return 'file-code';
  }

  getState(): Record<string, unknown> {
    const state: Record<string, unknown> = {
      abs: this.abs,
      name: this.fileName,
      mountPath: this.mountPath,
      mountLabel: this.mountLabel,
    };
    // 临时覆盖随 state 持久化:布局恢复时纯源码/混合不退回设置默认值
    if (this.hybridOverride !== null) state.hybrid = this.hybridOverride;
    return state;
  }

  /**
   * 标签页头部「更多」（⋮，pane menu）：文件操作总入口
   * （2026-11-24 用户：更多按钮对接一些文件操作，比如其他打开方式）。
   *
   * 本视图是自定义 ItemView：库外文件没有 TFile、库内文件也没走 FileView
   * 那条链，基类只会给分屏项。这里复用 virtual-tree 的 buildExternalPaneMenu
   * ——它在挂载面板右键菜单上已验证，作用在真实绝对路径上：重命名 / 删除 /
   * 复制链接 / 复制绝对路径 / 同步到库 / 在文件管理器显示 / 系统默认应用打开
   * / 在新窗口打开，外加「打开方式」子菜单（自定义应用，走
   * settings.openWithApps）与其他插件 file-menu 的转发项。
   * 代码文件再补两项自己的：重新从磁盘加载、混合/纯源码切换（.md 才有意义）。
   */
  override onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (!this.abs) return;
    const host = this.plugin.headerMenuHost.paneMenuHost;
    if (!host) return;
    buildExternalPaneMenu(host, menu, {
      abs: this.abs,
      fileName: this.fileName,
      popout: { viewType: VIEW_TYPE_EXTERNAL_CODE, getState: () => this.getState() },
      onRenamed: (newAbs, newName) => void this.handleRenamed(newAbs, newName),
      onDeleted: () => void this.leaf.detach(),
      extraItems: (m) =>
        m.addItem((item) =>
          item
            .setTitle('重新从磁盘加载')
            .setIcon('refresh-cw' as never)
            .setSection('open')
            .onClick(() => void this.reloadFromDisk()),
        ),
      openWithExtras: (sub) => {
        // 应用内备选呈现（混合模式 = Markdown 注释区走块编辑器）。只对带
        // Markdown 注释区的文件有意义；纯源码文件两个模式等价，不给假选项。
        if (!isMarkdownFile(this.fileName) && this.plugin.settings.externalCodeHybrid !== true) return;
        const toHybrid = !this.hybrid;
        sub.addItem((si) =>
          si
            .setTitle(toHybrid ? '以混合模式打开（注释区用块编辑器）' : '以纯源码模式打开')
            .setIcon('file-code' as never)
            .onClick(() => void this.setHybridMode(toHybrid)),
        );
      },
    });
  }

  /** 菜单里切换混合/纯源码呈现：先落盘再重挂（重挂会从磁盘重读）。 */
  private async setHybridMode(hybrid: boolean): Promise<void> {
    if (hybrid === this.hybrid) return;
    await this.flush(false);
    this.hybridOverride = hybrid;
    await this.mount();
    await this.applyVaultDiffDecorations();
  }

  /**
   * 菜单「重命名」落盘之后的视图跟随。
   *
   * 改名是在磁盘上完成的（promptExternalRename），所以这里不能照旧路径
   * flush——那会把旧名字写回来。有未落盘编辑时把缓冲区直接落到**新路径**，
   * 再更新路径/标题并重挂。
   */
  private async handleRenamed(newAbs: string, newName: string): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this.editor) {
      try {
        const data = this.hybridEngine ? this.hybridEngine.reconstruct() : this.editor.getValue();
        await writeTextAny(newAbs, data);
        this.lastDiskData = data;
        this.dirty = false;
      } catch (e) {
        new Notice(`保存到新文件名失败：${String(e).slice(0, 100)}`);
      }
    }
    this.abs = newAbs;
    this.fileName = newName;
    if (this.vaultPath) {
      this.vaultPath = this.vaultPath.replace(/[^/]+$/, newName);
      const f = this.app.vault.getAbstractFileByPath(this.vaultPath);
      this.vaultFile = f instanceof TFile ? f : null;
    }
    this.displayPath = relativeDisplayPath(this.abs, this.mountPath, this.fileName);
    setLeafTitle(this.leaf, this.fileName);
    this.markTabThemeIcon();
    await this.mount();
    await this.applyVaultDiffDecorations();
    const segments = headerSegmentsFor(
      this.app,
      this.abs,
      this.displayPath || this.fileName,
      this.mountLabel || this.mountLabelFromSettings(),
    );
    applyHeaderPath(this.containerEl, segments, this.plugin.headerMenuHost, this.abs);
  }

  /** 标签页主题图标(2026-11-21 用户):视图知道文件名的第一时间就主动标记
   * +应用——恢复未激活的叶没有 layout-change,外部轮询永远等不到 fileName。 */
  private markTabThemeIcon(): void {
    if (!this.abs || !this.fileName) return;
    markLeafTabIcon(this.leaf, { name: this.fileName, rel: this.abs });
    applyMarkedTabIcons(this.app, [this.leaf]);
    // setIcon/view 加载完成会重画标签头,延迟补一次(同 virtual-tree 开路径)。
    window.setTimeout(() => applyMarkedTabIcons(this.app, [this.leaf]), 120);
  }

  /** 库记录对比 API(鸭式取 LifePlugin,不静态 import 防模块环)。 */
  private lifeDiffApi(): {
    getEditorDiff?: (path: string) => {
      diff: {
        added: number[];
        modified: number[];
        rows?: Array<{ beforeLine: number | null; afterLine: number | null; kind: 'ctx' | 'add' | 'mod' | 'del'; text: string }>;
      };
    } | null;
    revertRecordFile?: (path: string) => Promise<boolean>;
  } | null {
    const host = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { moduleInstance?: (id: string) => unknown } | undefined> };
    }).plugins?.plugins?.['obsidian-my-obsidian'];
    return (
      (host?.moduleInstance?.('life') as {
        getEditorDiff?: (path: string) => { diff: { added: number[]; modified: number[] } } | null;
        openRecordDiffModal?: (path: string) => void;
      } | undefined) ?? null
    );
  }

  /** 外部内容变更(git 撤回等)后强制从磁盘重读并刷新编辑器。 */
  async reloadFromDisk(): Promise<void> {
    await this.mount();
    await this.applyVaultDiffDecorations();
  }

  /** 应用库记录修改装点(行首竖条:新增绿/修改蓝)+ 对比覆盖层(有差异自动
   * 展开,点击竖条开/收)。数据源 = LifePlugin 的编辑器对比登记表。 */
  private async applyVaultDiffDecorations(): Promise<void> {
    if (!this.editor) return;
    const life = this.lifeDiffApi();
    const entry = this.vaultPath && life?.getEditorDiff ? life.getEditorDiff(this.vaultPath) : null;
    this.diffLineSet.clear();
    const decos: monacoNS.editor.IModelDeltaDecoration[] = [];
    if (entry) {
      for (const l of entry.diff.added) {
        this.diffLineSet.add(l);
        decos.push({
          range: { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1 },
          options: { isWholeLine: true, className: 'lgp-diff-line-add', stickiness: monacoRuntime.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        });
      }
      for (const l of entry.diff.modified) {
        this.diffLineSet.add(l);
        decos.push({
          range: { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1 },
          options: { isWholeLine: true, className: 'lgp-diff-line-mod', stickiness: monacoRuntime.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        });
      }
    }
    // 池化编辑器每次 mount 可能换实例:集合归属不是当前 editor 就重建,
    // 否则 clear/set 打在已停放的旧实例上,新编辑器永远没有装点(实测)。
    if (this.diffCollection && this.diffCollectionOwner === this.editor) {
      this.diffCollection.clear();
      this.diffCollection.set(decos);
    } else {
      this.diffCollection = this.editor.createDecorationsCollection(decos);
      this.diffCollectionOwner = this.editor;
    }
    // 跳到首个差异行(VSCode 行为:点对比进来直接看到改动处)。延迟一拍:
    // 池化编辑器重挂后尺寸未收敛,立即 reveal 用旧几何计算会落空(实测)。
    const firstDiff = Math.min(...(decos.length ? decos.map((d) => d.range.startLineNumber) : [Infinity]));
    const edNow = this.editor;
    if (Number.isFinite(firstDiff) && edNow) {
      window.setTimeout(() => {
        try {
          edNow.revealLineInCenter(firstDiff);
        } catch {
          /* 模型可能已换,忽略 */
        }
      }, 150);
    }
    // 对比覆盖层:有差异自动展开;点击竖条开/收(每编辑器实例注册一次)。
    if (this.diffHandlerFor !== this.editor || !this.editor) {
      const edNow = this.editor;
      this.diffHandlerFor = edNow;
      if (edNow) {
        const editor: monacoNS.editor.IStandaloneCodeEditor = edNow;
        editor.onMouseDown((e) => {
          const line = e.target.position?.lineNumber;
          // 命中放宽 L/L+1:末行覆盖层的 hit-test 会偏一行(实测 117 解析成 116)
          if (line === undefined || (!this.diffLineSet.has(line) && !this.diffLineSet.has(line + 1))) return;
          // 竖条区域 = 内容区左缘 12px 内(装点画在行首)。用 .view-lines 的
          // 左缘做参照(稳定),不依赖事件 target 元素(monaco 报的是下层文本)。
          const dom = editor.getDomNode();
          if (!dom) return;
          const linesEl = dom.querySelector('.view-lines');
          const left = linesEl?.getBoundingClientRect().left ?? null;
          if (left === null || e.event.posx - left > 12) return;
          this.toggleDiffZone(!this.diffZoneOpen);
        });
      }
    }
    // 覆盖层展开状态随编辑器实例失效(池化换实例/重挂后重建)
    if (this.diffZoneOwner !== this.editor) {
      this.diffZoneId = null;
      this.diffZoneOpen = false;
      this.diffZoneOwner = this.editor;
    }
    if (entry && !this.diffZoneOpen && !this.diffZoneId) this.toggleDiffZone(true);
  }

  /** 开/收对比覆盖层(monaco 视区:插入在首个差异行下方,推挤内容)。
   * DOM = virtual-tree 的 buildDiffOverlayDom(VSCode peek 同款:红删/绿增/
   * 双行号,头部撤回/关闭)。 */
  private toggleDiffZone(open: boolean): void {
    const ed = this.editor;
    const vp = this.vaultPath;
    const life = this.lifeDiffApi();
    if (!ed || !vp) return;
    const model = ed.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    if (this.diffZoneOwner !== ed) {
      this.diffZoneId = null;
      this.diffZoneOwner = ed;
      this.diffZoneOpen = false;
    }
    if (this.diffZoneId) {
      const stale = this.diffZoneId;
      ed.changeViewZones((a) => a.removeZone(stale));
      this.diffZoneId = null;
      this.diffZoneOpen = false;
      if (!open) return;
    }
    if (!open) return;
    const entry = life?.getEditorDiff ? life.getEditorDiff(vp) : null;
    if (!entry) return;
    const rows = (entry.diff.rows ?? []).map((r) => ({
      bl: r.beforeLine,
      al: r.afterLine,
      k: r.kind,
      t: r.text,
    }));
    const dom = buildDiffOverlayDom({
      title: vp,
      rows,
      onRevert: () => {
        void life?.revertRecordFile?.(vp).then(() => this.reloadFromDisk());
      },
      onClose: () => this.toggleDiffZone(false),
    });
    const firstDiff = Math.min(...(rows.length ? rows.map((r) => r.al ?? r.bl ?? lineCount) : [lineCount]));
    const height = rows.length * 18 + 34;
    ed.changeViewZones((a) => {
      this.diffZoneId = a.addZone({
        afterLineNumber: Math.min(Math.max(1, firstDiff), lineCount),
        heightInPx: height,
        domNode: dom,
      });
    });
    this.diffZoneOpen = true;
  }

  async onOpen(): Promise<void> {
    // Mounting waits for setState: Obsidian calls onOpen BEFORE setState, so
    // mounting here would build an empty editor for a file whose path and
    // content have not arrived yet — and the state that carries them is the
    // only place they exist.
    //
    // 2026-11-19 实测修复:这里的 mount 此前是无条件执行的——空挂载建出空
    // 编辑器,随后的 setState 因 `!this.editor` 跳过重挂,空编辑器永久保留
    // (用户报「点代码文件打开是空的」的根因)。删掉这里的 mount:setState
    // 末尾的 `!this.editor && this.abs` 触发真挂载(restore 路径同款)。
    // 行级反链的刷新源:笔记保存(changed)/索引批解析完成(resolved)。
    // registerEvent 随视图卸载自动清理;扫描本身 600ms 防抖。
    this.registerEvent(this.app.metadataCache.on('changed', () => this.scheduleLineLinksScan()));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.scheduleLineLinksScan()));
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as {
      abs?: string;
      name?: string;
      content?: string;
      mountPath?: string;
      mountLabel?: string;
      /** 库内文件:Obsidian 的 registerExtensions 路径传的是 {file}(vault 相对路径)。 */
      file?: string;
      /** 打开入口的呈现覆盖(false = 纯源码;缺省跟随设置) */
      hybrid?: boolean;
      /** 行锚:openExternalInView(叶子复用)把 `#L42` 解析后的行号直接带进来 */
      line?: number;
    };
    if (typeof s.abs === 'string') this.abs = s.abs;
    if (typeof s.name === 'string') this.fileName = s.name;
    // 库记录修改对比:库内相对路径(库外文件无 → 不参与装点)
    this.vaultPath = typeof s.file === 'string' && s.file ? s.file : null;
    if (typeof s.content === 'string') this.lastDiskData = s.content;
    if (typeof s.mountPath === 'string') this.mountPath = s.mountPath;
    if (typeof s.mountLabel === 'string') this.mountLabel = s.mountLabel;
    if (typeof s.line === 'number' && Number.isFinite(s.line) && s.line >= 1) {
      this.pendingRevealLine = Math.floor(s.line);
    }
    // 打开入口的呈现覆盖(右键「纯代码编辑器」传 false;缺省跟随设置)
    if (typeof s.hybrid === 'boolean') this.hybridOverride = s.hybrid;
    // 库内文件:宿主把代码扩展名 registerExtensions 到本视图,Obsidian 传
    // {file}(vault 相对路径)。解析成真实路径 + 标记来源,徽标与提示随之区分。
    if (!this.abs && typeof s.file === 'string' && s.file) {
      this.inVault = true;
      const adapter = this.plugin.app.vault.adapter as unknown as {
        getFullPath?: (p: string) => string;
        basePath?: string;
      };
      if (typeof adapter.getFullPath === 'function') {
        try {
          this.abs = adapter.getFullPath(s.file);
        } catch {
          /* fall through */
        }
      }
      if (!this.abs) {
        const base = adapter.basePath ?? '';
        this.abs = base ? `${base.replace(/[\\/]+$/, '')}/${s.file}` : s.file;
      }
      if (!this.fileName) {
        this.fileName = s.file.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? s.file;
      }
      const resolved = this.plugin.app.vault.getAbstractFileByPath(s.file);
      this.vaultFile = resolved instanceof TFile ? resolved : null;
    }
    // state 没带 mountPath（部分打开入口不传、老页签恢复）或挂载已挪位 →
    // 按最长前缀从挂载配置找回：否则 displayPath 退成裸文件名，头部面包屑
    // 丢掉挂载内的整段子目录链（2026-10-29 用户报：深 5 层的文件只剩
    // 「挂载名 / 文件名」，中间 4 层全没）。
    if (this.abs && (!this.mountPath || !isUnderMount(this.abs, this.mountPath))) {
      const m = matchMountFor(this.abs, virtualTreeOf(this.app)?.settings.externalMounts ?? []);
      if (m) {
        this.mountPath = m.path;
        if (!this.mountLabel) this.mountLabel = m.label;
      }
    }
    this.displayPath = relativeDisplayPath(this.abs, this.mountPath, this.fileName);
    this.markTabThemeIcon();
    await super.setState(state, result);
    // Now the path is known; build the editor if onOpen ran before us.
    if (!this.editor && this.abs) await this.mount();
    await this.applyVaultDiffDecorations();
    // 行锚落地:新挂载的由 mount() 末尾消费;叶子复用(编辑器已在、不重挂)在这里跳。
    if (this.pendingRevealLine !== null) {
      const n = this.pendingRevealLine;
      const endN = this.pendingRevealEnd;
      this.pendingRevealLine = null;
      this.pendingRevealEnd = null;
      this.revealLine(n);
      if (endN !== null && endN > n && this.editor) {
        try {
          const lastCol = this.editor.getModel()?.getLineMaxColumn(endN) ?? 1;
          this.editor.setSelection({ startLineNumber: n, startColumn: 1, endLineNumber: endN, endColumn: lastCol });
        } catch {
          /* 越界行:仅跳转 */
        }
      }
    }
    // 视图头部的完整路径（挂载名 / 子目录 / …；库内文件则是 / + 库内目录链）：
    // 库外文件没有库内路径，Obsidian 不会给自定义视图生成目录链。
    const segments = headerSegmentsFor(
      this.app,
      this.abs,
      this.displayPath || this.fileName,
      this.mountLabel || this.mountLabelFromSettings(),
    );
    applyHeaderPath(this.containerEl, segments, this.plugin.headerMenuHost, this.abs);
  }

  async onClose(): Promise<void> {
    this.hideGutterHover();
    await this.flush();
    this.disposeEditors();
  }

  /**
   * 原生 `[[code.py#L42]]` 点击路由:Obsidian 对非 md 文件把链接 subpath 作为
   * ephemeral state 送达视图(VideoView 的 `#t=` 时间戳同款机制,无需任何
   * openLinkText patch)。解析出行锚就跳转,其余 subpath 交回基类。
   */
  setEphemeralState(state: unknown): void {
    const subpath = (state as { subpath?: string } | null)?.subpath ?? null;
    // 行锚:#L42(单行跳转)与 #L10-L20(范围跳转+选中——嵌入块编辑按钮落位
    // 用,2026-11-19 阶段 B)。
    const m = subpath ? /^#?L(\d+)(?:-L(\d+))?$/.exec(subpath) : null;
    if (m) {
      const n = Number(m[1]);
      const end = m[2] ? Number(m[2]) : n;
      if (this.editor) {
        this.revealLine(n);
        if (end > n) {
          // 范围锚:跳到起始行后选中范围(Monaco 选中,行尾含换行前)
          try {
            const lastCol = this.editor.getModel()?.getLineMaxColumn(end) ?? 1;
            this.editor.setSelection({ startLineNumber: n, startColumn: 1, endLineNumber: end, endColumn: lastCol });
          } catch {
            /* 越界行:仅跳转 */
          }
        }
      } else {
        this.pendingRevealLine = n; // mount() 末尾消费(mount 晚于本调用的竞态)
        if (end > n) this.pendingRevealEnd = end;
      }
      return;
    }
    super.setEphemeralState(state as never);
  }

  /**
   * 跳转到文件行(库内/库外 `[[file#L42]]` 行锚、行号右键共用)。
   *
   * 纯源码模式 Monaco 行 == 文件行;混合模式 gutter 显示的是真实文件行,
   * 经引擎逆映射回 Monaco 行(注释区是块编辑器,没有 Monaco 落点,直接放弃)。
   * 跳完短时高亮该行(BlockEditorView 的 .block-revealed 同款反馈)。
   */
  revealLine(fileLine: number): void {
    const editor = this.editor;
    if (!editor) return;
    let monacoLine = fileLine;
    if (this.hybridEngine) {
      const mapped = this.hybridEngine.monacoLineOfFile(fileLine);
      if (mapped === null) return;
      monacoLine = mapped;
    }
    const model = editor.getModel();
    if (model && monacoLine > model.getLineCount()) monacoLine = model.getLineCount();
    if (monacoLine < 1) monacoLine = 1;
    editor.setPosition({ lineNumber: monacoLine, column: 1 });
    editor.revealLineInCenter(monacoLine);
    editor.focus();
    // IRange 是纯结构对象,不必经 monacoRuntime.Range 构造
    const deco = editor.createDecorationsCollection([
      {
        range: { startLineNumber: monacoLine, startColumn: 1, endLineNumber: monacoLine, endColumn: 1 },
        options: { isWholeLine: true, className: 'logseq-external-code-line-flash', zIndex: 1 },
      },
    ]);
    window.setTimeout(() => deco.clear(), 1200);
  }

  /**
   * save-control「不保存并关闭」的丢弃请求(鸭子类型调用)。
   * 必须由视图自己携带状态:onClose 的冲刷是无条件的——不在这里短路,用户
   * 明确选了丢弃,关闭时缓冲仍被写盘(BlockEditorView 2026-10-24 同款事故)。
   * 清掉 dirty 并让后续一切 flush 都变空操作。
   */
  discardPendingChanges(): void {
    this.discardRequested = true;
    this.dirty = false;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private discardRequested = false;

  /** 当前缓冲区全文(混合模式按区块重建,纯源码模式取 Monaco 全文)。 */
  private currentBuffer(): string {
    if (this.hybridEngine) return this.hybridEngine.reconstruct();
    return this.editor ? this.editor.getValue() : this.lastDiskData;
  }

  /** 销毁 Monaco 实例与混合引擎( FragmentHost / ResizeObserver 随引擎卸载)。 */
  private disposeEditors(): void {
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
    for (const d of this.lspDisposables) d.dispose();
    this.lspDisposables = [];
    if (this.hybridEngine) {
      this.hybridEngine.unload();
      this.hybridEngine = null;
      // 引擎的 onunload 已 dispose 自己的 editor/model
      this.editor = null;
      return;
    }
    const model = this.editor?.getModel();
    this.editor?.dispose();
    model?.dispose();
    this.editor = null;
  }

  /** 防抖自动保存(与库内编辑器同节奏:不是每敲一个键就写盘)。
   *  save-control 可经 configureAutoSave 接管这里的节奏(见 autoSaveOverride)。 */
  private scheduleSave(): void {
    this.dirty = true;
    // 编辑过的 tab 对「复用/替换」保护(见 tabTouch.ts;落盘不清,对齐原生 md)
    markLeafTouched(this.leaf);
    const cfg = this.autoSaveOverride;
    if (cfg && !cfg.enabled) {
      // save-control 关掉自动落盘:只记脏,不排定时器——落盘交给手动保存、
      // 关闭提示或退出冲刷(与 BlockEditorView 库外模式的接管语义一致)。
      if (this.saveTimer !== null) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      return;
    }
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), cfg?.delayMs ?? 900);
  }

  /** save-control 的接管配置(不存在 = 视图自带 900ms 防抖)。 */
  private autoSaveOverride: { enabled: boolean; delayMs: number } | null = null;

  /** save-control 的库外保存探针:报告未落盘的编辑(标签页圆点/关闭提示/调度器)。 */
  isDirty(): boolean {
    return this.dirty;
  }

  /** save-control 接管自动保存节奏(对齐 BlockEditorView 的同款探针)。 */
  configureAutoSave(o: { enabled: boolean; delayMs: number }): void {
    this.autoSaveOverride = { enabled: o.enabled, delayMs: Math.max(1, o.delayMs) };
    // 节奏变了就让已脏的缓冲按新规则重排(关自动保存会当场撤掉挂起的定时器)。
    if (this.dirty) this.scheduleSave();
  }

  // ------------------------------------------------------------------

  private async mount(): Promise<void> {
    // 重挂载(切换混合/源码、设置变更)前先销毁旧的:
    // contentEl.empty() 只清 DOM,M Monaco 实例与 FragmentHost 组件会泄漏,
    // 且它们的 ResizeObserver 还盯着已脱离文档的容器。
    this.disposeEditors();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-external-code-view');

    // The banner is optional and, when hidden, GONE — not compacted. Keeping a
    // one-line version still left a strip at the top, which is exactly what
    // turning the setting off is meant to remove. The file still autosaves on
    // the usual debounce, so nothing is lost by not showing it.
    if (this.plugin.settings.externalBanner) {
      const banner = contentEl.createDiv({ cls: 'logseq-external-banner' });
      banner.createSpan({ cls: 'logseq-external-banner-text', text: this.fileName });
      // Relative to the mount root — that is the name the user recognises. The
      // absolute path stays one hover away, since a linked file and an unlinked
      // one resolve to different places and that is worth being able to check.
      const pathEl = banner.createSpan({
        cls: 'logseq-external-banner-path',
        text: this.displayPath || this.fileName,
      });
      pathEl.setAttribute('title', this.abs);
      banner.createSpan({
        cls: 'logseq-external-badge',
        text: this.inVault ? '库内' : '库外',
      });
      const status = banner.createSpan({ cls: 'logseq-external-hint', text: '与原文件实时同步' });
      status.setAttribute('title', '保存时写回原文件');
      const saveBtn = banner.createEl('button', { cls: 'logseq-external-save', text: '保存' });
      saveBtn.addEventListener('click', () => void this.flush(true));
    }
    // 运行入口改编辑器右键菜单(2026-11-21 用户「运行按钮放右键菜单」):顶条的
    // ▶运行 与 banner 关闭后的孤立按钮都撤——右键即达,入口不再随 banner 开关
    // 消失(2026-11-01 报障的根因一并消除)。可执行扩展名才挂(py / js / sh / ps1…),
    // 与代码块 ▶ 走同一条执行路径 runCurrentFile。挂载点在编辑器就绪之后。

    const host = contentEl.createDiv({ cls: 'logseq-external-code-host' });

    let content = this.lastDiskData;
    if (!content && this.abs) {
      try {
        content = await readTextAny(this.abs);
        this.loadFailed = false;
      } catch (e) {
        this.loadFailed = true;
        new Notice(`无法读取 ${this.fileName}：${String(e).slice(0, 100)}`);
        content = '';
      }
    }
    this.lastDiskData = content;
    this.crlf = content.includes('\r\n');

    setupMonaco(this.plugin);

    // 语言由路径扩展名决定(Monaco basic-languages + TS worker);高亮与
    // VS Code 同源。保存仍走原防抖链路,Ctrl/Cmd+S 即时落盘。
    const language = getLanguageByPath(this.abs);

    if (this.hybrid) {
      // 混合模式:注释区交给 Logseq 块编辑器(view zone 内嵌),代码区仍是这台
      // Monaco。整文件无注释时 buildCodeDoc 只切出一个 code 区,观感与纯源码
      // 模式一致(仅行号映射),所以不必为「没注释的文件」特判。
      const engine = new HybridCodeEditor(this.plugin);
      engine.load();
      engine.mount({
        container: host,
        lang: language,
        value: this.crlf ? content.replace(/\r\n/g, '\n') : content,
        crlf: this.crlf,
        onSave: () => void this.flush(true),
        onChange: () => this.scheduleSave(),
      });
      this.hybridEngine = engine;
      this.editor = engine.getEditor();
    } else {
      this.hybridEngine = null;
      const docUri = encodeFileUri(this.abs);
      // 代码编辑器设置（virtual-tree 设置节「代码编辑器」，思源同款对齐）：
      // 字号/自动换行/行号。跨模块防御式读取（virtualTreeOf 同款）。
      let codeFontSize = 13;
      let codeWordWrap = false;
      let codeLineNumbers = true;
      try {
        const hostPlugin = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.['obsidian-my-obsidian'];
        const vt = (hostPlugin as { moduleInstance?: (id: string) => { settings?: Record<string, unknown> } } | undefined)?.moduleInstance?.('virtual-tree');
        const vtSettings = vt?.settings;
        if (vtSettings) {
          if (typeof vtSettings.codeFontSize === 'number' && vtSettings.codeFontSize > 0) codeFontSize = vtSettings.codeFontSize;
          codeWordWrap = vtSettings.codeWordWrap === true;
          codeLineNumbers = vtSettings.codeLineNumbers !== false;
        }
      } catch { /* 防御：读不到走默认 */ }
      this.editor = createEditor(host, {
        value: content,
        language,
        fontSize: codeFontSize,
        wordWrap: codeWordWrap,
        // 行号经渲染函数:被笔记 [[file#L42]] 引用的行号着色(见 renderGutterNumber)
        lineNumbersFn: (n: number) => this.renderGutterNumber(n),
        lineNumbers: codeLineNumbers,
        // model 绑真实文件 uri:LSP(补全/悬停/诊断/语义 token)按路径定位文档
        uri: docUri,
        onSave: () => void this.flush(true),
        onChange: () => this.scheduleSave(),
      });
      // LSP:basedpyright 等语言服务,含语义 token 着色(VS Code 同款);
      // 无匹配 server 或 LSP 关闭时 attach 返回空数组,零开销
      this.lspDisposables = monacoLspAttach(this.plugin, this.editor, language, docUri);
    }
    this.editor?.focus();
    // 运行入口:编辑器右键菜单(顶条/孤立按钮已撤,见上方 banner 注释)
    if (this.editor && langFromExt(this.fileName)) {
      this.editor.addAction({
        id: 'logseq-external-run-file',
        label: '▶ 运行',
        keybindings: [],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.4,
        run: () => void this.runCurrentFile(),
      });
    }
    // The leaf's own view header caches the name it was mounted with; on a fresh
    // mount that is nothing, on a re-mount it is the previous file. Writing it
    // here covers both.
    //
    // File name only — NOT the mount-relative path. The header now carries the
    // full path as breadcrumbs (挂载名 / 子目录 / …), so putting the path in the
    // title as well spelled it out twice (`挂载库/sub/sub/code.ts`).
    setLeafTitle(this.leaf, this.fileName);

    // 行号 gutter 右键(复制到行的链接 / 复制文件链接)+ 反链悬浮
    if (this.editor) {
      this.attachGutterContextMenu(this.editor);
      this.attachGutterHover(this.editor);
    }
    // 行锚(#L42 / openExternalInView line):编辑器就绪后消费
    if (this.pendingRevealLine !== null) {
      const n = this.pendingRevealLine;
      this.pendingRevealLine = null;
      this.revealLine(n);
    }
    // 行级反链扫描(结果落 gutter 着色与悬浮数据)
    this.scanLineLinks();
  }

  // ------------------------------------------------------------------
  // 行锚与右键复制链接([[file#L42]] 体系)
  // ------------------------------------------------------------------

  /**
   * 行级反链:文件行 → 引用它的笔记。库内 `[[file.py#L42]]`(metadataCache
   * 解析到本文件)与库外 `[[ext:<abs>#L42]]`(未解析链接按伪路径比对)都算;
   * 不带行锚的文件级链接不算(没有行可标)。
   */
  private lineLinks = new Map<number, { file: TFile; noteLine: number }[]>();
  private lineLinksScanTimer: number | null = null;
  /** 行号悬浮弹层状态(同一时刻至多一个;滚动/移出/换行即收) */
  private hoverLine: number | null = null;
  private hoverEl: HTMLElement | null = null;
  private hoverHideTimer: number | null = null;
  /** 行号右键菜单展开中:悬浮弹层让位(否则盖住菜单项,e2e 实测)。 */
  private gutterMenuOpen = false;

  /**
   * gutter 行号文本:被行锚引用的行包一层着色 class。Monaco 对 lineNumbersFn
   * 的返回值按 HTML 渲染,内联 span 是官方支持的定制点。
   */
  private renderGutterNumber(fileLine: number): string {
    if (this.lineLinks.size > 0 && this.lineLinks.has(fileLine)) {
      return `<span class="logseq-external-code-ln-linked">${fileLine}</span>`;
    }
    return String(fileLine);
  }

  /** 反链集合落进 gutter(混合引擎注入 + 刷新;纯源码模式换行号函数)。 */
  private applyLinkedGutter(): void {
    if (this.hybridEngine) {
      this.hybridEngine.linkedFileLines = new Set(this.lineLinks.keys());
      this.hybridEngine.refreshLinkedGutter();
    } else if (this.editor) {
      this.editor.updateOptions({
        lineNumbers: (n: number) => this.renderGutterNumber(n),
      });
    }
  }

  private scheduleLineLinksScan(): void {
    if (this.lineLinksScanTimer !== null) window.clearTimeout(this.lineLinksScanTimer);
    this.lineLinksScanTimer = window.setTimeout(() => {
      this.lineLinksScanTimer = null;
      this.scanLineLinks();
    }, 600);
  }

  /** 全库 md 缓存扫一遍 `#L` 行锚; getFileCache 是 O(1) 查表,大库也可承受。 */
  private scanLineLinks(): void {
    const map = new Map<number, { file: TFile; noteLine: number }[]>();
    const push = (line: number, file: TFile, noteLine: number) => {
      const arr = map.get(line);
      if (arr) arr.push({ file, noteLine });
      else map.set(line, [{ file, noteLine }]);
    };
    try {
      const selfPath = this.vaultFile?.path ?? null;
      const extTarget = this.vaultFile ? null : toExtPath(this.abs).toLowerCase();
      for (const md of this.app.vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(md);
        if (!cache?.links?.length) continue;
        for (const l of cache.links) {
          const { path: lp, subpath } = parseLinktext(l.link);
          if (!subpath) continue;
          const m = /^#?L(\d+)$/.exec(subpath);
          if (!m) continue;
          if (selfPath) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(lp, md.path);
            if (dest === this.vaultFile) push(Number(m[1]), md, l.position.start.line);
          } else if (extTarget) {
            // 库外:ext: 伪路径以未解析链接的形态留在缓存里,按归一化串比对
            const norm = decodeURIComponent(lp).replace(/\\/g, '/').toLowerCase();
            if (norm === extTarget) push(Number(m[1]), md, l.position.start.line);
          }
        }
      }
    } catch (e) {
      console.debug('[my-obsidian] line-links scan failed', e);
    }
    this.lineLinks = map;
    this.applyLinkedGutter();
  }

  /**
   * 行号悬浮:展示引用该行的笔记(可跳转)。每次悬浮都重建弹层;内容是
   * 笔记名 + 引用行上下文(引用行高亮),点笔记名跳到引用所在行。
   */
  private showGutterHover(
    fileLine: number,
    refs: { file: TFile; noteLine: number }[],
    rect: DOMRect,
  ): void {
    this.hideGutterHover();
    this.hoverLine = fileLine;
    const el = document.body.createDiv({ cls: 'logseq-external-code-refhover' });
    this.hoverEl = el;
    el.createDiv({
      cls: 'logseq-external-code-refhover-title',
      text: `第 ${fileLine} 行被 ${refs.length} 处引用`,
    });
    for (const r of refs) {
      const row = el.createDiv({ cls: 'logseq-external-code-refhover-item' });
      const a = row.createEl('a', { cls: 'internal-link', text: r.file.basename });
      a.setAttribute('data-href', r.file.path);
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        void this.openNoteAtLine(r);
        this.hideGutterHover();
      });
      const pre = row.createEl('pre', { cls: 'logseq-external-code-refhover-ctx' });
      void this.app.vault.cachedRead(r.file).then((text) => {
        if (!this.hoverEl || this.hoverLine !== fileLine) return;
        const lines = text.split(/\r?\n/);
        const from = Math.max(0, r.noteLine - 3);
        const to = Math.min(lines.length, r.noteLine + 4);
        pre.empty();
        for (let i = from; i < to; i++) {
          const ln = pre.createDiv({ cls: 'logseq-external-code-refhover-line' });
          if (i === r.noteLine) ln.addClass('is-link-line');
          ln.setText(lines[i] ?? '');
        }
      });
    }
    el.addEventListener('mouseleave', () => this.hideGutterHoverSoon());
    // 贴着行号的右侧弹;超出视口右缘就往左收
    const width = 460;
    const x = rect.right + 10 + width > window.innerWidth ? rect.left - width - 10 : rect.right + 10;
    el.setCssStyles({ left: `${Math.max(8, x)}px`, top: `${Math.max(8, rect.top - 8)}px` });
  }

  private hideGutterHover(): void {
    if (this.hoverHideTimer !== null) {
      window.clearTimeout(this.hoverHideTimer);
      this.hoverHideTimer = null;
    }
    this.hoverEl?.remove();
    this.hoverEl = null;
    this.hoverLine = null;
  }

  /** 弹层上停留(读上下文)不被收走:延迟关闭,再进入同一行时取消。 */
  private hideGutterHoverSoon(): void {
    if (this.hoverHideTimer !== null) window.clearTimeout(this.hoverHideTimer);
    this.hoverHideTimer = window.setTimeout(() => this.hideGutterHover(), 400);
  }

  /** 跳到引用笔记的引用行(md 视图吃 eState.line,hearth 同款)。 */
  private async openNoteAtLine(r: { file: TFile; noteLine: number }): Promise<void> {
    await this.app.workspace.getLeaf('tab').openFile(r.file, { eState: { line: r.noteLine } });
  }

  /**
   * 文件/行链接文本:库内走 generateMarkdownLink(尊重用户的链接风格设置,
   * timecodeRefs 先例),源笔记取当前活动 md 笔记(复制场景用户大概率就地
   * 粘贴);库外没有 TFile,走 `ext:<绝对路径>` 伪路径 wikilink(视频时间戳
   * 同款约定,virtual-tree 的 openLinkText patch 负责路由)。
   */
  buildFileLink(subpath = ''): string {
    if (this.vaultFile) {
      const notePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? '';
      return this.plugin.app.fileManager.generateMarkdownLink(this.vaultFile, notePath, subpath, '');
    }
    const line = /^#L(\d+)$/.exec(subpath);
    return buildCodeExtLink(this.abs, line ? Number(line[1]) : undefined);
  }

  /**
   * 嵌入块链接(2026-11-19 阶段 B):`![[file#L10-L20]]` 形态——md 里渲染成
   * 代码嵌入盒(features/codeEmbed),编辑按钮经行锚体系回到本视图。
   * 行范围来自行号选区(点击/Shift+点击扩展);单行 = `#LN` 无范围段。
   */
  buildEmbedLink(startLine: number, endLine: number): string {
    const anchor = startLine === endLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`;
    if (this.vaultFile) {
      const notePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? '';
      return '!' + this.plugin.app.fileManager.generateMarkdownLink(this.vaultFile, notePath, anchor, '');
    }
    return `![[ext:${toExtPath(this.abs)}${anchor}]]`;
  }

  private async copyEmbedLink(startLine: number, endLine: number): Promise<void> {
    const range = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
    void this.copyWithNotice(this.buildEmbedLink(startLine, endLine), ` ${this.fileName} ${range} 的嵌入块链接`);
  }

  private async copyWithNotice(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 后台/无焦点窗口会被 Chromium 拒掉 navigator 剪贴板(NotAllowedError);
      // Electron 的 clipboard 不受 focus 门控,兜底保证复制总能成功
      electronClipboard.writeText(text);
    }
    new Notice(`已复制${what}`);
  }

  /** 行号右键菜单项:复制到行的链接(`[[file#L42]]`)。 */
  private copyLineLink(fileLine: number): void {
    void this.copyWithNotice(this.buildFileLink(`#L${fileLine}`), ` ${this.fileName}:${fileLine} 的行链接`);
  }

  /** 行号右键菜单项:复制文件链接(`[[file]]`,不带行锚)。 */
  private copyFileLink(): void {
    void this.copyWithNotice(this.buildFileLink(), ` ${this.fileName} 的链接`);
  }

  /**
   * 行号 gutter 右键 → 复制到行的链接 / 复制文件链接。
   *
   * 只在点中行号(MouseTargetType.GUTTER_LINE_NUMBERS)时接管:preventDefault
   * 挡掉 Monaco 默认菜单,弹 Obsidian Menu。混合模式的 gutter 显示的就是
   * 真实文件行,Monaco 行经引擎双向映射。可执行环境(移动端)无右键,无需门控。
   */
  private attachGutterContextMenu(editor: monacoNS.editor.IStandaloneCodeEditor): void {
    this.viewDisposables.push(
      editor.onContextMenu((e) => {
        if (e.target.type !== monacoRuntime.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
        e.event.preventDefault();
        e.event.stopPropagation();
        // 菜单与悬浮弹层锚在同一位置——先收掉悬浮,展开期间也不再弹
        // (否则弹层盖住菜单项吞掉点击,e2e 实测)。
        this.hideGutterHover();
        this.gutterMenuOpen = true;
        const monacoLine = e.target.position?.lineNumber ?? e.target.range?.startLineNumber ?? 0;
        if (monacoLine < 1) return;
        const fileLine = this.hybridEngine ? this.hybridEngine.fileLineOfMonaco(monacoLine) : monacoLine;
        if (!fileLine || fileLine < 1) return;
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle(`复制到第 ${fileLine} 行的链接`)
            .setIcon('link' as never)
            .onClick(() => this.copyLineLink(fileLine)),
        );
        // 嵌入块链接(2026-11-19 阶段 B):选区行范围(行号点击/Shift+点击选出;
        // 无选区=点击行单行)——粘进 md 渲染成代码嵌入盒(见 features/codeEmbed)。
        const sel = editor.getSelection() ?? null;
        if (!sel) return;
        const sMonaco = Math.min(sel.startLineNumber, sel.endLineNumber);
        const eMonaco = Math.max(sel.startLineNumber, sel.endLineNumber);
        const sFile = this.hybridEngine ? this.hybridEngine.fileLineOfMonaco(sMonaco) : sMonaco;
        const eFile = this.hybridEngine ? this.hybridEngine.fileLineOfMonaco(eMonaco) : eMonaco;
        if (sFile && eFile && sFile >= 1 && eFile >= sFile) {
          const rangeText =
            sFile === eFile ? `第 ${sFile} 行` : `第 ${sFile}-${eFile} 行`;
          menu.addItem((item) =>
            item
              .setTitle(`复制嵌入块链接(${rangeText})`)
              .setIcon('bracket' as never)
              .onClick(() => this.copyEmbedLink(sFile, eFile)),
          );
        }
        menu.addItem((item) =>
          item
            .setTitle('复制文件链接')
            .setIcon('file-code' as never)
            .onClick(() => this.copyFileLink()),
        );
        // 锚定 gutter 元素本体,不用 e.event:Monaco 包装事件的坐标喂给
        // showAtMouseEvent 会被钳到视口角落(e2e 实测菜单落到 (0, 视口底) 外),
        // 而 target.element 的 rect 与悬浮弹层同源,位置永远正确。
        const gutterEl = e.target.element;
        const gutterRect = gutterEl?.getBoundingClientRect();
        if (gutterRect) {
          menu.showAtPosition({ x: gutterRect.right + 4, y: gutterRect.top });
        } else {
          menu.showAtMouseEvent(e.event as unknown as MouseEvent);
        }
        menu.onHide(() => {
          this.gutterMenuOpen = false;
        });
      }),
    );
  }

  /**
   * 行号悬浮(仅被行锚引用的行):展示引用它的笔记列表 + 引用行上下文,
   * 点笔记名跳到引用所在行。onMouseMove 驱动,同 lineHeight 变更/移出即收。
   */
  private attachGutterHover(editor: monacoNS.editor.IStandaloneCodeEditor): void {
    this.viewDisposables.push(
      editor.onMouseMove((e) => {
        if (this.gutterMenuOpen) return; // 右键菜单展开中,悬浮让位
        if (e.target.type !== monacoRuntime.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
          if (this.hoverEl) this.hideGutterHoverSoon();
          return;
        }
        const monacoLine = e.target.position?.lineNumber ?? 0;
        const fileLine = this.hybridEngine ? this.hybridEngine.fileLineOfMonaco(monacoLine) : monacoLine;
        const refs = fileLine ? this.lineLinks.get(fileLine) : undefined;
        if (!refs?.length) {
          if (this.hoverEl) this.hideGutterHoverSoon();
          return;
        }
        if (this.hoverLine === fileLine) return;
        const rect = e.target.element?.getBoundingClientRect();
        if (!rect) return;
        void this.showGutterHover(fileLine, refs, rect);
      }),
    );
    this.viewDisposables.push(editor.onMouseLeave(() => this.hideGutterHoverSoon()));
    // 滚动会让行号与弹层错位,直接收掉最稳
    this.viewDisposables.push(editor.onDidScrollChange(() => this.hideGutterHover()));
  }

  /**
   * Write the buffer back to the ORIGINAL file.
   *
   * The file on disk is the note — there is no vault copy and no second source
   * of truth — so saving means writing where the file already lives.
   */
  /** 运行当前文件(先写回磁盘,再按扩展名分派)。 */
  async runCurrentFile(): Promise<void> {
    const lang = langFromExt(this.fileName);
    if (!lang || !this.abs) return;
    await this.flush(true);
    const out = this.ensureRunOutput();
    out.textContent = '';
    out.style.display = 'block';
    // 工作目录 = 所在文件夹。原实现 /[\/][^\/]+$/ 的 [\/] 只匹配正斜杠 ——
    // 库外挂载路径是正斜杠所以一直没炸;库内 getFullPath 给反斜杠,不匹配
    // → cwd 原样是文件本身 → spawn ENOENT(2026-11-01 探针抓到)。按最后
    // 出现的分隔符(不分方向)截断。
    const cut = Math.max(this.abs.lastIndexOf('/'), this.abs.lastIndexOf('\\'));
    const cwd = cut > 0 ? this.abs.slice(0, cut) : this.abs;
    this.runHandle?.interrupt();
    this.runHandle = runFile(
      this.abs,
      lang,
      cwd,
      (chunk) => {
        out.textContent += chunk;
        out.scrollTop = out.scrollHeight;
      },
      (code) => {
        out.textContent += `
[退出码 ${code}]
`;
        this.runHandle = null;
      },
    );
  }

  private ensureRunOutput(): HTMLPreElement {
    if (this.runOutputEl && this.runOutputEl.isConnected) return this.runOutputEl;
    const el = this.contentEl.createEl('pre', { cls: 'logseq-external-run-output' });
    el.style.display = 'none';
    this.runOutputEl = el;
    return el;
  }

  async flush(notify = false): Promise<void> {
    // 丢弃请求在身(「不保存并关闭」):本次以及之后的 flush 都是空操作。
    if (this.discardRequested) return;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.editor || !this.abs) return;
    // 混合模式下整台 Monaco 只有代码行,注释内容在 FragmentHost 里——必须按
    // 区块重建,直接 getValue() 会把注释区从文件里抹掉。
    const data = this.hybridEngine ? this.hybridEngine.reconstruct() : this.editor.getValue();
    // 未编辑就不写盘:混合模式的重建会归一注释缩进,只看「结果 ≠ 磁盘内容」
    // 会把没动过的文件改掉格式(见 dirty 的注释)。
    if (this.loadFailed) {
      new Notice('文件未成功加载,已阻止保存;请关闭标签页后重新打开。');
      return;
    }
    if (!this.dirty || data === this.lastDiskData) return;
    const previousDiskData = this.lastDiskData;
    try {
      await writeTextAny(this.abs, data);
      this.lastDiskData = data;
      this.dirty = false;
      if (notify) new Notice(`已保存 ${this.fileName}`);
      logOp(this.plugin, 'external.code.save', this.abs, 'ok');
      // 写盘绕过 vault 时 save-control 的 versionOnWrite(监听 vault modify)
      // 收不到「写盘前」的基线——写盘方显式递(与 BlockEditorView.save 同款)。
      // 库外走 onExternalSaved(目标=绝对路径镜像);库内走 onVaultFileSaved
      // (目标=vault 路径,与原生 md 同存储)——这些视图不发 file-open,watcher
      // 的基线取样收不到,不递的话首次落盘就没有「写盘前」版本(2026-10-30
      // 用户报)。两个 hook 都可选链:save-control 未启用/旧版时静默跳过。
      {
        const appWithTable = this.plugin.app as unknown as {
          plugins?: { plugins?: Record<string, {
            onExternalSaved?: (abs: string, fileName: string, previousContent?: string | null) => void;
            onVaultFileSaved?: (file: unknown, previousContent?: string | null) => void;
          } | undefined> | undefined };
        };
        const table = appWithTable.plugins?.plugins;
        const sc = table?.['save-control'];
        if (this.inVault && this.vaultFile) {
          sc?.onVaultFileSaved?.(this.vaultFile, previousDiskData);
        } else if (!this.inVault) {
          sc?.onExternalSaved?.(this.abs, this.fileName, previousDiskData);
        }
      }
    } catch (e) {
      new Notice(`保存失败：${String(e).slice(0, 120)}`);
      logOp(this.plugin, 'external.code.save', this.abs, 'error', String(e).slice(0, 200));
    }
  }

  /**
   * Rebuild the editor, keeping the current buffer.
   *
   * The banner, the soft-wrap setting and the hybrid mode are baked into the
   * editor at construction, and an instance cannot change them afterwards, so a
   * settings toggle has to remount. The unsaved text is carried across so
   * nothing is lost in the swap.
   */
  async remount(): Promise<void> {
    if (!this.abs) return;
    try {
      // Prefer what is on screen: an autosave may not have landed yet.
      this.lastDiskData = this.currentBuffer();
      // mount() rebuilds from lastDiskData, so the live buffer travels with it
      // in BOTH modes — in hybrid mode there is no single model to setValue()
      // onto anyway (the code lines are only part of the file).
      await this.mount();
    } catch {
      /* a failed remount leaves the previous view in place; not fatal */
    }
  }

  /** Re-read from disk / remote (the file changed elsewhere). */
  async reload(): Promise<void> {
    try {
      this.lastDiskData = await readTextAny(this.abs);
      // 重新读取是「放弃本地改动,以磁盘为准」,所以清掉脏标记。
      this.dirty = false;
      this.loadFailed = false;
      // 混合模式下给 Monaco setValue 只换掉代码行,注释区还是旧的——必须整
      // 体重挂载,让 buildCodeDoc 重新切一遍。
      await this.mount();
    } catch (e) {
      new Notice(`重新读取失败：${String(e).slice(0, 100)}`);
    }
  }
}
