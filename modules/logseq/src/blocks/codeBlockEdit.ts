/**
 * Code-block edit mode (Logseq parity): a block whose text ends in a code
 * fence opens a dedicated code editor — no fence markers on screen, Enter
 * inserts newlines INSIDE the code (never splits the outline block), Esc or
 * clicking another block commits and re-wraps the fence. Mixed blocks
 * (image/prose lines BEFORE the fence) keep their prefix rendered statically
 * while the fence gets the editor; prose after the closing fence keeps the
 * regular editor. "Source mode" also keeps the raw view.
 */

// CodeMirror is imported through the `cm-bundle:` prefix (rewritten by an
// esbuild/vite resolver): this module gets its OWN bundled CM6 copy instead of
// Obsidian's shared instance. Obsidian's CM build silently drops decorations
// created by a plugin's syntaxHighlighting(), so code-block highlighting never
// renders through it. The bundled copy is self-contained and only used by the
// dedicated code editor — the outline editor keeps the shared instance for
// third-party registerEditorExtension compatibility.
//
// 编辑器本体是 Monaco(开源 VS Code 内核),与外部代码文件同一套技术:
// 语言解析/高亮见 src/editor/monaco.ts;已装扩展的 TM 语法经 grammarLoader
// 注册进 Monaco(市场扩展覆盖内置 monarch)。
import { createEditor, setupMonaco, getLanguageByFence } from '../editor/monaco';
import type { Block } from '../types';
import type { BlockEditorView } from '../view/BlockEditorView';

// parseCodeFence/CodeFenceInfo 移至 codeFence.ts(纯逻辑,单测不必拉起 Monaco)。
import { parseCodeFence, type CodeFenceInfo } from './codeFence';

export { parseCodeFence, type CodeFenceInfo };

/**
 * Monaco 编辑器的最小适配面:BlockEditorView 对聚焦代码块的全部操作都走这里,
 * 不直接触碰 CM6/Monaco 的具体 API(换实现只改本文件)。
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
   * Replace this static element (the rendered code block inside the cached
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

/**
 * Mount the dedicated code editor into the focused block's content slot.
 * Enter inserts a newline in the code (the outline keymap does not apply
 * here); Esc commits through host.commitFocusedText().
 */
export function mountCodeEditor(
  content: HTMLElement,
  block: Block,
  info: CodeFenceInfo,
  host: BlockEditorView,
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
  const bar = document.createElement('div');
  bar.className = 'lgp-code-toolbar';
  wrap.appendChild(bar);
  // The language label is the ONLY path into source mode, so it must render
  // for EVERY fence. It used to be gated on `info.lang || info.prefix`, which
  // left a plain fence with no language and no prefix (e.g. an untyped
  // ```python-ish snippet under a heading) with no clickable target at all —
  // the language could then never be set. An empty language shows as the
  // placeholder `text`; the fence line itself is in the doc once source mode
  // opens, so the caret lands right after it and the word can be typed.
  {
    const langEl = document.createElement('span');
    langEl.className = info.lang ? 'lgp-code-lang' : 'lgp-code-lang lgp-code-lang-empty';
    langEl.textContent = info.lang || 'text';
    langEl.title = 'Edit as source (change language)';
    langEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sourceMode) {
        // Already in source mode — the fence line is IN the doc: just put
        // the caret at the end of the language word.
      if (viewRef) {
        viewRef.caretToEndOfLine1();
      }
        return;
      }
      // Click the language label → one-shot source mode with the cursor at
      // the end of the fence's language word, so the language can be edited
      // directly (the code content is committed first, never lost).
      host.commitFocusedText();
      host.sourceModeBlock = block;
      // Mixed blocks: the opening fence is NOT line 0 — offset past the prefix.
      const openPos = (info.prefix ? info.prefix.length + 1 : 0) + info.openLine.length;
      host.focusBlock(block, Math.min(openPos, block.text.length));
    });
    bar.appendChild(langEl);
  }
  const hint = document.createElement('span');
  hint.className = 'lgp-code-edit-hint';
  hint.textContent = 'Esc';
  bar.appendChild(hint);
  const body = document.createElement('div');
  body.className = 'lgp-code-editor-host';
  wrap.appendChild(body);

  // Monaco 挂载(块内:高度贴内容、无行号;Esc 提交回块模型)
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
  const mEditor = createEditor(body, {
    value: doc,
    language: getLanguageByFence(info.lang),
    autoHeight: true,
    lineNumbers: false,
    fontFamily: 'var(--font-monospace)',
    fontSize,
    lineHeight: Math.round(fontSize * 1.5),
    vPadding: Math.round(fontSize * 0.4),
    onEscape: () => host.commitFocusedText(),
  });
  const model = mEditor.getModel();
  const handle: CodeEditorHandle = {
    getText: () => mEditor.getValue(),
    getDocLength: () => model?.getValueLength() ?? 0,
    focus: () => mEditor.focus(),
    dom: body,
    dispose: () => {
      const m = mEditor.getModel();
      mEditor.dispose();
      m?.dispose();
    },
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
