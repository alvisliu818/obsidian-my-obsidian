/**
 * Jupyter Notebook(.ipynb)查看、编辑与运行视图 — 库内文件。
 *
 * - 查看:代码/Markdown/Raw 单元格渲染,已保存的执行输出(文本/图片/HTML/JSON/错误)
 * - 编辑:点击单元格进入 CodeMirror 就地编辑;添加/删除/上移/下移/切换单元格类型;
 *         写回 nbformat 4 JSON(保留 source 的 string/string[] 形态)
 * - 运行:代码单元格可点 ▶ 或 Shift+Enter 执行,走自带的持久 Python 内核
 *         (kernel/legacyPython + syfe-kernel.py,从 obsidian-logseq 抽出),
 *         不是 Jupyter 协议 —— 只需要「发代码 → 拿 stdout/stderr/结果值/异常」,
 *         自实现更轻。执行结果按 nbformat 4 规范写回 outputs / execution_count,
 *         存盘后用 Jupyter / VS Code 打开也是合法的。
 *
 * 结构对齐 obsidian-logseq 的 ExternalCodeView:ItemView + setState 带路径,
 * 保存写回原文件(这里即库内 TFile),关闭时自动 flush。
 *
 * 与参考实现(siyuan-virtual-tree notebook-tab.ts)的两个环境差异:
 * - Monaco → CodeMirror(cm-bundle 自包含副本,与 obsidian-logseq 的代码编辑器
 *   同策略 —— 共享实例上 StreamLanguage 高亮会静默失效);
 *   阅读态/编辑态共用同一份扩展,只差 readOnly,切换不跳版。
 * - Vditor → Obsidian MarkdownRenderer(md 单元格预览与 markdown 输出)。
 * CM 没有内容高度回调问题(编辑器随内容自然长高),不需要参考实现的 fitHeight。
 */

import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { EditorState, type Extension } from 'cm-bundle:@codemirror/state';
import {
  EditorView, keymap, lineNumbers, drawSelection, dropCursor, highlightSpecialChars,
} from 'cm-bundle:@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from 'cm-bundle:@codemirror/commands';
import {
  bracketMatching, indentOnInput, indentUnit, syntaxHighlighting,
  HighlightStyle, StreamLanguage, foldGutter, foldKeymap, type StreamParser,
} from 'cm-bundle:@codemirror/language';
import { searchKeymap } from 'cm-bundle:@codemirror/search';
import { tags as t } from 'cm-bundle:@lezer/highlight';
import { javascript } from 'cm-bundle:@codemirror/lang-javascript';
import { markdown as markdownLang } from 'cm-bundle:@codemirror/lang-markdown';
import { python } from 'cm-bundle:@codemirror/legacy-modes/mode/python';
import { r } from 'cm-bundle:@codemirror/legacy-modes/mode/r';
import { julia } from 'cm-bundle:@codemirror/legacy-modes/mode/julia';
import { shell } from 'cm-bundle:@codemirror/legacy-modes/mode/shell';
import { cpp, java } from 'cm-bundle:@codemirror/legacy-modes/mode/clike';
import { go } from 'cm-bundle:@codemirror/legacy-modes/mode/go';
import { rust } from 'cm-bundle:@codemirror/legacy-modes/mode/rust';
import { ruby } from 'cm-bundle:@codemirror/legacy-modes/mode/ruby';
import { standardSQL } from 'cm-bundle:@codemirror/legacy-modes/mode/sql';
import {
  type Notebook, type NbCell, type CellLang,
  parseNotebook, escapeHTML, getSourceText, setSourceText,
  renderOutputsHTML, outcomeToOutputs, makeCell, cellBadge, notebookLang,
} from './notebook';
import { getKernel, disposeKernel } from './kernel/registry';
import type { KernelClient, KernelStatus } from './kernel/types';
import type JupyterNotebookPlugin from './main';

export const VIEW_TYPE_NOTEBOOK = 'jupyter-notebook-view';

/** 阅读态懒加载余量(px):滚进视口前 400px 就建实例,离开视口销毁 */
const RO_MARGIN = 400;

function cellLangToExtension(lang: CellLang): Extension[] {
  const STREAM_MODES: Record<string, StreamParser<unknown>> = {
    python, r, julia, shell, cpp, java, go, rust, ruby, sql: standardSQL,
  } as unknown as Record<string, StreamParser<unknown>>;
  switch (lang.kind) {
    case 'stream': {
      const mode = STREAM_MODES[lang.name];
      return mode ? [StreamLanguage.define(mode)] : [];
    }
    case 'javascript':
      return [javascript({ typescript: lang.typescript })];
    case 'markdown':
      return [markdownLang()];
    default:
      return [];
  }
}

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--code-accent, #c792ea)' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--text-normal)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--color-blue, #82aaff)' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--color-orange, #ffcb6b)' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--text-normal)' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: 'var(--color-cyan, #f78c6c)' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--text-muted)' },
  { tag: [t.string, t.inserted], color: 'var(--color-green, #c3e88d)' },
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.bool, t.null], color: 'var(--color-orange, #ffcb6b)' },
  { tag: t.variableName, color: 'var(--text-normal)' },
  { tag: t.invalid, color: 'var(--text-error)' },
]);

/** 笔记本声明的语言是不是 Python(只有 Python 内核,别的语言不显示运行入口) */
function isPythonNotebook(nb: Notebook | null | undefined): boolean {
  if (!nb) return false;
  const info = (nb.metadata?.language_info ?? {}) as Record<string, unknown>;
  const name = String(info.name ?? '').toLowerCase();
  if (name === 'python' || name === 'py' || name.startsWith('python')) return true;
  // 老笔记本可能没有 language_info,退而看 kernelspec 的 display_name
  const kernel = String((nb.metadata?.kernelspec as Record<string, unknown> | undefined)?.display_name ?? '').toLowerCase();
  return kernel.includes('python');
}

/** 代码单元格 CM 的唯一选项来源 —— 编辑态与阅读态共用,只差 readOnly。 */
function cellExtensions(
  lang: CellLang,
  readonly: boolean,
  hooks: { onSave: () => boolean; onRun: () => void; onDirty: () => void },
): Extension[] {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    indentUnit.of('    '),
    bracketMatching(),
    syntaxHighlighting(highlightStyle, { fallback: true }),
    EditorView.lineWrapping,
    ...(readonly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    keymap.of([
      { key: 'Mod-s', run: hooks.onSave },
      // Shift+Enter = 运行本格(Jupyter 习惯)
      { key: 'Shift-Enter', run: () => { hooks.onRun(); return true; } },
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
      ...(searchKeymap as readonly { key: string; run: () => boolean }[] as never[]),
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !readonly) hooks.onDirty();
    }),
    ...cellLangToExtension(lang),
  ];
}

export class NotebookView extends ItemView {
  plugin: JupyterNotebookPlugin;
  /** 库内路径(vault path) */
  path = '';
  fileName = '';

  nb: Notebook | null = null;
  /** 解析失败时的原始文本(JSON 兜底编辑) */
  rawText = '';
  rawMode = false;

  dirty = false;
  saving = false;
  /** 当前选中单元格(新单元格插入其后) */
  activeIdx: number | null = null;
  /** 正在就地编辑的单元格 */
  editIdx: number | null = null;
  editEditor: EditorView | null = null;
  /** 阅读态只读编辑器:cell index → 实例。与编辑态共用同一套扩展 */
  roEditors = new Map<number, EditorView>();
  roObserver: IntersectionObserver | null = null;

  /** 正在执行的单元格 —— 用它做单格 spinner 与重复点击拦截 */
  runningIdx: number | null = null;
  kernel: KernelClient | null = null;
  kernelUnsub: (() => void) | null = null;

  private barEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private dirtyEl!: HTMLElement;
  private kernelEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private disposed = false;
  /** md 单元格的 logseq 片段宿主(软依赖,索引 → 宿主) */
  private mdFragments = new Map<number, { unload(): void }>();

  constructor(leaf: WorkspaceLeaf, plugin: JupyterNotebookPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_NOTEBOOK;
  }

  getDisplayText(): string {
    return this.fileName || 'Notebook';
  }

  getIcon(): string {
    return 'file-code';
  }

  getState(): Record<string, unknown> {
    return { path: this.path };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as { path?: string };
    if (typeof s.path === 'string') this.path = s.path;
    this.fileName = this.path.split('/').pop() ?? this.path;
    await super.setState(state, result);
    if (this.path) this.mount();
  }

  async onOpen(): Promise<void> {
    if (this.path) this.mount();
  }

  private mount(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('lgp-nb-view');

    const bar = contentEl.createDiv({ cls: 'lgp-nb__bar' });
    bar.createSpan({ cls: 'lgp-nb__kind', text: 'Notebook' });
    this.metaEl = bar.createSpan({ cls: 'lgp-nb__meta' });
    this.kernelEl = bar.createSpan({ cls: 'lgp-nb__kernel' });
    this.dirtyEl = bar.createSpan({ cls: 'lgp-nb__dirty', text: '●' });
    this.dirtyEl.style.display = 'none';
    const actions = bar.createSpan({ cls: 'lgp-nb__actions' });
    const btn = (text: string, act: string, title: string): HTMLElement =>
      actions.createEl('button', { cls: 'lgp-nb__btn', text, attr: { 'data-act': act, title } });
    btn('+ 代码', 'add-code', '在当前单元格后插入代码单元格');
    btn('+ Markdown', 'add-md', '在当前单元格后插入 Markdown 单元格');
    btn('▶ 运行全部', 'run-all', '按从上到下顺序执行全部代码单元格');
    btn('重启内核', 'restart', '清空内核的变量与导入,重新开始(不影响已保存的输出)');
    btn('保存', 'save', '保存到原文件(Ctrl+S)');
    btn('重载', 'reload', '从磁盘重新读取');
    this.barEl = bar;
    this.bodyEl = contentEl.createDiv({ cls: 'lgp-nb__body' });

    this.bodyEl.addEventListener('click', (e) => this.onBodyClick(e));
    this.bodyEl.addEventListener('dblclick', (e) => this.onBodyDblClick(e));
    this.barEl.addEventListener('click', (e) => this.onBarClick(e));
    // Esc 提交正在编辑的单元格(CM 会吞掉部分按键,document 捕获阶段兜底)
    this.escHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.editIdx !== null) {
        ev.preventDefault();
        ev.stopPropagation();
        this.commitCellEditor();
      }
    };
    document.addEventListener('keydown', this.escHandler, true);

    void this.loadFromDisk();
  }

  async onClose(): Promise<void> {
    this.disposed = true;
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler, true);
      this.escHandler = null;
    }
    // 片段 unload 先把未落盘编辑经 onContentChange 落回 cell,再一并保存
    this.disposeAllMdFragments();
    // 与插件的其余外部文件视图一致:关闭时自动保存未落盘的修改
    await this.flush();
    this.disposeAllRO();
    this.commitCellEditorSilent(false);
    this.editEditor?.destroy();
    this.editEditor = null;
    this.roObserver?.disconnect();
    this.roObserver = null;
  }

  // ------------------------------------------------------------------
  // 加载 / 保存

  private async loadFromDisk(): Promise<void> {
    this.disposeAllRO();
    this.bodyEl.innerHTML = `<div class="lgp-nb__loading">正在加载…</div>`;
    try {
      // TFile 用顶部静态导入;渲染进程解析不了裸模块名(import('obsidian') 会抛
      // Failed to resolve module specifier),类型位写法可以,运行时不行。
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (!(file instanceof TFile)) {
        this.bodyEl.innerHTML = `<div class="lgp-nb__loading">文件不存在: ${escapeHTML(this.path)}</div>`;
        return;
      }
      const text = await this.app.vault.read(file);
      const { nb, error } = parseNotebook(text);
      if (nb) {
        this.nb = nb;
        this.rawMode = false;
        this.render();
      } else {
        // 兜底:原始 JSON 编辑
        this.nb = null;
        this.rawText = text;
        this.rawMode = true;
        this.renderRawMode(error);
      }
    } catch (e) {
      this.bodyEl.innerHTML = `<div class="lgp-nb__loading">读取失败: ${escapeHTML(String(e))}</div>`;
    }
  }

  /** 原始 JSON 兜底编辑(解析失败 / nbformat 3) */
  private renderRawMode(err?: string): void {
    this.disposeAllRO();
    this.bodyEl.innerHTML = `
      ${err ? `<div class="lgp-nb__banner">${escapeHTML(err)} — 已切换为原始 JSON 编辑,可修复后保存</div>` : ''}
      <div class="lgp-nb__raw"></div>`;
    const host = this.bodyEl.querySelector('.lgp-nb__raw') as HTMLElement;
    this.editEditor = new EditorView({
      state: EditorState.create({
        doc: this.rawText,
        extensions: [
          lineNumbers(),
          history(),
          EditorView.lineWrapping,
          keymap.of([{ key: 'Mod-s', run: () => { void this.flush(true); return true; } }, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              this.rawText = u.state.doc.toString();
              this.setDirty(true);
            }
          }),
          ...(this.plugin.settings.wrap === false ? [] : [EditorState.allowMultipleSelections.of(true)]),
        ],
      }),
      parent: host,
    });
    this.renderMeta();
  }

  private saveContent(): string {
    if (this.rawMode) return this.rawText;
    // 保存不退出编辑态:直接把当前编辑内容落到数据模型再写盘。
    // 这里只能动 source,不能销毁编辑器(用户还得继续敲)。
    if (this.editIdx !== null && this.editEditor && this.nb) {
      const cell = this.nb.cells[this.editIdx];
      if (cell) setSourceText(cell, this.editEditor.state.doc.toString());
    }
    return JSON.stringify(this.nb, null, 1);
  }

  async flush(notify = false): Promise<void> {
    if (this.saving || !this.dirty || !this.path) return;
    this.saving = true;
    try {
      const data = this.saveContent();
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (!file) throw new Error('文件不存在');
      await this.app.vault.modify(file as TFile, data);
      this.setDirty(false);
      if (notify) new Notice(`已保存 ${this.fileName}`);
    } catch (e) {
      new Notice(`保存失败: ${String(e).slice(0, 120)}`);
    } finally {
      this.saving = false;
    }
  }

  private setDirty(d: boolean): void {
    this.dirty = d;
    if (this.dirtyEl) this.dirtyEl.style.display = d ? '' : 'none';
  }

  // ------------------------------------------------------------------
  // 渲染

  private render(): void {
    // 紧接着 innerHTML 整体重建,宿主节点会被换掉,先重绘的只读实例下一秒
    // 就被销毁,不如省掉(restore=false)
    this.commitCellEditorSilent(false);
    if (!this.nb) {
      this.renderRawMode();
      return;
    }
    const st = this.bodyEl.scrollTop;
    const cells = this.nb.cells;
    // innerHTML 整体重建会连宿主节点一起换掉,先前的只读实例/片段宿主全部
    // 失去挂载点 —— 必须先销毁,否则每次重绘都漏一批 CM 实例。
    // 片段 unload 会先提交未落盘编辑,onContentChange 已同步进模型,
    // 下面的 innerHTML 重建拿到的就是最新内容。
    this.disposeAllMdFragments();
    this.disposeAllRO();
    this.bodyEl.innerHTML =
      cells.length === 0
        ? `<div class="lgp-nb__empty">空笔记本,用顶部按钮添加单元格</div>`
        : cells.map((cell, i) => this.cellHTML(cell, i)).join('');
    this.bodyEl.scrollTop = st;
    this.renderMeta();

    // 异步增强:md 单元格渲染 + 代码区只读实例 + 输出里的 markdown
    this.renderAllMarkdown();
    this.refreshRO();
  }

  private cellHTML(cell: NbCell, i: number): string {
    const srcBody =
      cell.cell_type === 'markdown'
        ? `<div class="lgp-nb__mdview" data-mdview="${i}" title="双击编辑源码"></div><div class="lgp-nb__src" data-src="${i}" style="display:none;"></div>`
        // 代码格的源码区是空容器,内容由只读 CM 实例填。
        : `<div class="lgp-nb__src" data-src="${i}" title="点击编辑"></div>`;
    const outs = cell.cell_type === 'code' ? `<div class="lgp-nb__outs">${renderOutputsHTML(cell)}</div>` : '';
    const exec =
      cell.cell_type === 'code' && cell.execution_count != null
        ? `<span class="lgp-nb__exec">[${cell.execution_count}]</span>`
        : '';
    const toggle = cell.cell_type === 'code' ? 'MD' : '⌨';
    const running = this.runningIdx === i;
    const canRun = this.canRun();
    const runBtn =
      cell.cell_type === 'code' && canRun
        ? `<span class="lgp-nb__cellbtn lgp-nb__cellbtn--run${running ? ' lgp-nb__cellbtn--busy' : ''}" data-act="run" data-idx="${i}" title="${running ? '执行中…' : '运行此单元格(Shift+Enter)'}">${running ? '◌' : '▶'}</span>`
        : '';
    return `
      <div class="lgp-nb__cell lgp-nb__cell--${escapeHTML(cell.cell_type)}${this.activeIdx === i ? ' lgp-nb__cell--active' : ''}${running ? ' lgp-nb__cell--running' : ''}" data-idx="${i}">
        <div class="lgp-nb__cellbar">
          <span class="lgp-nb__badge">${cellBadge(cell)}</span>${exec}
          <span class="lgp-nb__spacer"></span>
          ${runBtn}
          <span class="lgp-nb__cellbtn" data-act="up" data-idx="${i}" title="上移">↑</span>
          <span class="lgp-nb__cellbtn" data-act="down" data-idx="${i}" title="下移">↓</span>
          <span class="lgp-nb__cellbtn" data-act="type" data-idx="${i}" title="切换为 ${toggle === 'MD' ? 'Markdown' : '代码'}">${toggle}</span>
          <span class="lgp-nb__cellbtn" data-act="edit" data-idx="${i}" title="编辑源码">✎</span>
          <span class="lgp-nb__cellbtn lgp-nb__cellbtn--del" data-act="del" data-idx="${i}" title="删除单元格">×</span>
        </div>
        ${srcBody}${outs}
      </div>`;
  }

  private renderMeta(): void {
    const runAll = this.barEl.querySelector('.lgp-nb__btn[data-act="run-all"]') as HTMLElement | null;
    const restart = this.barEl.querySelector('.lgp-nb__btn[data-act="restart"]') as HTMLElement | null;
    const show = this.canRun() && !this.rawMode;
    if (runAll) runAll.style.display = show ? '' : 'none';
    if (restart) restart.style.display = show ? '' : 'none';
    if (!this.nb) {
      this.metaEl.textContent = '原始 JSON';
      return;
    }
    const kernel = String(
      (this.nb.metadata?.kernelspec as Record<string, unknown> | undefined)?.display_name ??
        ((this.nb.metadata?.language_info as Record<string, unknown> | undefined)?.display_name ?? '') ??
        '',
    );
    const lang = String((this.nb.metadata?.language_info as Record<string, unknown> | undefined)?.name ?? '');
    this.metaEl.textContent = `${lang ? lang + (kernel ? ' · ' + kernel : '') : kernel} · ${this.nb.cells.length} 格`;
  }



    // ------------------------------------------------------------------
  // md 单元格预览:优先用 obsidian-logseq 的 logseq 风格片段编辑器(软依赖),
  // 未安装/未启用时降级 MarkdownRenderer。片段支持点击块直接编辑,
  // 提交(Esc)后经 onContentChange 把最新 markdown 写回单元格式模型。
  // ------------------------------------------------------------------

  /** obsidian-logseq 片段宿主的结构化视图(不静态导入,保持独立可用) */
  private logseqFragmentApi(): {
    renderMarkdownFragment: (container: HTMLElement, md: string, opts?: {
      editable?: boolean;
      onContentChange?: (md: string) => void;
      onOpenLink?: (linktext: string) => void;
    }) => { unload(): void };
  } | null {
    // obsidian 公开 d.ts 未声明 App.plugins,用结构化视图取
    const pm = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
    const p = pm?.plugins?.['obsidian-logseq'] as
      | { renderMarkdownFragment?: unknown }
      | undefined;
    return p && typeof p.renderMarkdownFragment === 'function'
      ? (p as unknown as {
          renderMarkdownFragment: (container: HTMLElement, md: string, opts?: {
            editable?: boolean;
            onContentChange?: (md: string) => void;
            onOpenLink?: (linktext: string) => void;
          }) => { unload(): void };
        })
      : null;
  }

  private disposeMdFragment(idx: number): void {
    const frag = this.mdFragments.get(idx);
    if (!frag) return;
    this.mdFragments.delete(idx);
    try {
      // unload 内部先提交焦点编辑(onContentChange 已把最新 markdown 落回 cell)
      frag.unload();
    } catch {
      // ignore
    }
  }

  private disposeAllMdFragments(): void {
    for (const idx of Array.from(this.mdFragments.keys())) this.disposeMdFragment(idx);
  }

  /** md 单元格预览渲染:logseq 片段(可点击编辑)或 MarkdownRenderer 降级 */
  private renderMdCellView(idx: number, host: HTMLElement, text: string): void {
    const cell = this.nb?.cells[idx];
    const lgp = this.logseqFragmentApi();
    if (lgp && cell) {
      this.disposeMdFragment(idx);
      host.empty?.();
      const frag = lgp.renderMarkdownFragment(host, text, {
        editable: true,
        onContentChange: (md) => {
          const cur = this.nb?.cells[idx];
          if (cur === cell) {
            setSourceText(cell, md);
            this.setDirty(true);
          }
        },
      });
      this.mdFragments.set(idx, frag);
      return;
    }
    void this.renderMarkdownInto(host, text);
  }

  /** markdown 渲染(输出里的富 markdown;md 单元格预览走 renderMdCellView) */
  private async renderMarkdownInto(host: HTMLElement, text: string): Promise<void> {
    try {
      host.empty?.();
      await MarkdownRenderer.render(this.app, text, host, this.path, this.plugin);
    } catch {
      host.innerHTML = `<pre>${escapeHTML(text)}</pre>`;
    }
  }

  private renderAllMarkdown(): void {
    if (!this.nb) return;
    this.nb.cells.forEach((cell, i) => {
      if (cell.cell_type !== 'markdown') return;
      const view = this.bodyEl.querySelector(`[data-mdview="${i}"]`) as HTMLElement | null;
      if (view) this.renderMdCellView(i, view, getSourceText(cell));
    });
    this.bodyEl.querySelectorAll<HTMLElement>('[data-md]').forEach((el) => {
      const md = decodeURIComponent(el.dataset.md ?? '');
      if (md) void this.renderMarkdownInto(el, md);
    });
  }

  // ------------------------------------------------------------------
  // 阅读态只读 CM 实例(视口懒加载)

  private disposeRO(idx: number): void {
    const ed = this.roEditors.get(idx);
    if (!ed) return;
    this.roEditors.delete(idx);
    try {
      ed.destroy();
    } catch {
      // ignore
    }
  }

  private disposeAllRO(): void {
    for (const idx of Array.from(this.roEditors.keys())) this.disposeRO(idx);
  }

  private mountRO(idx: number): void {
    if (!this.nb || this.disposed) return;
    const cell = this.nb.cells[idx];
    if (!cell || cell.cell_type === 'markdown') return;
    if (this.editIdx === idx) return;
    const host = this.bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
    if (!host) return;
    const exist = this.roEditors.get(idx);
    const text = getSourceText(cell);
    if (exist && exist.state.doc.toString() === text) return;
    this.disposeRO(idx);
    const editor = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: cellExtensions(notebookLang(this.nb), true, {
          onSave: () => { void this.flush(true); return true; },
          onRun: () => void this.runCell(idx),
          onDirty: () => this.setDirty(true),
        }),
      }),
      parent: host,
    });
    host.classList.add('lgp-nb__src--ro');
    this.roEditors.set(idx, editor);
  }

  private setupROObserver(): boolean {
    if (typeof IntersectionObserver === 'undefined') return false;
    try {
      this.roObserver?.disconnect();
    } catch {
      // ignore
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const el = en.target as HTMLElement;
          const idx = Number(el.dataset.src);
          if (!Number.isInteger(idx)) continue;
          if (en.isIntersecting) this.mountRO(idx);
          else this.disposeRO(idx);
        }
      },
      { root: this.bodyEl, rootMargin: `${RO_MARGIN}px 0px` },
    );
    this.roObserver = io;
    return true;
  }

  private refreshRO(): void {
    const hasIO = this.setupROObserver();
    this.bodyEl.querySelectorAll<HTMLElement>('[data-src]').forEach((el) => {
      this.roObserver?.observe(el);
      if (!hasIO) {
        const idx = Number(el.dataset.src);
        if (Number.isInteger(idx)) this.mountRO(idx);
      }
    });
  }

  // ------------------------------------------------------------------
  // 就地编辑

  /** 提交就地编辑并把该格恢复成阅读视图(静默,不触发整表重绘) */
  private commitCellEditorSilent(restore = true): number | null {
    if (this.editIdx === null) return null;
    const idx = this.editIdx;
    const cell = this.nb?.cells[idx];
    if (cell && this.editEditor) setSourceText(cell, this.editEditor.state.doc.toString());
    try {
      this.editEditor?.destroy();
    } catch {
      // ignore
    }
    this.editEditor = null;
    this.editIdx = null;
    const host = this.bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
    if (host) {
      host.classList.remove('lgp-nb__celledit');
      host.innerHTML = '';
      if (restore && cell && cell.cell_type !== 'markdown') this.mountRO(idx);
    }
    return idx;
  }

  /** markdown 格退出编辑时把渲染视图放回去 */
  private restoreMarkdownView(idx: number): void {
    const cell = this.nb?.cells[idx];
    if (!cell || cell.cell_type !== 'markdown') return;
    const view = this.bodyEl.querySelector(`[data-mdview="${idx}"]`) as HTMLElement | null;
    if (view) {
      view.style.display = '';
      this.renderMdCellView(idx, view, getSourceText(cell));
    }
    const mh = this.bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
    if (mh) mh.style.display = 'none';
  }

  private commitCellEditor(): void {
    const idx = this.commitCellEditorSilent();
    if (idx === null) return;
    this.restoreMarkdownView(idx);
  }

  private openCellEditor(idx: number): void {
    if (!this.nb) return;
    const cell = this.nb.cells[idx];
    if (!cell) return;
    if (this.editIdx === idx) return;
    this.commitCellEditor();
    const host = this.bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
    if (!host) return;
    this.disposeRO(idx);
    const mdView = this.bodyEl.querySelector(`[data-mdview="${idx}"]`) as HTMLElement | null;
    if (mdView) mdView.style.display = 'none';
    host.style.display = '';
    host.classList.remove('lgp-nb__src--ro');
    host.innerHTML = '';
    const lang = cell.cell_type === 'markdown' ? ({ kind: 'markdown' } as CellLang) : notebookLang(this.nb);
    host.classList.add('lgp-nb__celledit');
    const editor = new EditorView({
      state: EditorState.create({
        doc: getSourceText(cell),
        extensions: cellExtensions(lang, false, {
          onSave: () => { void this.flush(true); return true; },
          onRun: () => {
            // 先把内容落回 cell 再跑,否则执行的是上一版代码
            if (this.editIdx === idx && this.editEditor) {
              setSourceText(cell, this.editEditor.state.doc.toString());
              this.setDirty(true);
            }
            this.commitCellEditorSilent();
            void this.runCell(idx);
          },
          onDirty: () => this.setDirty(true),
        }),
      }),
      parent: host,
    });
    // 失焦(点击其他位置)自动提交
    editor.dom.addEventListener('focusout', () => {
      if (this.editIdx === idx) this.commitCellEditor();
    });
    editor.focus();
    this.editEditor = editor;
    this.editIdx = idx;
    this.activeIdx = idx;
    this.bodyEl.querySelectorAll('.lgp-nb__cell--active').forEach((el) => el.classList.remove('lgp-nb__cell--active'));
    this.bodyEl.querySelector(`.lgp-nb__cell[data-idx="${idx}"]`)?.classList.add('lgp-nb__cell--active');
  }

  // ------------------------------------------------------------------
  // 结构操作

  private withCells(fn: (cells: NbCell[]) => void): void {
    if (!this.nb) return;
    // 紧接着就是 render(),不用重挂只读实例
    this.commitCellEditorSilent(false);
    fn(this.nb.cells);
    this.setDirty(true);
    this.render();
  }

  private addCell(type: 'code' | 'markdown'): void {
    this.withCells((cells) => {
      const at =
        this.activeIdx != null && this.activeIdx >= 0 && this.activeIdx < cells.length
          ? this.activeIdx + 1
          : cells.length;
      const withId = cells.some((c) => c.id) || (this.nb?.nbformat_minor ?? 0) >= 5;
      cells.splice(at, 0, makeCell(type, withId));
      this.activeIdx = at;
    });
    // 新建后直接进入编辑
    if (this.activeIdx != null) this.openCellEditor(this.activeIdx);
  }

  private moveCell(idx: number, delta: number): void {
    this.withCells((cells) => {
      const to = idx + delta;
      if (to < 0 || to >= cells.length) return;
      const [c] = cells.splice(idx, 1);
      cells.splice(to, 0, c);
      if (this.activeIdx === idx) this.activeIdx = to;
    });
  }

  private deleteCell(idx: number): void {
    this.withCells((cells) => {
      cells.splice(idx, 1);
      if (this.activeIdx === idx) this.activeIdx = null;
    });
  }

  private toggleCellType(idx: number): void {
    this.withCells((cells) => {
      const cell = cells[idx];
      if (!cell) return;
      if (cell.cell_type === 'code') {
        cell.cell_type = 'markdown';
        delete cell.outputs;
        delete cell.execution_count;
      } else {
        cell.cell_type = 'code';
        cell.outputs = [];
        cell.execution_count = null;
      }
    });
  }

  // ------------------------------------------------------------------
  // 运行(持久 Python 内核)

  private canRun(): boolean {
    // 语言声明必须是 Python;解释器是否存在由内核启动时判定(失败有明确报错)
    return isPythonNotebook(this.nb);
  }

  private kernelFor(): KernelClient {
    if (!this.kernel) {
      this.kernel = getKernel(this.path);
      this.kernelUnsub = this.kernel.onStatus((s, detail) => this.renderKernelState(s, detail));
    }
    // 单元格里的相对路径按笔记本所在目录解析(Jupyter 标准语义)
    this.kernel.setCwd(this.path.includes('/') ? this.path.slice(0, this.path.lastIndexOf('/')) : '');
    return this.kernel;
  }

  private renderKernelState(status: KernelStatus, detail?: string): void {
    if (!this.kernelEl) return;
    if (status === 'ready') {
      this.kernelEl.textContent = '内核就绪';
      this.kernelEl.className = 'lgp-nb__kernel lgp-nb__kernel--ready';
      this.kernelEl.setAttribute('title', detail || '持久 Python 内核已就绪,变量在单元格之间保持');
    } else if (status === 'starting') {
      this.kernelEl.textContent = '内核启动中…';
      this.kernelEl.className = 'lgp-nb__kernel lgp-nb__kernel--busy';
    } else if (status === 'error') {
      this.kernelEl.textContent = '内核不可用';
      this.kernelEl.className = 'lgp-nb__kernel lgp-nb__kernel--error';
      this.kernelEl.setAttribute('title', detail || '无法启动 Python 内核,请确认 python 在 PATH 中');
    } else {
      this.kernelEl.textContent = '';
      this.kernelEl.className = 'lgp-nb__kernel';
    }
  }

  /** 切换单元格上的运行态(只改这一格的 DOM,不整表重绘) */
  private setCellRunning(idx: number, running: boolean): void {
    const cellEl = this.bodyEl.querySelector(`.lgp-nb__cell[data-idx="${idx}"]`);
    if (!cellEl) return;
    cellEl.classList.toggle('lgp-nb__cell--running', running);
    const btn = cellEl.querySelector('[data-act="run"]') as HTMLElement | null;
    if (btn) {
      btn.textContent = running ? '◌' : '▶';
      btn.setAttribute('title', running ? '执行中…' : '运行此单元格(Shift+Enter)');
      btn.classList.toggle('lgp-nb__cellbtn--busy', running);
    }
  }

  /** 只重绘第 idx 格的输出区 + 执行序号,其余 DOM 一概不动 */
  private refreshCellOutputs(idx: number): void {
    if (!this.nb) return;
    const cell = this.nb.cells[idx];
    if (!cell) return;
    const cellEl = this.bodyEl.querySelector(`.lgp-nb__cell[data-idx="${idx}"]`);
    if (!cellEl) {
      this.render();
      return;
    }
    const outsEl = cellEl.querySelector('.lgp-nb__outs') as HTMLElement | null;
    if (outsEl) {
      outsEl.innerHTML = renderOutputsHTML(cell);
      outsEl.querySelectorAll<HTMLElement>('[data-md]').forEach((el) => {
        const md = decodeURIComponent(el.dataset.md ?? '');
        if (md) void this.renderMarkdownInto(el, md);
      });
    }
    const bar = cellEl.querySelector('.lgp-nb__cellbar') as HTMLElement | null;
    if (bar) {
      const old = bar.querySelector('.lgp-nb__exec');
      if (cell.execution_count != null) {
        if (old) old.textContent = `[${cell.execution_count}]`;
        else {
          const span = document.createElement('span');
          span.className = 'lgp-nb__exec';
          span.textContent = `[${cell.execution_count}]`;
          bar.insertBefore(span, bar.querySelector('.lgp-nb__spacer'));
        }
      } else if (old) {
        old.remove();
      }
    }
  }

  /** 执行第 idx 个代码单元格,结果写回 cell.outputs / execution_count */
  private async runCell(idx: number): Promise<void> {
    if (!this.canRun() || this.rawMode || this.disposed) return;
    const cell = this.nb?.cells[idx];
    if (!cell || cell.cell_type !== 'code') return;
    // 正在跑一格时:再点就是「中断」
    if (this.runningIdx !== null) {
      if (this.runningIdx === idx) await this.interrupt();
      return;
    }
    // 先把这格的编辑内容提交回 cell,否则跑的是旧代码
    if (this.editIdx === idx && this.editEditor) {
      setSourceText(cell, this.editEditor.state.doc.toString());
    }
    const code = getSourceText(cell);
    if (!code.trim()) {
      new Notice('空单元格,没有可执行的代码');
      return;
    }
    const kernel = this.kernelFor();
    this.runningIdx = idx;
    this.setCellRunning(idx, true);
    try {
      const outcome = await kernel.execute(code);
      if (outcome) {
        cell.outputs = outcomeToOutputs({
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          result: outcome.result,
          richData: outcome.richData,
          error: outcome.error,
          executionCount: outcome.executionCount,
        });
        cell.execution_count = outcome.executionCount || null;
        this.setDirty(true);
      } else if (kernel.currentStatus !== 'ready') {
        new Notice('内核不可用,详见工具栏内核状态提示');
      }
    } finally {
      this.runningIdx = null;
      this.setCellRunning(idx, false);
      this.refreshCellOutputs(idx);
    }
  }

  private async runAll(): Promise<void> {
    if (!this.nb || this.rawMode) return;
    this.commitCellEditorSilent();
    for (let i = 0; i < this.nb.cells.length; i++) {
      if (this.nb.cells[i].cell_type === 'code') {
        await this.runCell(i);
      }
    }
  }

  private async interrupt(): Promise<void> {
    if (this.kernel) await this.kernel.interrupt();
  }

  // ------------------------------------------------------------------
  // 事件

  private onBarClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'add-code') this.addCell('code');
    else if (act === 'add-md') this.addCell('markdown');
    else if (act === 'run-all') void this.runAll();
    else if (act === 'restart') void this.restartKernel();
    else if (act === 'save') void this.flush(true);
    else if (act === 'reload') void this.reload();
  }

  private async restartKernel(): Promise<void> {
    if (!this.kernel) {
      // 没起过内核:重启语义 = 丢弃实例,下次运行重新拉起
      if (this.path) await disposeKernel(this.path);
      this.kernel = null;
      this.kernelUnsub?.();
      this.kernelUnsub = null;
      this.renderKernelState('stopped');
      return;
    }
    const ok = await this.kernel.reset();
    new Notice(ok ? '内核已重置' : '内核重置失败', 2000);
  }

  private async reload(): Promise<void> {
    if (this.dirty) {
      new Notice('有未保存的修改,先保存或撤销后再重载');
      return;
    }
    await this.loadFromDisk();
  }

  private onBodyClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (btn) {
      const idx = Number(btn.dataset.idx);
      if (!Number.isInteger(idx)) return;
      const act = btn.dataset.act;
      if (act === 'run') void this.runCell(idx);
      else if (act === 'up') this.moveCell(idx, -1);
      else if (act === 'down') this.moveCell(idx, 1);
      else if (act === 'type') this.toggleCellType(idx);
      else if (act === 'edit') this.openCellEditor(idx);
      else if (act === 'del') this.deleteCell(idx);
      return;
    }
    // 点击源码区(非 md 预览)进入编辑
    const src = (e.target as HTMLElement).closest('.lgp-nb__src') as HTMLElement | null;
    if (src) {
      const idx = Number(src.dataset.src);
      if (Number.isInteger(idx)) this.openCellEditor(idx);
    }
  }

  private onBodyDblClick(e: MouseEvent): void {
    // md 预览双击进源码编辑
    const view = (e.target as HTMLElement).closest('[data-mdview]') as HTMLElement | null;
    if (!view) return;
    const idx = Number(view.dataset.mdview);
    if (Number.isInteger(idx)) this.openCellEditor(idx);
  }
}
