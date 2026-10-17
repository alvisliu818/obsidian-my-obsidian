/**
 * BlockRenderHost — 渲染器(renderTree/focusEditor/extensions)对宿主的依赖面。
 *
 * 历史上这三个模块只服务 BlockEditorView(整页大纲编辑器),host 参数直接
 * 写死成那个 2900 行的视图类。片段嵌入(notebook 的 md 单元格等)需要同一套
 * 渲染/编辑管线,却不带整个文件编辑器 —— 于是把宿主面收成接口:
 *
 * - BlockEditorView 结构上满足本接口(成员原样),渲染路径零行为变化;
 * - 轻量宿主(blocks/fragmentEditor.ts 的 FragmentHost)实现同一接口,
 *   用最小的编辑子集(单块 CM + serialize 回调)支撑「一段 markdown 的
 *   logseq 风格渲染与就地编辑」,供外部插件通过 plugin.renderMarkdownFragment
 *   跨插件调用。
 *
 * extends Component:renderTree 的静态内容渲染把 host 直接当
 * MarkdownRenderer.render 的 component 参数用。
 */

import { App, Component, TFile, WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { CompletionSource } from '@codemirror/autocomplete';
import type { Block, ParsedDocument } from '../types';
import type { CursorPos } from '../editor/focusEditor';
import type { FoldLevel } from '../core/fold';
import type { MutatePatch } from '../view/BlockEditorView';
import type { EmbedSource } from '../features/links';
import type { TemplateContext } from '../features/template';
import type LogseqEditorPlugin from '../main';

export interface BlockRenderHost extends Component {
  // ===== 环境 =====
  plugin: LogseqEditorPlugin;
  app: App;
  /** 片段场景:正在渲染的块模型(宿主持有并负责 serialize) */
  doc: ParsedDocument;
  /** 所属文件;片段场景为 null(静态渲染的相对链接 sourcePath 退化为 '') */
  file: TFile | null;
  containerEl: HTMLElement;
  /** 宿主所在工作区 leaf(文件型视图用);片段宿主为 null */
  readonly leaf: WorkspaceLeaf | null;
  /** 就地嵌入编辑会话(渲染器只关心 view 字段);片段宿主为 null */
  readonly embedEdit?: { view: EditorView } | null;

  // ===== 渲染决策 =====
  focusedBlock: Block | null;
  /** 最近一次编辑过的块(blockTypeMenu 判断菜单落点用) */
  lastEditedBlock: Block | null;
  focusedView: EditorView | null;
  zoomedBlock: Block | null;
  sourceModeBlock: Block | null;
  selectedBlocks: Set<Block>;
  foldEnabled: boolean;
  renderGeneration: number;
  scrollCap: number;
  contentTreeEl: HTMLElement;
  visibleRoots: Block[];

  // ===== 编辑/交互 =====
  /** 把焦点块的 CM6 挂进 content(renderBlockTree 在 focusedBlock===b 时调用) */
  mountFocusedInto(content: HTMLElement): void;
  /** 提交一个块内 CM 实例的文本到块模型(Esc/EscHandler 兜底路径) */
  commitViewNow(view: EditorView, block: Block): void;
  /** 提交焦点块编辑文本到模型(块级命令前确保不丢改动) */
  commitFocusedText(): void;
  /** 按 selectedBlocks 重刷 DOM 选中类(块级命令后同步视觉) */
  syncSelectionClasses(): void;
  focusBlock(b: Block, pos?: CursorPos): void;
  focusBlockFromClick(b: Block, ev: MouseEvent): void;
  selectFromClick(b: Block, ev: MouseEvent): void;
  captureRangeAnchor(ev: MouseEvent): void;
  zoomIn(b: Block): void;
  cycleFold(b: Block): void;
  foldSubtree(b: Block): void;
  setFold(b: Block, level: FoldLevel): void;
  toggleMarker(b: Block): void;
  toggleCollapseGuide(b: Block): void;
  createFirstBlock(): void;
  addBlockAtEnd(): void;
  /** 顶层插入新块(slash 菜单命令) */
  insertTopLevelBlock(text: string, kind?: 'list' | 'raw'): Block;
  /** Tab 缩进 / Enter 新建 / 删除焦点块(slash 菜单块级命令) */
  handleTabFromCommand(shift: boolean): void;
  handleEnterFromCommand(): void;
  deleteFocusedBlock(): void;
  /** 打开一段嵌入内容的就地编辑(页面/块嵌入行) */
  startEmbedEdit(row: HTMLElement, source: EmbedSource, path?: number[]): void;
  /** 找到已打开且正编辑该路径的宿主(嵌入复用其 doc);无则 null */
  findOpenBlockEditor(path: string): { doc: ParsedDocument } | null;
  /** 顶层选区(块类型菜单判断批量改型范围);无选区返回空数组 */
  topSelectedBlocks(): Block[];
  bumpScrollCap(): void;
  destroyFocusedInside(el: HTMLElement): void;
  mutate(fn: () => void, patch?: () => MutatePatch): void;
  nativePropsEditorFor(content: HTMLElement, b: Block): boolean;
  openLink(linktext: string): void;
  tracetimeModifiedAt(b: Block): number | null;
  tracetimeFormat(minutes: number): string;
  tracetimeVertical(): string;

  // ===== 块内编辑器扩展构建(focusEditor/extensions 需要) =====
  onFocusedTextChange(): void;
  onFocusedBlur(): void;
  autocompleteSources(embed?: boolean): CompletionSource[];
  templateContext(): TemplateContext;
  /**
   * 该块的编辑态是否抑制 live-preview 标题渲染(可选)。
   * 代码注释区宿主实现为 true:块文本行首 `#` 是注释标记,不是标题。
   */
  suppressHeadingDecor?(b: Block): boolean;
}
