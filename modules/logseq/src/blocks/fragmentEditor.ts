/**
 * FragmentHost — 轻量 BlockRenderHost:用与整页编辑器同一套渲染管线
 * (renderTree/focusEditor/extensions)渲染「一段 markdown」的 logseq 风格
 * 块树,并支持就地编辑。
 *
 * 供外部插件跨插件复用:obsidian-logseq 在 main.ts 暴露
 * `renderMarkdownFragment(container, md, opts)`,调用方(如 notebook 插件的
 * md 单元格)拿到 FragmentHost 实例 —— 它是一个 Component,挂进调用方自己的
 * 组件树(addChild)或手动 destroy() 即可回收。
 *
 * 与 BlockEditorView 的差异(有意为之):
 * - 无文件:file=null,tracetime/嵌入编辑/原生属性编辑器全部退化为静态;
 * - 无缩放:zoomedBlock 恒 null,visibleRoots 即 doc.blocks;
 * - 无虚拟滚动:scrollCap=1e9,片段很小,整棵渲染;
 * - 无撤销栈/搜索栏/页引用等视图级设施;
 * - mutate 不做子树补丁优化,一律整段重渲染(片段渲染成本可忽略)。
 */

import { Component, type App, type TFile, type WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { CompletionSource } from '@codemirror/autocomplete';
import type LogseqEditorPlugin from '../main';
import type { BlockRenderHost } from './renderHost';
import type { MutatePatch } from '../view/BlockEditorView';
import type { Block, ParsedDocument } from '../types';
import { createBlock, setCollapsed, isCollapsed } from '../types';
import { parseDocument } from '../core/parser';
import { serializeDocument } from '../core/serializer';
import {
  cycleMarker,
  flattenVisible,
  indent,
  outdent,
  rangeAnchor,
  registerRoots,
  removeBlock,
  siblingsOf,
  splitBlock,
  splitRawToOutline,
  visibleRange,
} from '../core/treeOps';
import {
  foldLevelOf,
  foldValueFor,
  nextFoldLevel,
  normFoldKey,
  subtreeFoldTargets,
  type FoldLevel,
} from '../core/fold';
import { collapseLevels, expandLevels, isSubtreeFullyFolded } from '../interactions/collapse';
import { findBlockEl, refreshBlockContent, renderBlockTree } from './renderTree';
import {
  applyCursor,
  applyCursorAndScroll,
  commitEditorText,
  cursorAtCoords,
  mountFocusedEditor,
  type CursorPos,
} from '../editor/focusEditor';
import { clearActiveBlockEditor } from '../interactions/textSelectionMenu';
import { autocompleteSources } from '../features/links';
import { parseVarLines, type TemplateContext } from '../features/template';
import type { EmbedSource } from '../features/links';
import { unwatchGuideLayout, watchGuideLayout } from './guideLayout';

export interface FragmentOptions {
  /** 允许就地编辑(默认 true);false = 纯静态渲染,点击不进入编辑 */
  editable?: boolean;
  /** 编辑内容提交(块文本落模型或结构变化)后回调,收到序列化后的 markdown */
  onContentChange?: (md: string) => void;
  /** 用户点击了 wiki 链接(缺省 app.workspace.openLinkText) */
  onOpenLink?: (linktext: string) => void;
  /**
   * 代码注释区场景(混合编辑视图的注释 zone):块文本行首的 `#` 是注释
   * 标记而非 markdown 标题 —— 编辑态关闭 live-preview 的标题渲染。
   */
  codeComment?: boolean;
}

export class FragmentHost extends Component implements BlockRenderHost {
  plugin: LogseqEditorPlugin;
  app: App;
  doc: ParsedDocument = { frontmatter: '', pageProps: '', blocks: [] };
  file: TFile | null = null;
  /** 渲染链的容器:我们自建、随 unload 一并移除,跨重渲染存活 */
  containerEl: HTMLElement;
  focusedBlock: Block | null = null;
  lastEditedBlock: Block | null = null;
  focusedView: EditorView | null = null;
  zoomedBlock: Block | null = null;
  sourceModeBlock: Block | null = null;
  selectedBlocks = new Set<Block>();
  renderGeneration = 0;
  /** 片段很小:免虚拟化,整棵渲染 */
  scrollCap = 1e9;
  readonly leaf: WorkspaceLeaf | null = null;
  readonly embedEdit: { view: EditorView } | null = null;

  private treeEl: HTMLElement;
  private opts: Required<Pick<FragmentOptions, 'editable'>> & FragmentOptions;
  private pendingFocus: { pos: CursorPos; clickXY: { x: number; y: number } | null } | null = null;
  private savedFocusPos: CursorPos = 'end';
  private lastClicked: Block | null = null;
  private pendingRangeAnchor: Block | null = null;

  constructor(plugin: LogseqEditorPlugin, mount: HTMLElement, opts: FragmentOptions = {}) {
    super();
    this.plugin = plugin;
    this.app = plugin.app;
    this.opts = { editable: true, ...opts };
    // DOM 骨架与整页编辑器同构(block-editor-container/-scroller/-tree),
    // 复用其样式与 renderTree 的 DOM 约定;containerEl 是渲染链的存活容器。
    this.containerEl = mount.createEl('div', { cls: 'block-editor-container lgp-fragment' });
    const scroller = this.containerEl.createEl('div', { cls: 'block-editor-scroller' });
    this.treeEl = scroller.createEl('div', { cls: 'block-editor-tree' });
    this.treeEl.tabIndex = -1;
    watchGuideLayout(this.treeEl);
    this.register(() => unwatchGuideLayout(this.treeEl));
    this.load();
  }

  onunload(): void {
    // 卸载前把焦点编辑落盘:片段宿主常被外部在重渲染/关闭时 unload,
    // 静默销毁会丢掉用户正在敲的内容(onContentChange 会带走最新 markdown)。
    this.commitFocusedText();
    if (this.focusedView) {
      this.focusedView.destroy();
      this.focusedView = null;
    }
    this.treeEl.empty();
    this.containerEl.remove();
  }

  // ------------------------------------------------------------------
  // 对外 API
  // ------------------------------------------------------------------

  /** 载入一段 markdown(重新解析、清空焦点/选区、整段渲染) */
  setMarkdown(md: string): void {
    this.doc = parseDocument(md);
    this.clearFocus();
    this.clearSelection();
    this.renderInner();
  }

  /** 当前内容的 markdown(序列化自块模型,即已提交的编辑结果) */
  getContent(): string {
    return serializeDocument(this.doc);
  }

  /** 立即提交焦点编辑并触发 onContentChange(外部在保存前调用) */
  flush(): void {
    this.commitFocusedText();
  }

  get contentTreeEl(): HTMLElement {
    return this.treeEl;
  }

  get visibleRoots(): Block[] {
    return this.doc.blocks;
  }

  get foldEnabled(): boolean {
    return this.plugin.settings.foldEnabled !== false;
  }

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  private renderInner(): void {
    const roots = this.visibleRoots;
    registerRoots(roots);
    // 上一个 CM 实例的 DOM 将随树重建;焦点块由 renderBlockTree 在命中时
    // 经 mountFocusedInto 重挂(pendingFocus 已带落点)。
    if (this.focusedView) {
      this.focusedView.destroy();
      this.focusedView = null;
    }
    this.renderGeneration++;
    renderBlockTree(this.treeEl, roots, this);
    this.syncSelectionClasses();
  }

  /** 把焦点块的 CM6 挂进 content(renderBlockTree 在 focusedBlock===b 时调用) */
  mountFocusedInto(content: HTMLElement): void {
    const b = this.focusedBlock;
    if (!b || !this.opts.editable) return;
    const pending = this.pendingFocus ?? { pos: this.savedFocusPos, clickXY: null };
    this.pendingFocus = null;
    const v = mountFocusedEditor(content, b, pending.pos, this);
    this.focusedView = v;
    if (pending.clickXY) {
      // 用点击的页面坐标在挂载后的视图里落光标(staticPos 精修是整页视图
      // 对长块的手段,片段块普遍很短,直接映射足够准)。
      const p = cursorAtCoords(v, pending.clickXY.x, pending.clickXY.y, 'end');
      applyCursorAndScroll(v, p);
    }
  }

  /** 提交一个块内 CM 实例的文本到块模型(Esc/EscHandler 兜底路径) */
  commitViewNow(view: EditorView, block: Block): void {
    const changed = commitEditorText(view, block, this.templateContext());
    if (this.focusedView === view) {
      this.focusedView = null;
      this.focusedBlock = null;
    }
    view.destroy();
    clearActiveBlockEditor(this.app);
    if (changed) this.contentChanged(block);
    // 未变更也要补回静态渲染:CM destroy 已移除编辑 DOM,不补显示态就空白了
    // (与 BlockEditorView.commitViewNow 的无条件 refreshBlockContent 对齐)。
    else refreshBlockContent(block, this);
  }

  /** 提交焦点块编辑文本到模型;返回是否有变化 */
  commitFocusedText(): void {
    const v = this.focusedView;
    const b = this.focusedBlock;
    if (!v || !b) return;
    const changed = commitEditorText(v, b, this.templateContext());
    v.destroy();
    this.focusedView = null;
    this.focusedBlock = null;
    if (changed) this.contentChanged(b);
    else refreshBlockContent(b, this);
  }

  /** 模型内容变化后:通知调用方 + 单块静态刷新 */
  private contentChanged(b: Block): void {
    this.opts.onContentChange?.(serializeDocument(this.doc));
    refreshBlockContent(b, this);
  }

  /** 焦点状态全部清掉(不提交)——setMarkdown 换内容用 */
  private clearFocus(): void {
    this.pendingFocus = null;
    this.savedFocusPos = 'end';
    if (this.focusedView) {
      this.focusedView.destroy();
      this.focusedView = null;
    }
    this.focusedBlock = null;
  }

  // ------------------------------------------------------------------
  // 焦点 / 点击
  // ------------------------------------------------------------------

  focusBlock(b: Block, pos: CursorPos = 'end'): void {
    if (!this.opts.editable) return;
    if (this.focusedView && this.focusedBlock === b) {
      applyCursor(this.focusedView, pos);
      this.focusedView.focus();
      return;
    }
    this.commitFocusedText();
    this.clearSelection();
    this.focusedBlock = b;
    this.lastEditedBlock = b;
    this.savedFocusPos = pos;
    this.pendingFocus = { pos, clickXY: null };
    this.renderInner();
  }

  focusBlockFromClick(b: Block, ev: MouseEvent): void {
    if (!this.opts.editable) return;
    this.clearSelection();
    const xy = { x: ev.clientX, y: ev.clientY };
    if (this.focusedView && this.focusedBlock === b) {
      const p = cursorAtCoords(this.focusedView, xy.x, xy.y, 'end');
      applyCursor(this.focusedView, p);
      this.focusedView.focus();
      return;
    }
    this.commitFocusedText();
    this.focusedBlock = b;
    this.lastEditedBlock = b;
    this.savedFocusPos = 'end';
    this.pendingFocus = { pos: 'end', clickXY: xy };
    this.renderInner();
  }

  onFocusedTextChange(): void {
    this.lastEditedBlock = this.focusedBlock;
  }

  onFocusedBlur(): void {
    // CM6 在窗口非前台(测试/后台窗口)的首次挂载也会发 blur;下一拍复核,
    // 焦点回到本片段的 CM6 就不算真失焦。
    window.setTimeout(() => {
      const v = this.focusedView;
      if (!v) return;
      if (v.hasFocus || document.activeElement === v.contentDOM || v.contentDOM.contains(document.activeElement)) return;
      this.commitFocusedText();
    }, 0);
  }

  // ------------------------------------------------------------------
  // 选区
  // ------------------------------------------------------------------

  captureRangeAnchor(ev: MouseEvent): void {
    this.pendingRangeAnchor = ev.shiftKey
      ? rangeAnchor(this.visibleRoots, this.lastClicked, this.focusedBlock)
      : null;
  }

  selectFromClick(b: Block, ev: MouseEvent): void {
    const anchor = ev.shiftKey
      ? this.pendingRangeAnchor ?? rangeAnchor(this.visibleRoots, this.lastClicked, this.focusedBlock)
      : null;
    this.pendingRangeAnchor = null;
    this.commitFocusedText();
    if (ev.shiftKey && anchor) {
      const range = visibleRange(this.visibleRoots, anchor, b);
      if (range) {
        this.selectedBlocks = new Set(range);
        this.lastClicked = b;
        this.syncSelectionClasses();
        this.treeEl.focus({ preventScroll: true });
        return;
      }
    }
    if (ev.ctrlKey || ev.metaKey) {
      if (this.selectedBlocks.has(b)) this.selectedBlocks.delete(b);
      else this.selectedBlocks.add(b);
    } else {
      this.selectedBlocks.clear();
      this.selectedBlocks.add(b);
    }
    this.lastClicked = b;
    this.syncSelectionClasses();
    if (this.selectedBlocks.size > 0) this.treeEl.focus({ preventScroll: true });
    else this.treeEl.blur();
  }

  /** 顶层选区(不含被选祖先覆盖的块),按可见顺序 */
  topSelectedBlocks(): Block[] {
    const sel = this.selectedBlocks;
    const tops = [...sel].filter((b) => {
      let p = b.parent;
      while (p) {
        if (sel.has(p)) return false;
        p = p.parent;
      }
      return true;
    });
    const order = new Map(flattenVisible(this.visibleRoots).map((b, i) => [b, i] as const));
    return tops.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  syncSelectionClasses(): void {
    for (const b of flattenVisible(this.visibleRoots)) {
      const wrap = findBlockEl(b);
      if (wrap) wrap.classList.toggle('is-selected', this.selectedBlocks.has(b));
    }
  }

  private clearSelection(): void {
    if (this.selectedBlocks.size === 0) return;
    this.selectedBlocks.clear();
    this.lastClicked = null;
    this.syncSelectionClasses();
    this.treeEl.blur();
  }

  // ------------------------------------------------------------------
  // 折叠 / 缩放 / 标记
  // ------------------------------------------------------------------

  zoomIn(_b: Block): void {
    // 片段没有缩放语义:保持整段可见。
  }

  cycleFold(b: Block): void {
    this.setFold(b, nextFoldLevel(foldLevelOf(b.props), false));
  }

  /** Alt+点击:折叠/展开全部后代(视图同义) */
  foldSubtree(b: Block): void {
    const targets = subtreeFoldTargets(b);
    if (targets.length === 0) {
      this.cycleFold(b);
      return;
    }
    const opening = targets.some((t) => foldLevelOf(t.props) === 'none');
    this.mutate(() => {
      for (const t of targets) setCollapsed(t, opening);
    });
  }

  setFold(b: Block, level: FoldLevel): void {
    const value = foldValueFor(level);
    if (foldLevelOf(b.props) === level) return;
    this.mutate(() => {
      for (const k of Object.keys(b.props)) {
        if (normFoldKey(k) === 'collapsed') delete b.props[k];
      }
      if (value !== null) b.props['collapsed'] = value;
      // 折叠块不能停留在编辑态(编辑器会盖住摘要),先落盘退出编辑。
      if (level !== 'none' && this.focusedBlock === b) this.commitFocusedText();
    });
  }

  /** 折叠引导线点击:未全折 → 折整棵子树;已全折 → 展开 */
  toggleCollapseGuide(b: Block): void {
    const expanding = isSubtreeFullyFolded(b);
    this.mutate(() => {
      if (expanding) {
        if (isCollapsed(b)) setCollapsed(b, false);
        expandLevels(b, 0);
      } else {
        collapseLevels(b, 0);
      }
    });
  }

  toggleMarker(b: Block): void {
    this.mutate(() => cycleMarker(b));
  }

  // ------------------------------------------------------------------
  // 块结构操作(slash 菜单块级命令)
  // ------------------------------------------------------------------

  createFirstBlock(): void {
    if (!this.opts.editable) return;
    // 片段内新块同样默认段落容器(与视图同旨)。
    const b = createBlock('');
    b.bare = true;
    this.mutate(() => {
      this.doc.blocks.push(b);
    });
    this.focusBlock(b, 0);
  }

  /** 点击末尾空区:在可见轮廓末尾追加一个新块并聚焦(视图同义) */
  addBlockAtEnd(): void {
    if (!this.opts.editable) return;
    let nb: Block | null = null;
    this.mutate(() => {
      nb = createBlock('');
      (nb as Block).bare = true;
      const last = this.doc.blocks[this.doc.blocks.length - 1];
      if (last) {
        const sibs = siblingsOf(last);
        sibs.splice(sibs.indexOf(last) + 1, 0, nb);
        nb.parent = last.parent ?? null;
      } else {
        this.doc.blocks.push(nb);
      }
    });
    if (nb) this.focusBlock(nb as Block, 0);
  }

  /** 顶层插入整块(片段内一般等价于末尾/当前根之后) */
  insertTopLevelBlock(text: string, kind: 'list' | 'raw' = 'list'): Block {
    const nb: Block = { kind, marker: null, text, props: {}, children: [], parent: null };
    this.mutate(() => {
      const anchorRoot = this.focusedBlock
        ? ((() => {
            let a: Block | null = this.focusedBlock;
            while (a?.parent) a = a.parent;
            return a;
          })())
        : null;
      const at = anchorRoot ? this.doc.blocks.indexOf(anchorRoot) : -1;
      if (at >= 0) this.doc.blocks.splice(at + 1, 0, nb);
      else this.doc.blocks.push(nb);
    });
    return nb;
  }

  /** Tab/Shift+Tab 等价的缩进/反缩进 */
  handleTabFromCommand(shift: boolean): void {
    const b = this.focusedBlock;
    if (!b) return;
    const offset = this.focusedView?.state.selection.main.head ?? 0;
    this.mutate(() => {
      if (shift) outdent(b);
      else indent(b);
    });
    this.focusBlock(b, Math.min(offset, b.text.length));
  }

  /** 在焦点块下方新建同层空块(Enter 等价) */
  handleEnterFromCommand(): void {
    const b = this.focusedBlock;
    if (!b) return;
    let nb: Block | null = null;
    this.mutate(() => {
      nb = b.kind === 'raw' ? splitRawToOutline(b, b.text.length) : splitBlock(b, b.text.length);
    });
    const target = nb as Block | null;
    if (target) this.focusBlock(target, 0);
  }

  /** 删除焦点块;子块上提一层(视图同义) */
  deleteFocusedBlock(): void {
    const b = this.focusedBlock;
    if (!b) return;
    const kids = b.children;
    this.mutate(() => {
      const sibs = removeBlock(b);
      const idx = sibs.indexOf(b) >= 0 ? sibs.indexOf(b) : sibs.length;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        sibs.splice(idx, 0, k);
        k.parent = b.parent ?? null;
      }
    });
  }

  /** 模型级修改的统一入口:提交焦点文本 → fn → 整段重渲染(保焦点) */
  mutate(fn: () => void, _patch?: () => MutatePatch): void {
    const v = this.focusedView;
    const b = this.focusedBlock;
    if (v && b) {
      commitEditorText(v, b, this.templateContext());
      this.savedFocusPos = v.state.selection.main.head;
    }
    fn();
    if (b) this.pendingFocus = { pos: this.savedFocusPos, clickXY: null };
    this.renderInner();
    this.opts.onContentChange?.(serializeDocument(this.doc));
  }

  // ------------------------------------------------------------------
  // 环境/降级面
  // ------------------------------------------------------------------

  /** 片段的嵌入行是静态的:不支持就地编辑 */
  startEmbedEdit(_row: HTMLElement, _source: EmbedSource, _path?: number[]): void {
    // no-op
  }

  /** 片段没有"其他地方打开的编辑器"可复用 */
  findOpenBlockEditor(_path: string): { doc: ParsedDocument } | null {
    return null;
  }

  /** 片段一律用 logseq 风格的 props 文本编辑 */
  nativePropsEditorFor(_content: HTMLElement, _b: Block): boolean {
    return false;
  }

  openLink(linktext: string): void {
    if (this.opts.onOpenLink) this.opts.onOpenLink(linktext);
    else void this.app.workspace.openLinkText(linktext, '', false);
  }

  bumpScrollCap(): void {
    // 免虚拟化:无需扩容
  }

  /** 销毁存活于 el 子树内的焦点编辑器(el 所在区段即将重建) */
  destroyFocusedInside(el: HTMLElement): void {
    const v = this.focusedView;
    if (v && el.contains(v.dom)) {
      v.destroy();
      this.focusedView = null;
    }
  }

  autocompleteSources(embed = false): CompletionSource[] {
    return autocompleteSources(this, embed);
  }

  /** 代码注释区:块文本行首 `#` 是注释标记,编辑态不按标题渲染 */
  suppressHeadingDecor(_b: Block): boolean {
    return this.opts.codeComment === true;
  }

  templateContext(): TemplateContext {
    return {
      currentPage: '',
      vars: parseVarLines(this.plugin.settings.customTemplateVars),
    };
  }

  // ------------------------------------------------------------------
  // TraceTime:片段无文件,全部退化为静态
  // ------------------------------------------------------------------

  tracetimeModifiedAt(_b: Block): number | null {
    return null;
  }

  tracetimeFormat(_minutes: number): string {
    return '';
  }

  tracetimeVertical(): string {
    return 'middle';
  }
}
