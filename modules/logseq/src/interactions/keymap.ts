/**
 * Block-level keyboard interaction handlers (Logseq behavior).
 * Each handler receives the CM6 view of the focused block plus the host view;
 * returning true consumes the key (prevents CM6 default), false falls through.
 */

import { insertTab, redo as cmRedo, undo as cmUndo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import type { BlockRenderHost } from '../blocks/renderHost';
import {
  flattenVisible,
  indent,
  linkParents,
  insertAfter,
  insertBefore,
  insertFirstChild,
  listRunOf,
  mergeWithNext,
  mergeWithPrev,
  moveBlockVertically,
  nextVisible,
  outdent,
  prevVisible,
  removeBlock,
  shouldExitListOnEnter,
  splitBlock,
  splitHeadingRaw,
  splitListFollowTail,
  splitRawToOutline,
  toBareParagraph,
} from '../core/treeOps';
import { cycleMarker } from '../core/treeOps';
import { headingLevel } from '../core/fold';
import { parseDocument } from '../core/parser';
import { applyBlockProps, applyEditorMarker, createBlock, splitPropLines, type Block } from '../types';

function focusedBlock(host: BlockRenderHost): Block | null {
  return host.focusedBlock;
}

/** Selection with deleted-range applied: returns resulting text + caret offset. */
function deleteSelection(view: EditorView): { text: string; offset: number } {
  const sel = view.state.selection.main;
  const text = view.state.doc.toString();
  if (sel.empty) return { text, offset: sel.head };
  return { text: text.slice(0, sel.from) + text.slice(sel.to), offset: sel.from };
}

/**
 * 段落容器(bare)行首敲出 `-`/`*`/`+` 后按空格 → 立即转成大纲块。
 * 行首 `#`×1-6 后按空格 → 立即转成标题块(思源输入转换)。
 *
 * 思源/Typora 的即时转换：不等回车，圆点马上出现、样式与原生大纲块一致
 * （此前要等回车才转，转出来的块还残留段落容器的 bare 样式）。
 *
 * 空格本身不消费（照常插入），转换推迟一个宏任务——等 CM 把空格落进文档、
 * 事务收尾后再经 mutate 重建块；在 CM 的按键/更新回调里同步重建编辑器会
 * 炸掉进行中的事务。
 */
export function handleSpace(view: EditorView, host: BlockRenderHost): boolean {
  const b = focusedBlock(host);
  if (!b || b.kind !== 'list' || !b.bare) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const text = view.state.doc.toString();
  const lineStart = text.lastIndexOf('\n', Math.max(0, sel.head - 1)) + 1;
  // 只认块首行行首的单个标记（软行/续行的转换是另一档语义，不在这里做）。
  if (lineStart !== 0) return false;
  // `#`×1-6 + 空格 → 标题(思源 turnIntoList 同款的输入转换层;列表项里
  // 敲 # 是字面文本,列表↔标题走手柄菜单)。
  if (/^#{1,6}$/.test(text.slice(0, sel.head))) {
    setTimeout(() => {
      const now = view.state.doc.toString();
      const m = /^(#{1,6})\s/.exec(now);
      if (!m) return;
      const parent = b.parent;
      host.mutate(
        () => {
          // 标题模型的正文含 `# ` 前缀(与 parseDocument 对齐):kind 换
          // raw,缓冲区原文整体落进 text。
          b.kind = 'raw';
          b.bare = false;
          b.text = now;
        },
        () => ({ lists: [parent] }),
      );
      host.focusBlock(b, m[0].length); // 光标落前缀之后
    }, 0);
    return false; // 空格照常插入
  }
  if (!/^[*+-]$/.test(text.slice(0, sel.head))) return false;
  setTimeout(() => {
    const now = view.state.doc.toString();
    if (!/^[*+-]\s/.test(now)) return;
    const parent = b.parent;
    let pos = Math.min(view.state.selection.main.head, now.length);
    host.mutate(
      () => {
        // 缓冲区 → 模型一并同步（mutate 会重建 wrap，重建读的是模型；
        // 不同步的话刚敲的标记会随重渲染丢掉）。符号即文本:刚敲的 `- `
        // 剥进符号状态(否则重建文档双重符号)。
        const marked = applyEditorMarker(b, now, pos);
        b.text = marked.text;
        pos = marked.offset;
      },
      () => ({ lists: [parent] }),
    );
    host.focusBlock(b, pos);
  }, 0);
  return false; // 空格照常插入
}

/** Enter: split block at caret; tail becomes a new sibling below. */
export function handleEnter(view: EditorView, host: BlockRenderHost): boolean {  const b = focusedBlock(host);
  if (!b) return false;
  // 思源交互:空的列表块(同级末尾)上回车 → 退出列表、转成段落容器。
  // 常见路径是"在有内容的块上回车得到空的列表块,再回车变成段落"——
  // 与思源一致(顶层 listOutdent / 嵌套 breakList,都是同层换容器)。
  // 页面属性块除外:它是文件头的属性容器,回车该往下新建块(同 isPropsBlock)。
  const isPageProps = host.doc.blocks[0] === b && (b.text === '' || b.frontmatter === true);
  if (!isPageProps && shouldExitListOnEnter(b, view.state.doc.toString())) {
    const parent = b.parent;
    // mutate 内部会重渲染(圆点随之消失);焦点块还是它,所以只把光标放回块首。
    host.mutate(() => toBareParagraph(b), () => ({ lists: [parent] }));
    host.focusBlock(b, 0);
    return true;
  }
  if (b.kind === 'raw') {
    const { text, offset } = deleteSelection(view);
    const parent = b.parent;
    // 引述块(用户指定,2026-10-26):非空引述末尾回车 → 新建同级引述块;
    // 内容中间回车 → 拆成两个引述块(Logseq 同款,尾部补 '> ');caret 在
    // '>' 标记上/前 → 上方插空段落块(引述保持原样);空引述回车 → 退出
    // 引述变空段落。此前走 splitRawToOutline 会把引述拆成大纲块,丢失
    // 引述形态。'> ' 是 raw 块文本内嵌标记(位置绝对),库内库外编辑器
    // 同走本分支(fragmentEditor 也挂 createEditorExtensions)。
    if (/^>/.test(text)) {
      if (text.slice(1).trim() === '') {
        // 空引述('> '/'>'/纯空白)回车 → 退出引述:剥掉标记变空段落块
        host.mutate(
          () => {
            b.text = '';
          },
          () => ({ lists: [parent] }),
        );
        host.focusBlock(b, 0);
        return true;
      }
      let qn: Block | null = null;
      let above = false;
      host.mutate(
        () => {
          if (offset > 1) {
            // 末尾(offset===len,tail 空 → 空同级引述)与内容中间(尾部补 '> ')
            const tail = text.slice(offset);
            b.text = text.slice(0, offset);
            qn = createBlock(/^>/.test(tail) ? tail : '> ' + tail);
            qn.kind = 'raw'; // 引述形态必须是 raw(list 序列化会加 '- ' 前缀)
            insertAfter(b, qn);
          } else {
            // caret 在 '>' 上/前:上方插空段落容器,引述原样(Logseq 同款)
            b.text = text;
            qn = createBlock('');
            qn.bare = true;
            insertBefore(b, qn);
            above = true;
          }
        },
        () => ({ lists: [parent] }),
      );
      const target = qn as Block | null;
      if (target) {
        // raw 块无符号前缀换算(mlen=0),位置是文档绝对偏移:新引述的光标
        // 落在标记之后('> '→2,'>'→1),空段落落行首。
        const qpos = above ? 0 : target.text.startsWith('> ') ? 2 : target.text.startsWith('>') ? 1 : 0;
        host.focusBlock(target, qpos);
      }
      return true;
    }
    // Logseq parity: Enter turns the raw block into outline blocks — the head
    // converts to a list block, the tail becomes a new list sibling; edge
    // blank lines and the common indent never survive (splitRawToOutline).
    // Shift+Enter stays the soft newline.
    //
    // 标题块除外(用户指定,2026-10-25 思源交互):标题回车**不转大纲**——
    // splitHeadingRaw:头部保持标题,尾部(光标之后)成为新的段落块(raw,
    // 无圆点),标题末尾回车 = 下方新建空段落。
    // (text/offset 已在引述分支前取好。)
    let nb: Block | null = null;
    host.mutate(
      () => {
        b.text = text;
        nb = headingLevel(b) === 0 ? splitRawToOutline(b, offset) : splitHeadingRaw(b, offset);
      },
      () => ({ lists: [parent] }),
    );
    const target = nb as Block | null;
    if (target) {
      host.focusBlock(target, 0);
    }
    return true;
  }
  const { text, offset } = deleteSelection(view);
  const parent = b.parent;
  let nb: Block | null = null;
  let stay = false; // 光标留在原块(段首回车)时置位
  let fenceConverted = false;
  host.mutate(
    () => {
      // 符号即文本:编辑文档带 `- `[TODO ] 前缀——先解析进模型(剥符号,
      // 同步 bare/任务标记),否则符号会漏进 text(静态多出一个 `-`)。
      const marked = applyEditorMarker(b, text, offset);
      // Trailing `key:: value` lines stay with the head block as properties.
      const { text: clean, props } = splitPropLines(marked.text);
      applyBlockProps(b, props);
      b.text = clean;
      const pos = Math.min(marked.offset, clean.length);
      // ---- 思源容器块交互(用户指令 2026-10-25,protyle enter.ts/listEnter)----
      // 我们模型的 children 同时承载思源的「li 内子块」与「子列表」,以
      // bare 区分:bare 子块=li 内段落子块,非 bare 子块=子列表的项。
      if (b.kind === 'list' && !b.bare) {
        // 有子块的项**末尾**回车 → 新空项成为第一个子项(listEnter:段末
        // 换行在子列表最前插入)。
        if (pos === clean.length && b.children.length > 0) {
          nb = insertFirstChild(b);
          return;
        }
        // 有子块的项**中间**回车 → 尾部成新项,子块跟尾部(思源把子列表
        // 搬进新项)。
        if (pos > 0 && pos < clean.length && b.children.length > 0) {
          nb = splitListFollowTail(b, pos);
          return;
        }
      }
      // 思源 turnIntoCode/codeBlockEnter(2026-10-26):光标停在 ``` 行
      // (围栏标记之后)回车 → 该块转代码块(自动补闭合围栏),光标后文本
      // 成新段落块。限 bare 段落(列表项里 ``` 是字面文本,与 # 同规);
      // 行内还有其他文字(围栏后非行尾)不转换。
      if (b.bare && b.children.length === 0) {
        const headText = clean.slice(0, pos);
        const fence = /(?:^|\n)[ 	]*(`{3,}|~{3,})(\w*)$/.exec(headText);
        if (fence) {
          b.kind = 'raw';
          b.bare = false;
          b.text = headText + '\n' + fence[1];
          const tail = clean.slice(pos);
          if (tail) {
            const tb = createBlock(tail);
            tb.bare = true;
            insertAfter(b, tb);
          }
          nb = b;
          fenceConverted = true;
          return;
        }
      }
      // bare 空子块(li 内空段落)回车 → 删掉空块,在父项之后建新的列表项
      // (思源:空子块再次回车时仍创建后续列表项)。非最后的空子块照旧分裂。
      const parentBlock = b.parent;
      if (
        b.bare && clean === '' && b.children.length === 0 && parentBlock &&
        parentBlock.children[parentBlock.children.length - 1] === b
      ) {
        removeBlock(b);
        nb = createBlock('');
        insertAfter(parentBlock, nb);
        return;
      }
      // **段首**回车(非空)→ 上面插空块,光标留在原块(enter.ts 段首换行
      // 分支:新块 beforebegin,原块光标原位不动)。
      if (pos === 0 && clean.length > 0) {
        nb = createBlock('');
        if (b.bare) nb.bare = true;
        insertBefore(b, nb);
        stay = true;
        return;
      }
      nb = splitBlock(b, pos);
    },
    () => ({ lists: [parent] }),
  );
  // Children stay with the head block (Logseq behavior); caret goes to new block.
  const target = nb as Block | null;
  if (target && fenceConverted) {
    // 思源 turnIntoCode:转换后**立即**进代码编辑器。当前 CM 还开着
    // (快速路径会挡住重挂),摘掉焦点态让 focusBlock 走慢路径经
    // parseCodeFence 挂代码编辑器。旧视图直接销毁(其 DOM 由重挂清掉)。
    host.focusedView?.destroy();
    host.focusedView = null;
    host.focusedBlock = null;
    host.focusBlock(target, 'end');
    return true;
  }
  if (target && !stay) {
    host.focusBlock(target, 0);
  } else if (target && stay) {
    host.focusBlock(b, 0);
  }
  return true;
}

/** Tab / Shift+Tab: indent / outdent the whole block. */
export function handleTab(view: EditorView, host: BlockRenderHost, shift: boolean): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  if (b.kind === 'raw') {
    if (!shift) insertTab(view); // raw content: literal indentation
    return true;
  }
  const offset = view.state.selection.main.head;
  const oldParent = b.parent;
  host.mutate(
    () => {
      if (shift) outdent(b);
      else indent(b);
    },
    // Rebuild both the old and the new sibling list of b.
    () => ({ lists: [oldParent, b.parent] }),
  );
  host.focusBlock(b, Math.min(offset, b.text.length));
  return true;
}

function atFirstVisualLine(view: EditorView): boolean {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  // The block's doc holds soft lines (real newlines): arrows must walk them
  // before exiting to the neighboring block — "first visual line" means the
  // doc's FIRST logical line, and then the caret on its first visual row.
  if (line.from !== 0) return false;
  const headTop = view.coordsAtPos(head)?.top;
  const lineTop = view.coordsAtPos(line.from)?.top;
  if (headTop === undefined || lineTop === undefined) return true;
  return Math.abs(headTop - lineTop) < 2;
}

function atLastVisualLine(view: EditorView): boolean {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  if (line.to !== view.state.doc.length) return false; // more soft lines below
  const headBottom = view.coordsAtPos(head)?.bottom;
  const lineBottom = view.coordsAtPos(line.to)?.bottom;
  if (headBottom === undefined || lineBottom === undefined) return true;
  return Math.abs(headBottom - lineBottom) < 2;
}

/** Arrow keys: cross-block caret movement at block boundaries. */
export function handleArrow(view: EditorView, host: BlockRenderHost, dir: 'up' | 'down' | 'left' | 'right'): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  const roots = host.visibleRoots;
  const sel = view.state.selection.main;
  const textLen = view.state.doc.length;

  if (dir === 'up') {
    if (b.kind === 'raw' && !atFirstVisualLine(view)) return false;
    if (!atFirstVisualLine(view)) return false;
    const prev = prevVisible(roots, b);
    if (!prev) return true; // consume: nothing above
    // 思源 verticalCaret goalX(2026-10-26):跨块上移保持目标 X 列
    const goalX = view.coordsAtPos(sel.head)?.left ?? null;
    host.focusBlock(prev, 'end');
    if (goalX !== null) caretAtGoalX(host, goalX, true);
    return true;
  }
  if (dir === 'down') {
    if (!atLastVisualLine(view)) return false;
    const next = nextVisible(roots, b);
    if (!next) return true;
    const goalX = view.coordsAtPos(sel.head)?.left ?? null;
    host.focusBlock(next, 0);
    if (goalX !== null) caretAtGoalX(host, goalX, false);
    return true;
  }
  if (dir === 'left') {
    if (!sel.empty || sel.head !== 0) return false;
    const prev = prevVisible(roots, b);
    if (!prev) return true;
    host.focusBlock(prev, 'end');
    scrollCaretIntoViewSoon(host);
    return true;
  }
  // right
  if (!sel.empty || sel.head !== textLen) return false;
  const next = nextVisible(roots, b);
  if (!next) return true;
  host.focusBlock(next, 0);
  scrollCaretIntoViewSoon(host);
  return true;
}

/** Mod+Home/End: jump to the first/last visible block(思源文档级 goHome/goEnd). */
export function handleDocJump(_view: EditorView, host: BlockRenderHost, end: boolean): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  const flat = flattenVisible(host.visibleRoots);
  if (!flat.length) return false;
  host.focusBlock(end ? flat[flat.length - 1] : flat[0], end ? 'end' : 0);
  return true;
}

/** 跨块移动后光标滚入视口(思源 caretScroll 的覆盖面:CM 只滚块内,
 *  focusBlock 重挂后的光标可能留在屏外——下一帧按 nearest 滚最小量)。 */
function scrollCaretIntoViewSoon(host: BlockRenderHost): void {
  requestAnimationFrame(() => {
    const v = host.focusedView;
    if (!v || !v.dom.isConnected) return;
    v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: 'nearest' }) });
  });
}

/** 思源 verticalCaret 的 goalX(2026-10-26):块间上/下移后,把光标放到
 *  目标块末行/首行上与 goalX(出发列的视口 X)最近的文本位。CM 挂载同步,
 *  坐标下一帧量;块已不在(被提交/换块)就放弃。 */
function caretAtGoalX(host: BlockRenderHost, goalX: number, atEnd: boolean): void {
  requestAnimationFrame(() => {
    const v = host.focusedView;
    if (!v || !v.dom.isConnected) return;
    const len = v.state.doc.length;
    const c = v.coordsAtPos(atEnd ? len : 0);
    if (!c) return;
    const y = (c.top + c.bottom) / 2;
    const p = v.posAtCoords({ x: goalX, y });
    if (p == null) return;
    v.dispatch({
      selection: { anchor: Math.max(0, Math.min(p, len)) },
      effects: EditorView.scrollIntoView(Math.max(0, Math.min(p, len)), { y: 'nearest' }),
    });
  });
}

/**
 * 思源粘贴决策树的多行分支(2026-10-26):多行文本进块模型——当前块在
 * 光标处切开,粘贴文本经 parseDocument 解析成块序列插进中间(结构自带:
 * 列表/缩进/围栏),光标后的尾部文本留在原容器的延续块里,光标落末尾。
 * 单行粘贴不进这里(CM 默认纯文本插入)。
 */
export function handlePaste(view: EditorView, host: BlockRenderHost, event: ClipboardEvent, text: string): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  event.stopPropagation(); // 我们完全接管多行粘贴,气泡不再惊动应用层处理器
  deleteSelection(view); // 选区先删(粘贴语义)
  const docText = view.state.doc.toString();
  const head = view.state.selection.main.head;
  const parent = b.parent;
  let last: Block | null = null;
  host.mutate(
    () => {
      const marked = applyEditorMarker(b, docText, head);
      const { text: clean, props } = splitPropLines(marked.text);
      applyBlockProps(b, props);
      const pos = Math.min(marked.offset, clean.length);
      const tailText = clean.slice(pos);
      b.text = clean.slice(0, pos);
      const pasted = parseDocument(text).blocks;
      linkParents(pasted);
      let anchor: Block = b;
      for (const pb of pasted) {
        insertAfter(anchor, pb);
        anchor = pb;
      }
      if (tailText.length > 0 || pasted.length === 0) {
        const tb = createBlock(tailText);
        if (b.bare) tb.bare = true;
        insertAfter(anchor, tb);
        anchor = tb;
      }
      last = anchor;
    },
    () => ({ lists: [parent] }),
  );
  host.focusBlock(last ?? b, 'end');
  return true;
}

/** Backspace at position 0: merge into previous visible block. */
export function handleBackspace(view: EditorView, host: BlockRenderHost): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  if (sel.head !== 0) return false;
  // ---- 思源容器块退格(用户指令 2026-10-25,protyle remove.ts 的 removeLi)----
  if (b.kind === 'list' && !b.bare) {
    // 「同列表兄弟」按连续非 bare 列表段算(listRunOf),不是整个兄弟
    // 数组——段落与列表混排时它们不是同一个列表。
    const run = listRunOf(b);
    // 唯一列表项 → 拆壳变段落(listOutdent 的唯一项路径:列表拆除,内容
    // 变普通块;此前这里会错误地合进列表外的上一块)。符号即文本:剥符号
    // 进模型并置 bare——无论文档里符号删没删(块首可能在 `- ` 之前)。
    if (run.length === 1) {
      const parent = b.parent;
      host.mutate(
        () => {
          const marked = applyEditorMarker(b, view.state.doc.toString(), 0);
          b.text = marked.text;
          b.bare = true;
          b.marker = null;
        },
        () => ({ lists: [parent] }),
      );
      host.focusBlock(b, 0);
      return true;
    }
    // 顶级列表**首项**(有兄弟)→ no-op(remove.ts:顶层列表首项退格无动作,
    // 嵌套首项才向前合并)。
    if (b.parent === null && run[0] === b) {
      return true;
    }
  }
  // Raw blocks merge too (Logseq: Backspace at a block's start joins the
  // previous block — the old raw guard made e.g. a table's first line an
  // undeletable dead end).
  const roots = host.visibleRoots;
  const prev = prevVisible(roots, b);
  if (!prev) return true; // first block: consume, nothing to merge
  const joinOffset = prev.text.length;
  const { text } = deleteSelection(view); // no-op (empty selection)
  void text;
  const parent = b.parent;
  host.mutate(
    () => {
      // 符号即文本:合并前进模型先剥符号(否则 `- ` 漏进 text)
      b.text = applyEditorMarker(b, view.state.doc.toString(), 0).text;
      mergeWithPrev(roots, b);
    },
    () => ({ lists: [parent] }),
  );
  host.focusBlock(prev, Math.min(joinOffset, prev.text.length));
  return true;
}

/**
 * Delete (forward) at block end: merge the NEXT visible block into this one
 * (Logseq parity). On an empty block this removes the empty row — the next
 * block's content fills it and the row disappears.
 */
export function handleDelete(view: EditorView, host: BlockRenderHost): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const text = view.state.doc.toString();
  if (sel.head !== text.length) return false;
  const roots = host.visibleRoots;
  const next = nextVisible(roots, b);
  if (!next) return true; // last block: consume, nothing to merge
  const joinOffset = text.length;
  const parent = b.parent;
  const nextParent = next.parent;
  host.mutate(
    () => {
      // 符号即文本:合并前进模型先剥符号(否则 `- ` 漏进 text)
      b.text = applyEditorMarker(b, text, 0).text;
      mergeWithNext(roots, b);
    },
    // The merge may pull a block from a different sibling list — patch both.
    () => ({ lists: [parent, nextParent] }),
  );
  host.focusBlock(b, joinOffset);
  return true;
}

/** Ctrl/Cmd+Enter: cycle TODO 鈫?DOING 鈫?DONE 鈫?none. */
export function handleCycleMarker(view: EditorView, host: BlockRenderHost): boolean {
  const b = focusedBlock(host);
  if (!b || b.kind === 'raw') return false;
  const offset = view.state.selection.main.head;
  const text = view.state.doc.toString();
  host.mutate(
    () => {
      b.text = text;
      cycleMarker(b);
    },
    () => ({ subtree: b }),
  );
  host.focusBlock(b, Math.min(offset, b.text.length));
  return true;
}

/** Ctrl/Cmd+Shift+ArrowUp/Down: move block up/down. */
export function handleMoveBlock(view: EditorView, host: BlockRenderHost, dir: -1 | 1): boolean {
  const b = focusedBlock(host);
  if (!b || b.kind === 'raw') return false;
  const offset = view.state.selection.main.head;
  const text = view.state.doc.toString();
  const roots = host.visibleRoots;
  let ok = false;
  host.mutate(
    () => {
      b.text = text;
      ok = moveBlockVertically(roots, b, dir);
    },
    // Nothing moved 鈫?nothing to re-render.
    () => (ok ? { lists: [b.parent] } : {}),
  );
  if (ok) host.focusBlock(b, Math.min(offset, b.text.length));
  return true;
}

/** Alt+ArrowUp/Down: jump to the previous/next block regardless of caret line. */
export function handleJumpBlock(view: EditorView, host: BlockRenderHost, dir: -1 | 1): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  void view; // caret position intentionally ignored
  const roots = host.visibleRoots;
  const target = dir === -1 ? prevVisible(roots, b) : nextVisible(roots, b);
  if (!target) return true; // consume at document edges
  host.focusBlock(target, dir === -1 ? 'end' : 0);
  return true;
}

/**
 * Typing a markdown/bracket opener with a selection wraps the selection
 * (Obsidian behavior) instead of typing over it: `*` → `*sel*`, `[` →
 * `[sel]`, etc. The wrapped text stays selected so repeating the key chains
 * formatting (`*` twice → `**sel**` bold, `[` twice → `[[sel]]` wikilink).
 * An empty selection falls through to the plain insert.
 */
export function handleWrapChar(view: EditorView, host: BlockRenderHost, open: string, close: string): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const inner = view.state.doc.sliceString(sel.from, sel.to);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: open + inner + close },
    selection: { anchor: sel.from + open.length, head: sel.to + open.length },
  });
  return true;
}

/** Backtick = inline code. Kept as the named entry point for the keymap/test. */
export function handleBacktick(view: EditorView, host: BlockRenderHost): boolean {
  return handleWrapChar(view, host, '`', '`');
}

/**
 * Mod+Z（混合撤销链，2026-10-26 用户报「ctrl z 不能撤销」）：先走 CM 文本
 * history；耗尽后落全局 UndoStack——选中态删除/插块后进入编辑、编辑中 Tab
 * 缩进等 mutate 操作的撤销此前在编辑态不可达（Ctrl+Z 被 CM history 吃掉而
 * 它是空的）。兜底先提交当前文本（快照入栈）再全局回退，撤销链跨态连续。
 */
export function handleUndo(view: EditorView, host: BlockRenderHost): boolean {
  if (cmUndo(view)) return true;
  return host.undoBeyondText?.() ?? false;
}

/** Mod+Y / Mod+Shift+Z 的全局兜底（同 handleUndo 的链路，方向相反）。 */
export function handleRedo(view: EditorView, host: BlockRenderHost): boolean {
  if (cmRedo(view)) return true;
  return host.redoBeyondText?.() ?? false;
}

/**
 * Escape（思源 keydown.ts:1905 链的我们版，2026-10-26）：提交编辑 →
 * 进入块选择模式（思源「兜底块选中」：锚点=刚提交的块，不标记）。
 * 再按一次 Esc 在树焦点态清锚点完全退出（BlockEditorView 全局分支）。
 * IME 守卫：组合期间 Esc 是取消候选（思源同规），吞掉不做任何事。
 */
export function handleEscape(view: EditorView, host: BlockRenderHost): boolean {
  if (view.composing) return true;
  const b = host.focusedBlock;
  view.contentDOM.blur();
  if (b && host.enterBlockSelection) {
    // 等 blur→提交→重渲染收尾，下一帧挂锚点（思源 insertEmptyBlock 同款延迟）。
    requestAnimationFrame(() => host.enterBlockSelection?.(b));
  }
  return true;
}

