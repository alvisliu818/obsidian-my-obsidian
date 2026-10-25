/**
 * Focused-block CM6 lifecycle: mount / commit / unmount.
 * One CM6 EditorView at a time, living inside the focused block's content DOM.
 */

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { closeCompletion, completionStatus } from '@codemirror/autocomplete';
import type { BlockRenderHost } from '../blocks/renderHost';
import { createEditorExtensions } from './extensions';
import { expandTemplates, type TemplateContext } from '../features/template';
import {
  applyBlockProps,
  applyEditorMarker,
  blockEditorDoc,
  editableProps,
  EDITOR_BULLET_RE,
  EDITOR_TASK_RE,
  editorMarkerLen,
  propsShallowEqual,
  splitPropLines,
  syncFrontmatterProps,
  type Block,
} from '../types';

export type CursorPos = number | 'start' | 'end';

/**
 * 活预览的符号可见性(用户指定,2026-10-25,参考 Obsidian 原生编辑器):
 * 符号长度**每帧按文档实测**(内容编辑后符号段不变,但删符号/改符号时
 * 长度变——固定位置会错位)。
 *
 * 一套渲染器(用户指定,2026-10-26):圆点只由**静态 .block-bullet 元素**
 * 绘制——阅读态/编辑态是同一个元素、同一条 CSS,零跳动。光标不在符号区
 * 时编辑器把 `- `[TODO ] 段零宽隐藏(圆点交给控件列里的静态元素);光标
 * 钻进符号区(现形态)时撤掉隐藏让符号以文本现形,同时给 wrap 挂
 * lg-no-symbol(圆点退场+内容拉进圆点列,段落几何)。装饰范围进
 * atomicRanges(光标/方向键整体越过,不落进隐藏段内部)。
 */
/** 文档行首符号段实测长度(无符号返回 0)。 */
function docMarkerLen(view: EditorView): number {
  const line = view.state.doc.lineAt(0);
  const m = EDITOR_BULLET_RE.exec(line.text);
  if (!m) return 0;
  const t = EDITOR_TASK_RE.exec(line.text.slice(m[0].length));
  return m[0].length + (t ? t[0].length : 0);
}

type MarkerState = { mlen: number; raw: boolean };

/** 符号段状态:mlen>0 且光标「钻进」符号区 = 现形(文本态)。 */
const markerState = (view: EditorView, prevHead: number | null, keyboardNav: boolean): MarkerState => {
  const mlen = docMarkerLen(view);
  const head = view.state.selection.main.head;
  // 现形判定(用户指定,2026-10-25):
  //  - 光标**钻进符号内部**(head < mlen)→ 现形;
  //  - 光标用**方向键**从内容左移到符号后(head === mlen 且上一位置 > mlen)
  //    → 现形;
  //  - 鼠标点击符号后 / 新建空块落点 / 打字位 → 圆点保持。
  const raw =
    mlen > 0 && (head < mlen || (head === mlen && prevHead !== null && prevHead > mlen && keyboardNav));
  return { mlen, raw };
};

const markerDecorations = (st: MarkerState): DecorationSet =>
  st.raw || st.mlen <= 0 ? Decoration.none : Decoration.set([Decoration.replace({}).range(0, st.mlen)]);

const liveBulletDecorations = (wrap: HTMLElement | null) => {
  // 方向键导航标记:只有键盘移动进符号区才现形(鼠标点击保持圆点)
  const nav = { keyboardNav: false };
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      prevHead: number | null = null;
      constructor(view: EditorView) {
        const st = markerState(view, null, false);
        this.decorations = markerDecorations(st);
        this.syncChrome(st);
        view.contentDOM.addEventListener('mousedown', () => {
          nav.keyboardNav = false;
        });
      }
      // 圆点退场/回归由 CSS 类驱动(一套渲染器,2026-10-26):现形态或符号
      // 已删(mlen=0,段落几何)→ lg-no-symbol 藏圆点+拉内容进圆点列;
      // 圆点态不加类——静态 .block-bullet 元素就位在控件列里,与阅读态
      // 完全同一套布局。wrap 跨提交存活,提交路径(commitFocusedText /
      // commitViewNow)负责摘类。
      syncChrome(st: MarkerState): void {
        wrap?.classList.toggle('lg-no-symbol', st.mlen === 0 || st.raw);
      }
      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged || u.viewportChanged) {
          const st = markerState(u.view, this.prevHead, nav.keyboardNav);
          this.decorations = markerDecorations(st);
          this.prevHead = u.view.state.selection.main.head;
          nav.keyboardNav = false; // 一次性:只有紧随其后的选择变化算导航
          this.syncChrome(st);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      // 符号段对光标运动是原子的:方向键左右整体越过,不落进被替换的范围
      provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
    },
  );
  // 方向键置导航标记(不消费,CM 照常移动光标)
  const navKeymap = Prec.high(
    keymap.of([
      { key: 'ArrowLeft', run: () => ((nav.keyboardNav = true), false) },
      { key: 'ArrowRight', run: () => ((nav.keyboardNav = true), false) },
    ]),
  );
  // Backspace 在圆点后(打字位)= 删除**整个符号**(含任务标记)→ 变段落
  // (提交时 applyEditorMarker 按无符号文档解析成 bare)。不拦截的话原子
  // 范围挡住删除,用户看到的就是「按了没反应」。
  const backspace = Prec.high(
    keymap.of([
      {
        key: 'Backspace',
        run: (view) => {
          const head = view.state.selection.main.head;
          const dyn = docMarkerLen(view);
          if (dyn <= 0 || head !== dyn) return false;
          if (view.state.selection.main.from !== head) return false;
          view.dispatch({ changes: { from: 0, to: dyn }, selection: { anchor: 0 } });
          return true;
        },
      },
    ]),
  );
  return [plugin, navKeymap, backspace];
};

export function mountFocusedEditor(
  parent: HTMLElement,
  block: Block,
  pos: CursorPos,
  host: BlockRenderHost,
): EditorView {
  const view = new EditorView({
    // Properties ride along as `key:: value` lines under the text (Logseq
    // editor parity); commit splits them back out.
    doc: blockEditorDoc(block),
    parent,
    extensions: [
      ...createEditorExtensions(host, block),
      // 编辑中块的 wrap 元素传给装饰插件:lg-no-symbol 类挂它身上(静态
      // 圆点的隐/现由这条链路驱动)。
      ...(editorMarkerLen(block) > 0 ? liveBulletDecorations(parent.closest('.block-wrap')) : []),
    ],
  });
  // Debug handle for e2e verification (harmless): lets page-context probes
  // reach this editor's CM6 state (doc text, selection) from the DOM node.
  (view.dom as HTMLElement & { __lgView?: EditorView }).__lgView = view;
  // Real Escape keystrokes never reach CM6's keymap inside Obsidian's host
  // DOM (a capture-phase handler marks them handled first, so the keymap
  // dispatch skips the defaultPrevented event). Catch Escape in the CAPTURE
  // phase here and COMMIT synchronously. The completion state can still be
  // "pending" right after typing (the accept pass runs ~75ms later), so gate
  // on nothing: Esc always lands the edit, closing any popup en route.
  // Blurring alone races with Obsidian's focus management (hasFocus may stay
  // true, so the blur-commit path never fires and the edit never lands).
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.repeat) return;
    // IME 组合期间 Esc 是取消候选窗口(思源 keydown.ts 同规,isComposing
    // 不落任何编辑行为)——此时提交会把半截组合文本当正式内容落盘。
    if (e.isComposing || e.keyCode === 229) return;
    // The NATIVE slash-command suggest is showing: Esc belongs to it (hides
    // the popup via its keymap scope) — do not commit the edit.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (window as any).app?.workspace?.editorSuggest;
    if (es?.isShowingSuggestion?.()) return;
    e.preventDefault();
    e.stopPropagation();
    // A VISIBLE popup (active) means the first Esc just closes it — native
    // behavior. 'pending' is the accept-pass tail with no popup on screen
    // and MUST fall through to the commit (gating on it was the bug that
    // made Esc silently drop edits typed right before it).
    if (completionStatus(view.state) === 'active') {
      closeCompletion(view);
      return;
    }
    closeCompletion(view);
    view.contentDOM.blur();
    host.commitViewNow(view, block);
  };
  view.dom.addEventListener('keydown', escHandler, true);
  // The native slash-menu suggest requires the triggering keyboard event.
  view.dom.addEventListener(
    'keydown',
    (e) => {
      (window as unknown as { __lastKeyEvent?: KeyboardEvent }).__lastKeyEvent = e;
    },
    true,
  );
  // 符号进文档后,数值 pos 的语义仍是「文本内偏移」(调用方按无符号文本
  // 计算)——0(文本开头)落在符号之后,其余 +符号长度。
  const mlen = editorMarkerLen(block);
  if (mlen > 0 && typeof pos === 'number') pos = pos > 0 ? pos + mlen : mlen;
  applyCursor(view, pos);
  view.focus();
  // Electron/CDP background windows drop the initial focus; re-assert on
  // the next frames so the editor stays in editing state (Enter parity).
  requestAnimationFrame(() => {
    if (!view.hasFocus) view.focus();
    setTimeout(() => {
      if (!view.hasFocus && view.dom.isConnected) view.focus();
    }, 60);
  });
  return view;
}

export function applyCursor(view: EditorView, pos: CursorPos): void {
  const len = view.state.doc.length;
  let p: number;
  if (pos === 'start') p = 0;
  else if (pos === 'end') p = len;
  else p = Math.max(0, Math.min(pos, len));
  view.dispatch({ selection: { anchor: p } });
}

/**
 * Place the caret AND scroll it into view. After the static→raw-text swap
 * the block's height collapses (rendered images/code become one line each),
 * so a caret placed at the click's mapped position can sit far off-screen
 * (usually above) — the "cursor disappears" effect. 'nearest' scrolls the
 * MINIMUM needed to show the caret (zero when already visible), avoiding a
 * jarring page jump on tall blocks.
 */
export function applyCursorAndScroll(view: EditorView, pos: number): void {
  const p = Math.max(0, Math.min(pos, view.state.doc.length));
  view.dispatch({
    selection: { anchor: p },
    effects: EditorView.scrollIntoView(p, { y: 'nearest' }),
  });
}

/**
 * Map a click coordinate (from the pre-focus static render) onto a CM6
 * position after mount; falls back to `fallback`.
 */
export function cursorAtCoords(view: EditorView, x: number, y: number, fallback: CursorPos): number {
  try {
    const p = view.posAtCoords({ x, y });
    if (p !== null) return Math.max(0, Math.min(p, view.state.doc.length));
  } catch {
    /* coords may be off-view right after mount */
  }
  const len = view.state.doc.length;
  if (fallback === 'start') return 0;
  if (fallback === 'end') return len;
  return Math.min(fallback, len);
}

/** Write the editor doc back into the block model (no rendering here). */
export function commitEditorText(view: EditorView, block: Block, ctx?: TemplateContext): boolean {
  // Logseq behavior: <% today %> etc. expand when the edit is committed, and
  // the trailing `key:: value` lines become block properties.
  const raw = expandTemplates(view.state.doc.toString(), new Date(), ctx);
  // Obsidian-format page properties: the whole doc IS the frontmatter body —
  // no Logseq prop extraction; the raw lines round-trip verbatim and the
  // props map re-syncs from simple `key: value` lines.
  if (block.frontmatter) {
    if (raw === block.text) return false;
    block.text = raw
      .split('\n')
      .map((l) => {
        const m = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.*)$/.exec(l);
        return m ? `${m[1]}: ${m[2]}` : l;
      })
      .join('\n');
    syncFrontmatterProps(block);
    return true;
  }
  const { text, props } = splitPropLines(raw);
  // 符号即文本:行首符号解析进模型(删符号→段落/规范化/任务标记),与
  // keymap 的 Enter/Backspace/Delete 路径共用 applyEditorMarker。
  const marked = applyEditorMarker(block, text, 0);
  const committed = marked.text;
  if (committed === block.text && propsShallowEqual(editableProps(block), props)) return false;
  block.text = committed;
  applyBlockProps(block, props);
  return true;
}

