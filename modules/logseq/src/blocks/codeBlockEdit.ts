/**
 * 代码块:阅读态与编辑态共用**同一套 Monaco 引擎**,但只有编辑态建实例。
 *
 * 历史:阅读态是 Obsidian 的 Prism 渲染,编辑态是 Monaco —— 两套分词器/两套
 * 主题规则,颜色字体永远对不齐(用户多次报告「阅读态和编辑器样式不一样」)。
 * 曾经让阅读态也挂只读 Monaco 实例,但一个代码块就是一个完整编辑器,
 * 几十个代码块的文档直接卡死。
 *
 * 现在的方案(性能与一致兼得):
 * - 阅读态:`monaco.editor.colorize()` 产出静态 HTML —— 与编辑器**同一个**
 *   Monarch 分词器、同一套主题规则(mtk 类的颜色由主题服务注入的 CSS 决定,
 *   明暗切换自动跟随),零编辑器实例;
 * - 编辑态:聚焦时才建真正的 Monaco 实例(mountCodeEditor),提交后销毁,
 *   同一时刻只有一个;
 * - 两态因此颜色完全同源,且文档里有再多代码块也不驻留编辑器。
 *
 * 混合块(图片/文字前缀 + 围栏):前缀保持静态渲染,代码部分在聚焦时换成
 * 编辑器,提交后换回静态渲染(缓存渲染保持有效)。
 */

import { mountSharedBlockEditor, setupMonaco, getLanguageByFence, colorizeCode } from '../editor/monaco';
import { setIcon } from 'obsidian';
import type { Block } from '../types';
import type { BlockRenderHost } from './renderHost';

// parseCodeFence/CodeFenceInfo 在 codeFence.ts(纯逻辑,单测不必拉起 Monaco)。
import { parseCodeFence, type CodeFenceInfo } from './codeFence';
import { createRunButton, mountRunUi, registerCodeWrap } from '../exec/codeBlockRun';

export { parseCodeFence, type CodeFenceInfo };

/**
 * Monaco 编辑器的最小适配面:BlockEditorView 对聚焦代码块的全部操作都走这里,
 * 不直接触碰 Monaco 的具体 API(换实现只改本文件)。
 */
export interface CodeEditorHandle {
  /** 全文(提交与光标换算用) */
  getText(): string;
  getDocLength(): number;
  focus(): void;
  /** destroyFocusedInside 的包含关系判定用 */
  dom: HTMLElement;
  dispose(): void;
  /** 点击坐标 → 文档字符偏移(命中不了行时回退 fallback) */
  offsetAtCoords(x: number, y: number, fallback: number): number;
  /** 该偏移在视口内的纵向坐标(用于命中校验);拿不到返回 null */
  topAtOffset(offset: number): number | null;
  /** 把光标放到指定字符偏移并滚动到可见 */
  placeCursorAndScroll(offset: number): void;
  /** 光标放到第 1 行行尾(源码模式语言词后) */
  caretToEndOfLine1(): void;
}

export interface MountedCodeEditor {
  view: CodeEditorHandle;
  block: Block;
  /** The prefix lines kept rendered statically (mixed blocks; '' for pure). */
  prefix: string;
  fence: string;
  openLine: string;
  /** Whether the block text carried a closing fence. */
  closed: boolean;
  /** Source variant: the doc is the fence SOURCE (markers/language editable). */
  source: boolean;
  /** The editing wrap that replaced the static code element (mixed blocks). */
  editingWrap: HTMLElement | null;
  /** The static code element to restore on commit (mixed blocks). */
  restoreEl: HTMLElement | null;
}

export interface CodeMountOpts {
  /**
   * Replace this static element (the rendered code element inside the cached
   * static render) instead of appending the editor to `content` — the mixed
   * block keeps its rendered prefix (image/prose) untouched on screen.
   */
  replaceEl?: HTMLElement;
  /**
   * Source mode: the doc is the fence SOURCE (opening fence line + content +
   * closing fence) so the fence markers and the language word are editable;
   * commit writes the doc verbatim under the prefix. Mixed blocks only —
   * pure blocks keep the generic whole-text source editor.
   */
  source?: boolean;
}

// ---------------------------------------------------------------------
// 工具栏(两态共用一套:语言标签 + 复制 [+ 运行],Esc 提示仅编辑态可见)
// ---------------------------------------------------------------------

interface ToolbarCtx {
  block: Block;
  /** 当前代码文本(静态态读 DOM,编辑态读实例) */
  getCode: () => string;
  /** 围栏信息;fence 为空(缩进代码块)时语言标签不进源码模式 */
  info: CodeFenceInfo;
  host: BlockRenderHost;
  /** 源码模式入口(纯块由通用编辑器承担时传 null) */
  onSourceMode: (() => void) | null;
}

function buildCodeToolbar(wrap: HTMLElement, ctx: ToolbarCtx): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'lgp-code-toolbar';
  wrap.appendChild(bar);
  // The label renders for EVERY fence, in BOTH states (reading and
  // code-editing): it is the only way into source mode, and source mode is
  // the only way to set a language. It used to be gated on `lang || isMixed`,
  // which left a plain fence with no language and no prefix (e.g. an untyped
  // ```python-ish snippet under a heading) with no clickable target at all —
  // the language could then never be set. An empty language shows as the
  // placeholder `text`; the fence line itself is in the doc once source mode
  // opens, so the caret lands right after it and the word can be typed.
  const langEl = document.createElement('span');
  const applyLangLabel = (l: string): void => {
    langEl.className = l ? 'lgp-code-lang' : 'lgp-code-lang lgp-code-lang-empty';
    langEl.textContent = l || 'text';
  };
  applyLangLabel(ctx.info.lang);
  langEl.title = 'Edit as source (change language)';
  if (ctx.onSourceMode) {
    langEl.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      ctx.onSourceMode?.();
    });
  }
  bar.appendChild(langEl);
  // Copy button: present in BOTH states (one toolbar, one look).
  const copyBtn = document.createElement('span');
  copyBtn.className = 'lgp-code-copy';
  copyBtn.setAttribute('aria-label', 'Copy code');
  setIcon(copyBtn, 'copy');
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    void navigator.clipboard
      .writeText(ctx.getCode())
      .then(() => {
        setIcon(copyBtn, 'check');
        setTimeout(() => setIcon(copyBtn, 'copy'), 1200);
      })
      .catch(() => {});
  });
  bar.appendChild(copyBtn);
  // 「▶ 运行」+ 输出面板(仅 python/js/shell;按块记状态,重渲染后重挂)
  const runBtn = createRunButton(ctx.info.lang, ctx.getCode, ctx.block);
  if (runBtn) bar.appendChild(runBtn);
  // Esc hint: only meaningful while editing (CSS hides it in the reading state).
  const hint = document.createElement('span');
  hint.className = 'lgp-code-edit-hint';
  hint.textContent = 'Esc';
  bar.appendChild(hint);
  return bar;
}

/** 语言标签 → 一次性源码模式的公共入口(两态一致)。 */
function sourceModeHandler(ctx: { block: Block; info: CodeFenceInfo; host: BlockRenderHost }): () => void {
  return () => {
    ctx.host.commitFocusedText();
    ctx.host.sourceModeBlock = ctx.block;
    // Mixed blocks: the opening fence is NOT line 0 — offset past the prefix.
    const openPos = (ctx.info.prefix ? ctx.info.prefix.length + 1 : 0) + ctx.info.openLine.length;
    ctx.host.focusBlock(ctx.block, Math.min(openPos, ctx.block.text.length));
  };
}

// ---------------------------------------------------------------------
// 阅读态:静态着色(colorize),零实例
// ---------------------------------------------------------------------

/** 非围栏 pre(缩进代码块)的合成 info:只读展示,不进源码模式。 */
export function syntheticFenceInfo(lang: string, content: string): CodeFenceInfo {
  return { prefix: '', lang, content, fence: '', openLine: '', closed: false };
}

/**
 * 静态渲染(阅读态)挂一个代码块:工具栏 + Obsidian 渲染出来的 `<pre>`,
 * 再用 Monaco colorize 把 pre 的内容换成**编辑器同款**着色(mtk 类,
 * 颜色由主题 CSS 决定)。colorize 失败时保留 Prism 的原样输出(优雅降级)。
 *
 * `pre` 已被调用方换成的 `wrap` 里(或直接传入 wrap 由本函数接管)。
 */
export function mountCodeBlockReadOnly(
  wrap: HTMLElement,
  block: Block,
  lang: string,
  info: CodeFenceInfo,
  host: BlockRenderHost,
  pre: HTMLElement,
): void {
  wrap.className = 'lgp-code-block';
  const code = pre.querySelector('code') ?? pre;
  buildCodeToolbar(wrap, {
    block,
    info,
    host,
    getCode: () => code.textContent ?? pre.textContent ?? '',
    onSourceMode: info.fence ? sourceModeHandler({ block, info, host }) : null,
  });
  wrap.appendChild(pre);
  registerCodeWrap(block, wrap);
  mountRunUi(wrap, lang, block);
  // 静态着色:同一 Monarch 分词器 + 同一主题规则 → 与编辑态同色。
  // 异步;期间 pre 里是 Obsidian 的 Prism 输出(失败也就保留这样)。
  setupMonaco(host.plugin);
  const languageId = getLanguageByFence(lang);
  void colorizeCode(info.content || code.textContent || '', languageId)
    .then((html) => {
      if (!html) return;
      // Monaco 每行(含最后一行)都补一个 <br/>,剥掉末尾那个,盒子才和编辑态一边高
      const trimmed = html.replace(/<br\/>\s*$/, '');
      if (code.isConnected) code.innerHTML = trimmed;
    })
    .catch(() => {
      /* 保留 Prism 输出 */
    });
}

// ---------------------------------------------------------------------
// 编辑态:聚焦时才建的 Monaco 实例
// ---------------------------------------------------------------------

/**
 * Mount the dedicated code editor into the focused block's content slot.
 * Enter inserts a newline in the code (the outline keymap does not apply
 * here); Esc commits through host.commitFocusedText().
 */
export function mountCodeEditor(
  content: HTMLElement,
  block: Block,
  info: CodeFenceInfo,
  host: BlockRenderHost,
  opts: CodeMountOpts = {},
): MountedCodeEditor {
  const sourceMode = opts.source === true;
  // Referenced by the source-mode label handler before the handle exists.
  let viewRef: CodeEditorHandle | null = null;
  // Standard DOM APIs (no Obsidian prototype extensions) — keeps this module
  // testable outside Obsidian.
  const wrap = document.createElement('div');
  wrap.className = 'lgp-code-block lgp-code-editing';
  if (opts.replaceEl) opts.replaceEl.replaceWith(wrap);
  else content.appendChild(wrap);
  const onSourceMode = (): void => {
    if (sourceMode) {
      // Already in source mode — the fence line is IN the doc: just put
      // the caret at the end of the language word.
      viewRef?.caretToEndOfLine1();
      return;
    }
    // Click the language label → one-shot source mode with the cursor at
    // the end of the fence's language word, so the language can be edited
    // directly (the code content is committed first, never lost).
    sourceModeHandler({ block, info, host })();
  };
  buildCodeToolbar(wrap, {
    block,
    info,
    host,
    getCode: () => viewRef?.getText() ?? '',
    onSourceMode,
  });
  const body = document.createElement('div');
  body.className = 'lgp-code-editor-host';
  wrap.appendChild(body);

  // Monaco 挂载(块内:高度贴内容、无行号;Esc 提交回块模型)。
  // 走**全局单例**:聚焦时把实例搬进 body,提交后搬回池里,不销毁重建。
  setupMonaco(host.plugin);
  const doc = sourceMode
    ? info.closed
      ? `${info.openLine}\n${info.content}\n${info.fence}`
      : `${info.openLine}\n${info.content}`
    : info.content;
  // 度量对齐阅读态:pre 是 font-size 1em / line-height 1.5 / 内边距 0.4em 0.9em
  // (styles.css 钉死的值)。字号取宿主计算值,行高与上下内边距按同一字号折算,
  // 编辑态打开/提交时文字与盒子都不跳。
  const cs = getComputedStyle(body);
  const fontSize = Math.round((parseFloat(cs.fontSize) || 13) * 10) / 10;
  const codeLease = mountSharedBlockEditor(body, {
    value: doc,
    language: getLanguageByFence(info.lang),
    fontFamily: 'var(--font-monospace)',
    fontSize,
    lineHeight: Math.round(fontSize * 1.5),
    vPadding: Math.round(fontSize * 0.4),
    onEscape: () => host.commitFocusedText(),
    // 分栏里另一个视图聚焦了别的代码块 → 单例要搬走:先把这一块的编辑
    // 落地(提交 + 还原 DOM),否则它的文本会跟着实例一起被覆盖。
    onPreempt: () => host.commitFocusedText(),
  });
  const mEditor = codeLease.editor;
  const model = mEditor.getModel();
  const handle: CodeEditorHandle = {
    getText: () => mEditor.getValue(),
    getDocLength: () => model?.getValueLength() ?? 0,
    focus: () => mEditor.focus(),
    dom: body,
    // 单例:不销毁,只把容器搬回池里复用(见 monaco.ts 的全局单例段)。
    dispose: () => codeLease.release(),
    offsetAtCoords: (x, y, fallback) => {
      if (!model) return fallback;
      const t = mEditor.getTargetAtClientPoint(x, y);
      return t?.position ? model.getOffsetAt(t.position) : fallback;
    },
    topAtOffset: (offset) => {
      if (!model) return null;
      const p = model.getPositionAt(Math.max(0, Math.min(offset, model.getValueLength())));
      const vp = mEditor.getScrolledVisiblePosition(p);
      return vp ? vp.top : null;
    },
    placeCursorAndScroll: (offset) => {
      if (!model) return;
      const pos = model.getPositionAt(Math.max(0, Math.min(offset, model.getValueLength())));
      mEditor.setPosition(pos);
      mEditor.revealPositionInCenter(pos);
    },
    caretToEndOfLine1: () => {
      if (!model) return;
      const len = model.getLineContent(1).length;
      mEditor.setPosition(model.getPositionAt(len));
      mEditor.focus();
    },
  };
  // Debug handle for e2e verification (same convention as the outline editor).
  (body as HTMLElement & { __lgCode?: CodeEditorHandle }).__lgCode = handle;
  viewRef = handle;
  handle.focus();
  return {
    view: handle,
    block,
    prefix: info.prefix,
    fence: info.fence,
    openLine: info.openLine,
    closed: info.closed,
    source: sourceMode,
    editingWrap: opts.replaceEl ? wrap : null,
    restoreEl: opts.replaceEl ?? null,
  };
}
