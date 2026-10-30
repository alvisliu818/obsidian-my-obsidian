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

import { ItemView, Notice, TFile, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import type * as monacoNS from 'monaco-editor';
// 代码编辑器:Monaco(开源 VS Code 内核)。语言解析/高亮/worker 见 src/editor/monaco.ts;
// LSP(补全/悬停/诊断/语义 token)的 Monaco 接线在 code-editor/src/lsp(与 SiYuan 同源)。
import { createEditor, setupMonaco, getLanguageByPath } from '../../../my-code-editor/src/editor/monaco';
import { encodeFileUri } from '../../../my-code-editor/src/lsp/lspHost';
import { monacoLspAttach } from '../../../my-code-editor/src/lsp/monacoLspBridge';
import { readExternalText, writeExternalText } from '../../../my-doc-tree/src/features/extFs';
import { logOp } from '../features/logger';
import type LogseqEditorPlugin from '../main';
import { relativeDisplayPath } from '../features/codeFileKind';
import { setLeafTitle } from '../features/leafTitle';
import { docTreeOf } from '../../../my-doc-tree/src/main';
import { applyHeaderPath, headerSegmentsFor, isUnderMount, matchMountFor } from './headerPath';
import { markLeafTouched } from './tabTouch';
import { HybridCodeEditor } from './hybridCodeEditor';
import { runFile, langFromExt } from '../../../my-code-editor/src/exec/runner';
import type { RunHandle } from '../../../my-code-editor/src/exec/pythonRunner';

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

  /** 老 state 没有挂载名时，按最长前缀匹配在挂载配置里找回来。 */
  private mountLabelFromSettings(): string {
    const mounts = docTreeOf(this.app)?.settings.externalMounts ?? [];
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
  private lastDiskData = '';
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

  async onOpen(): Promise<void> {
    // Mounting waits for setState: Obsidian calls onOpen BEFORE setState, so
    // mounting here would build an empty editor for a file whose path and
    // content have not arrived yet — and the state that carries them is the
    // only place they exist.
    if (this.abs) this.mount();
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
    };
    if (typeof s.abs === 'string') this.abs = s.abs;
    if (typeof s.name === 'string') this.fileName = s.name;
    if (typeof s.content === 'string') this.lastDiskData = s.content;
    if (typeof s.mountPath === 'string') this.mountPath = s.mountPath;
    if (typeof s.mountLabel === 'string') this.mountLabel = s.mountLabel;
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
      const m = matchMountFor(this.abs, docTreeOf(this.app)?.settings.externalMounts ?? []);
      if (m) {
        this.mountPath = m.path;
        if (!this.mountLabel) this.mountLabel = m.label;
      }
    }
    this.displayPath = relativeDisplayPath(this.abs, this.mountPath, this.fileName);
    await super.setState(state, result);
    // Now the path is known; build the editor if onOpen ran before us.
    if (!this.editor && this.abs) this.mount();
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
    await this.flush();
    this.disposeEditors();
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

  private mount(): void {
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

      // 运行:仅对可执行的扩展名显示(py / js / sh / ps1 …),用设置里选中的
      // Python 环境跑 —— 与代码块 ▶ 走同一条执行路径。
      const runLang = langFromExt(this.fileName);
      if (runLang) {
        const runBtn = banner.createEl('button', { cls: 'logseq-external-save', text: '▶ 运行' });
        runBtn.setAttribute('title', `运行 ${this.fileName}`);
        runBtn.addEventListener('click', () => void this.runCurrentFile());
      }
    }

    const host = contentEl.createDiv({ cls: 'logseq-external-code-host' });

    let content = this.lastDiskData;
    if (!content && this.abs) {
      try {
        content = readExternalText(this.abs);
      } catch (e) {
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
      this.editor = createEditor(host, {
        value: content,
        language,
        lineNumbers: true,
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
    // The leaf's own view header caches the name it was mounted with; on a fresh
    // mount that is nothing, on a re-mount it is the previous file. Writing it
    // here covers both.
    //
    // File name only — NOT the mount-relative path. The header now carries the
    // full path as breadcrumbs (挂载名 / 子目录 / …), so putting the path in the
    // title as well spelled it out twice (`挂载库/sub/sub/code.ts`).
    setLeafTitle(this.leaf, this.fileName);
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
    const cwd = this.abs.replace(/[\/][^\/]+$/, '');
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
    if (!this.dirty || data === this.lastDiskData) return;
    const previousDiskData = this.lastDiskData;
    try {
      writeExternalText(this.abs, data);
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
        const sc = table?.['my-save-history'] ?? table?.['save-history'] ?? table?.['save-control'];
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
  remount(): void {
    if (!this.abs) return;
    try {
      // Prefer what is on screen: an autosave may not have landed yet.
      this.lastDiskData = this.currentBuffer();
      // mount() rebuilds from lastDiskData, so the live buffer travels with it
      // in BOTH modes — in hybrid mode there is no single model to setValue()
      // onto anyway (the code lines are only part of the file).
      this.mount();
    } catch {
      /* a failed remount leaves the previous view in place; not fatal */
    }
  }

  /** Re-read from disk (the file changed elsewhere). */
  reload(): void {
    try {
      this.lastDiskData = readExternalText(this.abs);
      // 重新读取是「放弃本地改动,以磁盘为准」,所以清掉脏标记。
      this.dirty = false;
      // 混合模式下给 Monaco setValue 只换掉代码行,注释区还是旧的——必须整
      // 体重挂载,让 buildCodeDoc 重新切一遍。
      this.mount();
    } catch (e) {
      new Notice(`重新读取失败：${String(e).slice(0, 100)}`);
    }
  }
}
