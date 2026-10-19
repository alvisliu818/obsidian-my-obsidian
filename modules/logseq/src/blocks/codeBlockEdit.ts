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
import { effectiveFontSize, getEditorSettings } from '../editor/editorSettings';
import { monacoLspAttach } from '../lsp/monacoLspBridge';
import { encodeFileUri } from '../lsp/lspHost';
import { blockId } from '../types';
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

// ---------------------------------------------------------------------
// 度量:两态共用同一份计算(字号/行高/内边距)
//
// 编辑态的 Monaco 会被「用户编辑器设置」覆盖层改字号/行高(settings.json,
// 见 editorSettings.ts)——只算阅读态的 CSS 默认(1em/1.5)就会两态不一样高、
// 字不一样大。所以这里按**编辑器最终生效的那个字号**折算行高与内边距,
// 静态阅读渲染也用同一组数,两态盒子才逐像素吻合。
// ---------------------------------------------------------------------

interface BlockCodeMetrics {
  /** 编辑器最终生效字号(设置里 0 = 跟随宿主计算值) */
  fontSize: number;
  lineHeight: number;
  /** 字体族(设置里 '' = 走 Obsidian 等宽变量) */
  fontFamily: string;
  /** 上下内边距(0.4×字号,与旧阅读态 pre 的 0.4em 同源) */
  vPadding: number;
  /** 左右内边距:0.9em,em 取**宿主**字号(与 .lgp-code-editor-host 的 CSS 一致) */
  hPadding: number;
}

/**
 * 与 mountCodeEditor 里传给 mountSharedBlockEditor 的那几个度量**逐项同式**
 * (编辑态是单例 + 用户设置覆盖层,这里必须算出同一组数,两态才逐像素吻合)。
 */
function blockCodeMetrics(hostFontSize: number): BlockCodeMetrics {
  const s = getEditorSettings();
  const fontSize = effectiveFontSize(hostFontSize);
  return {
    fontSize,
    lineHeight: s.lineHeight >= 8 ? s.lineHeight : Math.round(fontSize * 1.5),
    fontFamily: s.fontFamily || 'var(--font-monospace)',
    vPadding: Math.round(fontSize * 0.4),
    hPadding: Math.round(hostFontSize * 0.9 * 10) / 10,
  };
}

/** 宿主字号:编辑态取 .lgp-code-editor-host,阅读态取 wrap 本身(同一上下文)。 */
function hostFontSizeOf(el: HTMLElement): number {
  const px = parseFloat(getComputedStyle(el).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 13;
}

/** 把度量钉到静态阅读渲染的 pre/code 上(覆盖 styles.css 的 em 版默认值)。 */
function applyMetricsToPre(pre: HTMLElement, m: BlockCodeMetrics): void {
  const st = pre.style;
  st.setProperty('font-size', `${m.fontSize}px`, 'important');
  st.setProperty('font-family', m.fontFamily, 'important');
  st.setProperty('line-height', `${m.lineHeight}px`, 'important');
  st.setProperty('padding', `${m.vPadding}px ${m.hPadding}px`, 'important');
  const code = pre.querySelector('code');
  if (code) {
    code.style.setProperty('font-size', `${m.fontSize}px`, 'important');
    code.style.setProperty('font-family', m.fontFamily, 'important');
    code.style.setProperty('line-height', `${m.lineHeight}px`, 'important');
  }
}

/**
 * 静态渲染(阅读态)挂一个代码块:工具栏 + Obsidian 渲染出来的 `<pre>`,
 * 再用 Monaco colorize 把 pre 的内容换成**编辑器同款**着色(mtk 类,
 * 颜色由主题 CSS 决定)。colorize 失败时保留 Prism 的原样输出(优雅降级)。
 *
 * 度量与编辑器同源(blockCodeMetrics),盒子逐像素一致。
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
  // 度量:与编辑态同一份计算(覆盖层改过字号/行高时,阅读态跟着变)
  applyMetricsToPre(pre, blockCodeMetrics(hostFontSizeOf(wrap)));
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
// 语言服务:块内代码的虚拟文档身份
// ---------------------------------------------------------------------

/** languageId → 文件扩展名(与 serverSpecs 的语言路由对齐) */
const LANG_EXT: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  json: 'json',
  css: 'css',
  html: 'html',
  yaml: 'yaml',
  markdown: 'md',
};

/** 稳定的短 id：块属性里的 id 优先，否则按文本取哈希（同一段内容始终同一身份）。 */
function stableBlockKey(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 文件名里不能出现的字符 → 连字符；过长截断。 */
function safeName(s: string, max = 40): string {
  return s
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'note';
}

/**
 * 块内代码块在语言服务眼里的身份 —— 一个**宿主笔记同目录**的虚拟文件。
 *
 * 同目录是关键：basedpyright 解析 `import xxx` 时按文件所在目录找
 * site-packages / 相对导入，虚拟文件跟 .md 同级，解析结果与用户自己在这个
 * 目录放一个同名 .py 完全一致。名字带块 id，反复聚焦同一块命中同一文档。
 */
function blockDocIdentities(
  host: BlockRenderHost,
  lang: string,
  block: Block,
): { abs: string | null; uri: string | null } {
  const languageId = getLanguageByFence(lang);
  const ext = LANG_EXT[languageId];
  if (!ext) return { abs: null, uri: null }; // 无对应类型/无 server 的语言不接
  const notePath = host.file?.path ?? '';
  if (!notePath) return { abs: null, uri: null };
  const dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
  const base = safeName(notePath.slice(notePath.lastIndexOf('/') + 1).replace(/\.md$/i, ''));
  const key = blockId(block) || stableBlockKey(block.text);
  const rel = `${dir ? `${dir}/` : ''}${base}-${key}.${ext}`;
  // vault.adapter 是 VaultAdapter,BaseAdapter 上都有 getFullPath(vault 相对 → 绝对)
  let abs = rel;
  try {
    const adapter = host.app.vault.adapter as unknown as { getFullPath?: (p: string) => string };
    if (typeof adapter?.getFullPath === 'function') abs = adapter.getFullPath(rel);
  } catch {
    /* 拿不到绝对路径就退回相对路径（虚拟路径仍唯一，只是 import 解析少一环） */
  }
  return { abs, uri: encodeFileUri(abs) };
}

/** Monaco model 的 uri（虚拟文件身份）。 */
function blockDocUri(host: BlockRenderHost, lang: string, block: Block): string {
  return blockDocIdentities(host, lang, block).uri ?? '';
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
  // 用户编辑器设置哨兵感知(fontSize>0 / lineHeight>=8 / fontFamily 非空 =
  // 全局统一覆盖,含块内代码块);哨兵(0/''/<8)时保持上面的「跟阅读态」折算。
  const cs = getComputedStyle(body);
  const user = getEditorSettings();
  const fontSize = user.fontSize > 0 ? user.fontSize : Math.round((parseFloat(cs.fontSize) || 13) * 10) / 10;
  const codeLease = mountSharedBlockEditor(body, {
    value: doc,
    language: getLanguageByFence(info.lang),
    // 语言服务按**路径**定位文档:给块内容造一个「宿主笔记同目录」的虚拟文件
    // 身份(如 `笔记-<blockId>.py`),同目录意味着 pyright 解析 import 时与真实
    // 文件一致;名字跟块 id 绑定,反复聚焦同一块能命中同一文档,不重复分析。
    uri: blockDocUri(host, info.lang, block),
    fontFamily: user.fontFamily || 'var(--font-monospace)',
    fontSize,
    lineHeight: user.lineHeight >= 8 ? user.lineHeight : Math.round(fontSize * 1.5),
    vPadding: Math.round(fontSize * 0.4),
    onEscape: () => host.commitFocusedText(),
    // 分栏里另一个视图聚焦了别的代码块 → 单例要搬走:先把这一块的编辑
    // 落地(提交 + 还原 DOM),否则它的文本会跟着实例一起被覆盖。
    onPreempt: () => host.commitFocusedText(),
  });
  // 语言服务:补全 / hover / 诊断波浪线。LSP 关闭或该语言没有 server 时
  // monacoLspAttach 返回空数组,零开销;归还单例时一并摘掉。
  const blockLang = getLanguageByFence(info.lang);
  const lspDisposables = monacoLspAttach(host.plugin, codeLease.editor, blockLang, blockDocUri(host, info.lang, block));
  const releaseEditor = (): void => {
    codeLease.release();
    for (const d of lspDisposables) {
      try {
        d.dispose();
      } catch {
        /* 已销毁 */
      }
    }
  };
  const mEditor = codeLease.editor;
  const model = mEditor.getModel();
  const handle: CodeEditorHandle = {
    getText: () => mEditor.getValue(),
    getDocLength: () => model?.getValueLength() ?? 0,
    focus: () => mEditor.focus(),
    dom: body,
    // 单例:不销毁,只把容器搬回池里复用(见 monaco.ts 的全局单例段),同时
    // 摘掉这块的语言服务订阅。
    dispose: () => releaseEditor(),
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
  (body as HTMLElement & { __lgEditor?: unknown }).__lgEditor = mEditor;
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
