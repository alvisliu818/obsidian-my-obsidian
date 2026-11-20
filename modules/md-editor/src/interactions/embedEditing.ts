/**
 * 嵌入子树的就地编辑(interactions/embedEditing.ts,2026-11-21 自
 * BlockEditorView 拆出):startEmbedEdit 挂 CM6 编辑器、commitEmbedEdit* 家族
 * 落盘/重排、handleEmbedTab/Merge 跨块导航。全部函数以 view 为首参——
 * 状态(embedEdit 字段)仍住在 view 上,本模块只收口行为;view 的
 * treeEl/undo/serializeCurrent/markDirty 等成员为此改为公开(@internal)。
 */
import { TFile } from 'obsidian';
import { expandTemplates } from '../features/template';
import type { Block } from '../types';
import { clearActiveBlockEditor, syncActiveBlockEditor } from '../interactions/textSelectionMenu';
import { EditorView } from '@codemirror/view';
import { App } from 'obsidian';
import { UndoStack } from '../state/undoStack';
import type { TemplateContext } from '../features/template';

/** 就地编辑会话(挂在 host.embedEdit 上)。 */
export interface EmbedEditSession {
	view: EditorView;
	source: EmbedSource;
	path: number[];
	row: HTMLElement;
	escHandler: (e: KeyboardEvent) => void;
}

/** BlockEditorView.MutatePatch 的结构复制(避免循环类型导入)。 */
interface MutatePatchShape {
	lists?: (Block | null)[];
	subtree?: Block;
	full?: boolean;
}

/**
 * 嵌入编辑函数族的首参形状:BlockEditorView 结构性满足(成员公开面为此
 * 放宽);fragmentEditor 等未来消费方也按此实现即可。
 */
export interface EmbedEditHost extends BlockRenderHost {
	app: App;
	file: TFile | null;
	doc: ParsedDocument;
	embedEdit: EmbedEditSession | null;
	treeEl: HTMLElement;
	undo: UndoStack;
	focusStartSnapshot: string;
	templateContext(): TemplateContext;
	serializeCurrent(): string;
	markDirty(): void;
	commitFocusedText(): void;
	clearSelection(): void;
	mutate(fn: () => void, patch?: () => MutatePatchShape): void;
}

import type { BlockRenderHost } from '../blocks/renderHost';
import type { CursorPos } from '../editor/focusEditor';
import { applyBlockProps, blockEditorDoc, blockId, createBlock, editableProps, propsShallowEqual, splitPropLines, type ParsedDocument } from '../types';
import { blockAtPath, findBlockById, linkParents, indent, mergeWithNext, mergeWithPrev, nextVisible, outdent, prevVisible, pseudoRootOf, registerRoots, unregisterRoots } from '../core/treeOps';
import { serializeDocument } from '../core/serializer';
import { refreshBlockContent } from '../blocks/renderTree';
import { applyCursor } from '../editor/focusEditor';
import { mutatePageEmbedSource, refreshEmbedBox, refreshPageEmbedBox, renderEmbedBodyFrom, rerenderEmbedRow, getEmbedRowSource, findEmbedBox, findEmbedRow, findEmbedRowByKey, findEmbedRowForBlock, type EmbedSource } from '../features/links';
import { createEmbedExtensions } from '../editor/extensions';
import { VIEW_TYPE_BLOCK_EDITOR } from '../view/BlockEditorView';

/**
 * Edit a block of an embedded sub-tree right inside its row — only the
 * clicked row swaps to a CM6 editor, the rest of the embed stays visible.
 * `path` is the child-index path from the embedded root (`[]` = the root).
 * Works for blocks of view file and of any other file (see writeEmbedText).
   * `cursor` positions the caret after mount ('end' default; a number is the
   * merge seam offset used by Backspace/Delete block merges).
   */
export function startEmbedEdit(view: EmbedEditHost, row: HTMLElement, source: EmbedSource, path: number[] = [], cursor?: CursorPos): void {
    // 提交会把被编辑行整行重渲（含它的子孙行），而且是**异步**的（写盘/写模型
    // 之后才 rerenderEmbedRow）。所以目标行若落在正在编辑行的子树里，同步挂上
    // 的编辑器会随那次重渲被换成新 DOM —— 视觉上就是“点了子行/空行打不开”。
    // 有前序会话时先等提交落地，再按 (box, path) 重新解析行元素。
    // box 必须在提交之前取：文本没变时提交是同步完成的（无 await），
    // rerenderEmbedRow 会当场把整行（含子孙）换掉——之后 row 已脱离文档，
    // closest('.block-embed') 只会拿到 null（实测：点编辑态行的空子行时
    // 编辑器挂进 detached 节点，视觉上“点不开”）。
    const box = row.closest('.block-embed') as HTMLElement | null;
    const pending = view.embedEdit ? commitEmbedEdit(view) : null;
    view.commitFocusedText(); // ...and any outline edit
    view.clearSelection();
    const mount = (): void => {
      let live = row;
      const fresh = box ? findEmbedRow(box, path) : null;
      if (fresh) live = fresh;
      // 重渲后 path 已不存在（块被删/结构变了）或行已脱离文档：放弃，
      // 绝不把编辑器挂进 detached 节点。
      else if (!live.isConnected) return;
      // 期间若已有新会话开起来（连点、或合并/tab 的重开），别抢。
      if (view.embedEdit) return;
      mountEmbedEdit(view, live, source, path, cursor);
    };
    if (pending) void pending.then(mount);
    else mount();
  }

  /** 在给定行上挂 CM6 就地编辑器（startEmbedEdit 的落地步骤）。 */
function mountEmbedEdit(self: BlockRenderHost & EmbedEditHost,
    row: HTMLElement,
    source: EmbedSource,
    path: number[],
    cursor?: CursorPos,
  ): void {
    const content = row.querySelector(':scope > .embed-main > .embed-content') as HTMLElement | null;
    if (!content) return;
    const target = blockAtPath(source.block, path) ?? source.block;
    row.classList.add('is-editing');
    row.closest('.block-embed')?.classList.add('is-editing'); // e.g. lift max-height
    content.empty();
    const view = new EditorView({
      doc: blockEditorDoc(target),
      parent: content,
      extensions: createEmbedExtensions(
        self,
        () => commitEmbedEdit(self),
        () => commitEmbedEditAndNew(self, source, path),
        (shift) => handleEmbedTab(self, shift),
        (forward) => handleEmbedMerge(self, forward),
      ),
    });
    applyCursor(view, cursor ?? 'end');
    view.focus();
    syncActiveBlockEditor(self.app, self, view);
    // Real Escape keystrokes never reach CM6's keymap: CM6's capture-phase
    // keydown handler marks keyCode 27 as handled (tabFocusMode bookkeeping)
    // and the bubbling keymap dispatch then skips the defaultPrevented
    // event. Catch Escape here in the CAPTURE phase on the editor DOM —
    // capture listeners run before CM6's own capture handler regardless of
    // registration order, and preventDefault/stopPropagation here keeps the
    // event out of the outline's global handlers too.
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      void commitEmbedEdit(self);
    };
    self.embedEdit = { view, source, path, row, escHandler };
    view.dom.addEventListener('keydown', escHandler, true);
  }

  /**
   * Commit the current embed edit, then create a NEW EMPTY BLOCK in the
   * SOURCE page, directly below the block that was being edited (Logseq md
   * parity: Enter below a block continues writing in the page the block
   * lives in — for embeds that is the embedded source, not the host).
   *
   * Same-file embeds: insert via the model (undo/patch). Cross-file embeds
   * and page-embed rows: patch the source file on disk (guarded write), then
   * refresh the open views / the embed box itself.
   */
export function commitEmbedEditAndNew(view: EmbedEditHost, src: EmbedSource, path: number[]): void {
    // Capture the edited row BEFORE committing (commit clears embedEdit);
    // used to locate the embed box that owns view edit.
    const editRow = view.embedEdit?.row ?? null;
    // Awaited: the commit's text write must land BEFORE the insert below
    // re-parses/re-serializes the same source (disk mode race).
    void commitEmbedEdit(view).then(() => {
      commitEmbedEditAndNewInner(view, src, path, editRow);
    });
  }

  /**
   * Tab / Shift+Tab inside an in-place embed edit: indent/outdent the edited
   * block in its source tree, then re-open the edit on it (Logseq parity).
   */
export function handleEmbedTab(view: EmbedEditHost, shift: boolean): boolean {
    const src = view.embedEdit?.source ?? null;
    const path = view.embedEdit?.path ?? null;
    const editRow = view.embedEdit?.row ?? null;
    if (!src || !path || !editRow) return false;
    void commitEmbedEdit(view)
      .then(() => {
        commitEmbedEditTabInner(view, src, path, editRow, shift);
      })
      .catch((e) => console.warn('[logseq] embed tab chain failed:', String(e)));
    return true;
  }

function commitEmbedEditTabInner(view: EmbedEditHost,src: EmbedSource, path: number[], editRow: HTMLElement | null, shift: boolean): void {
    const isPageEmbed = src.id === '';
    const isLocal = !src.file || src.file.path === view.file?.path;
    const box = isPageEmbed
      ? ((editRow?.closest('.block-embed.block-page-embed') as HTMLElement | null) ??
         (view.treeEl.querySelector('.block-embed.block-page-embed') as HTMLElement | null))
      : findEmbedBox(view, src.id);
    if (!box) return;
    const target = blockAtPath(src.block, path) ?? src.block;

    const indentViaView = (view: EmbedEditHost): boolean => {
      const addrRoot = isPageEmbed ? pseudoRootOf(view.doc.blocks) : findBlockById(view.doc.blocks, src.id);
      const t = addrRoot ? (blockAtPath(addrRoot, path) ?? (path.length === 0 ? addrRoot : null)) : null;
      if (!t) return false;
      const oldParent = t.parent;
      view.mutate(() => (shift ? outdent(t) : indent(t)), () => ({ lists: [oldParent, t.parent] }));
      return true;
    };

    // After the box re-renders, re-open the in-place editor on the indented
    // block (matched against embed rows by block identity — same-file model
    // objects survive the re-render).
    const editIndentedWhenReady = (): void => {
      const t0 = Date.now();
      const tryFind = (): void => {
        const hit = findEmbedRowForBlock(box, target);
        if (hit) {
          startEmbedEdit(view, hit.row, hit.src, hit.path);
          return;
        }
        if (Date.now() - t0 < 4000) window.setTimeout(tryFind, 60);
      };
      tryFind();
    };

    if (isLocal) {
      if (!indentViaView(view)) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(view, box, src.file!).then(() => editIndentedWhenReady());
      } else {
        const fresh = findBlockById(view.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, view);
        editIndentedWhenReady();
      }
      return;
    }

    const other = src.file ? findOpenBlockEditor(view, src.file.path) : null;
    if (other) {
      if (!indentViaView(other)) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(view, box, src.file!).then(() => editIndentedWhenReady());
      } else {
        const fresh = findBlockById(other.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, view);
        // 源视图重渲染后同样要把编辑器开回去(Tab = 缩进后继续编辑,不失焦)。
        editIndentedWhenReady();
      }
      return;
    }

    // Nobody has the source open: patch the file on disk (guarded write).
    void mutatePageEmbedSource(view, src.file!, (doc) => {
      const root = src.id ? findBlockById(doc.blocks, src.id) : pseudoRootOf(doc.blocks);
      // 重解析的 doc 没有注册 root,顶层块 parent=null —— indent/outdent 的
      // 兄弟查找(siblingsOf)落空会**静默失败**(返回 false,结构不变),表现为
      // Tab 后既没缩进、编辑器也重开失败(焦点丢失)。以 addr root 为顶重连
      // 父子指针,兄弟查找才有落点。
      if (root) linkParents([root]);
      const t = root ? blockAtPath(root, path) : null;
      if (t) (shift ? outdent(t) : indent(t));
    }).then(() => {
      // 磁盘模式:写入 + 重渲染完成后把编辑器开回缩进后的那一行。
      // 必须等重渲染 resolve 后再找行:refresh 是异步的(cachedRead 之后才
      // box.empty() 重建行),若立即轮询,第一次 tryFind 会命中重渲染前的
      // 旧行(旧对象身份快路径立即匹配成功),把编辑器开在旧行上,随后
      // box.empty() 把它连同编辑器一起拆掉 —— Tab 后编辑器闪现即失焦。
      // (与 commitEmbedEditAndNewInner 磁盘分支同一等待模式。)
      const refreshed = isPageEmbed
        ? refreshPageEmbedBox(view, box, src.file!)
        : refreshEmbedBox(view, box, src.id);
      void refreshed.then(() => editIndentedWhenReady());
    });
  }

  /**
   * Backspace（行首）/ Delete（行尾）在嵌入就地编辑里的块合并 —— 与主编辑器
   * blockMerge 组同语义：当前行合并进上一个可见块 / 下一个并入当前（空行即
   * 删除）。合并后把编辑器开回合并行、光标落在接缝点。
   *
   * 三态写入与 Tab 同构：同文件走模型（undo/patch）；源文件在别的块编辑器
   * 视图里开着就走那个视图；都没开则磁盘补丁（guarded write）。嵌入首/末行
   * 没有可合并对象时静默消费（主编辑器同行为——嵌入是一个独立作用域，
   * 不能把宿主笔记的块拖进来）。
   */
export function handleEmbedMerge(view: EmbedEditHost, forward: boolean): boolean {
    const src = view.embedEdit?.source ?? null;
    const path = view.embedEdit?.path ?? null;
    const editRow = view.embedEdit?.row ?? null;
    if (!src || !path || !editRow) return false;
    void commitEmbedEdit(view)
      .then(() => commitEmbedEditMergeInner(view, src, path, editRow, forward))
      .catch((e) => console.warn('[logseq] embed merge chain failed:', String(e)));
    return true;
  }

async function commitEmbedEditMergeInner(view: EmbedEditHost,
    src: EmbedSource,
    path: number[],
    editRow: HTMLElement | null,
    forward: boolean,
  ): Promise<void> {
    const isPageEmbed = src.id === '';
    const box = isPageEmbed
      ? ((editRow?.closest('.block-embed.block-page-embed') as HTMLElement | null) ??
         (view.treeEl.querySelector('.block-embed.block-page-embed') as HTMLElement | null))
      : findEmbedBox(view, src.id);
    if (!box) return;

    /**
     * 在指定视图的模型里按 path 重寻址目标块，并给出该视图里的合并作用域
     * （页嵌入 = 页面顶层块；块嵌入 = 嵌入根本子树）。src.block 可能来自
     * 磁盘解析的副本（页嵌入初渲、跨文件嵌入），不能直接在它上面改。
     */
    const addressIn = (view: EmbedEditHost): { scope: Block[]; target: Block } | null => {
      const addrRoot = isPageEmbed ? pseudoRootOf(view.doc.blocks) : findBlockById(view.doc.blocks, src.id);
      if (!addrRoot) return null;
      const t = blockAtPath(addrRoot, path) ?? (path.length === 0 ? addrRoot : null);
      if (!t) return null;
      return { scope: isPageEmbed ? view.doc.blocks : [addrRoot], target: t };
    };

    // 合并对象与接缝光标从「行渲染所依据的树」上算：页嵌入的 src.block 可能
    // 是磁盘解析副本，但行的 path 就是以它为基准登记的；跨文件嵌入时宿主
    // 模型里根本没有这些块，绝不能拿 addressIn(view) 预览。
    const scopeRoots = isPageEmbed ? src.block.children : [src.block];
    const rowTarget = blockAtPath(src.block, path) ?? src.block;
    const rowNeighbor = forward
      ? nextVisible(scopeRoots, rowTarget)
      : prevVisible(scopeRoots, rowTarget);
    if (!rowNeighbor) return; // 嵌入首/末行：无可合并对象，消费
    // Backspace：接缝在对方原文本末尾；Delete：接缝在当前文本末尾（光标原位）
    const joinOffset = forward ? rowTarget.text.length : rowNeighbor.text.length;

    /** 在视图模型里执行合并，返回合并后的块（Backspace=prev，Delete=target） */
    const mergeViaView = (view: EmbedEditHost): Block | null => {
      const addr = addressIn(view);
      if (!addr) return null;
      const { scope, target } = addr;
      const bParent = target.parent;
      const neighbor = forward ? nextVisible(scope, target) : prevVisible(scope, target);
      if (!neighbor) return null;
      const nParent = neighbor.parent;
      let merged: Block | null = null;
      view.mutate(
        () => {
          merged = forward ? mergeWithNext(scope, target) : mergeWithPrev(scope, target);
        },
        // 合并可能跨兄弟数组（prev 与 b 不同父）；两边的列表都要补丁
        () => ({ lists: [bParent, nParent] }),
      );
      return merged;
    };

    /** 合并后把编辑器开回合并行（接缝光标）；行是异步重建的，轮询等待 */
    const reopenWhenReady = (merged: Block): void => {
      const t0 = Date.now();
      const tryFind = (): void => {
        const hit = findEmbedRowForBlock(box, merged);
        if (hit) {
          startEmbedEdit(view, hit.row, hit.src, hit.path, joinOffset);
          return;
        }
        if (Date.now() - t0 < 4000) window.setTimeout(tryFind, 60);
      };
      tryFind();
    };

    const isLocal = !src.file || src.file.path === view.file?.path;
    if (isLocal) {
      const merged = mergeViaView(view);
      if (!merged) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(view, box, src.file!).then(() => reopenWhenReady(merged));
      } else {
        const fresh = findBlockById(view.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, view);
        reopenWhenReady(merged);
      }
      return;
    }

    const other = src.file ? findOpenBlockEditor(view, src.file.path) : null;
    if (other) {
      const merged = mergeViaView(other);
      if (!merged) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(view, box, src.file!).then(() => reopenWhenReady(merged));
      } else {
        const fresh = findBlockById(other.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, view);
        reopenWhenReady(merged);
      }
      return;
    }

    // Nobody has the source open: patch the file on disk (guarded write).
    // 重新解析的 doc 没有注册 root——页嵌入作用域（doc.blocks）里的顶层块
    // 会因 siblingsOf 落空而被 removeBlock **静默漏删**（序列化回去行还在），
    // 所以页嵌入分支临时注册/注销 roots。（块嵌入的目标必在嵌入根子树内、
    // 有父指针，不受影响。）
    let mergedKey: string | null = null;
    const ok = await mutatePageEmbedSource(view, src.file!, (doc) => {
      const root = src.id ? findBlockById(doc.blocks, src.id) : pseudoRootOf(doc.blocks);
      if (!root) return;
      linkParents([root]);
      const t = blockAtPath(root, path) ?? (path.length === 0 ? root : null);
      if (!t) return;
      const scope = isPageEmbed ? doc.blocks : [root];
      const neighbor = forward ? nextVisible(scope, t) : prevVisible(scope, t);
      if (!neighbor) return;
      if (isPageEmbed) registerRoots(doc.blocks);
      try {
        const merged = forward ? mergeWithNext(scope, t) : mergeWithPrev(scope, t);
        if (merged) mergedKey = blockId(merged) || merged.text;
      } finally {
        if (isPageEmbed) unregisterRoots(doc.blocks);
      }
    });
    if (!ok || !mergedKey) return;
    // 磁盘模式：合并行对象来自重解析的 doc（盒重渲染后全是新对象），按稳定
    // key 找行；必须等重渲染 resolve 后再找（同 Tab 磁盘分支的等待模式）。
    const key = mergedKey;
    const refreshed = isPageEmbed
      ? refreshPageEmbedBox(view, box, src.file!)
      : refreshEmbedBox(view, box, src.id);
    void refreshed.then(() => {
      const t0 = Date.now();
      const tryFind = (): void => {
        const hit = findEmbedRowByKey(box, key);
        if (hit) {
          startEmbedEdit(view, hit.row, hit.src, hit.path, joinOffset);
          return;
        }
        if (Date.now() - t0 < 4000) window.setTimeout(tryFind, 60);
      };
      tryFind();
    });
  }

function commitEmbedEditAndNewInner(view: EmbedEditHost,src: EmbedSource, path: number[], editRow: HTMLElement | null): void {
    const isPageEmbed = src.id === '';
    const isLocal = !src.file || src.file.path === view.file?.path;
    const box = isPageEmbed
      ? ((editRow?.closest('.block-embed.block-page-embed') as HTMLElement | null) ??
         (view.treeEl.querySelector('.block-embed.block-page-embed') as HTMLElement | null))
      : findEmbedBox(view, src.id);
    if (!box) return;

    /**
     * Where a "new block below the addressed row" lands. Root rows of block
     * embeds grow a LAST CHILD (the new block stays inside the embed and can
     * be focused there — Logseq embed-scope parity); every other row takes a
     * sibling below. A page-embed root row (`[]`) appends to the page's top
     * level (its "rows" ARE the page's top-level blocks).
     *
     * `newPath` is expressed in the SAME address space as `path` — block-
     * relative — so it can be matched against embed rows after a re-render.
     */
    const planInsert = (
      docBlocks: Block[],
      addrRoot: Block | null,
    ): { list: Block[]; index: number; parent: Block | null; newPath: number[] } | null => {
      const t = addrRoot ? (blockAtPath(addrRoot, path) ?? addrRoot) : null;
      if (!t) return null;
      if (path.length === 0) {
        if (isPageEmbed) return { list: docBlocks, index: docBlocks.length, parent: null, newPath: [docBlocks.length] };
        return { list: t.children, index: t.children.length, parent: t, newPath: [t.children.length] };
      }
      const sibs = t.parent ? t.parent.children : docBlocks;
      const idx = sibs.indexOf(t);
      if (idx < 0) return null;
      return { list: sibs, index: idx + 1, parent: t.parent ?? null, newPath: [...path.slice(0, -1), idx + 1] };
    };

    /**
     * After the box re-renders, the new empty row exists in the DOM but the
     * re-render is async (markdown resolves on micro/next tasks), so the
     * row-path registry may lag one tick. Poll briefly, then start the
     * in-place editor on the row.
     */
    const editNewRowWhenReady = (np: number[]): void => {
      const t0 = Date.now();
      const tryFind = (): void => {
        const row = findEmbedRow(box, np);
        if (row) {
          const liveSrc = getEmbedRowSource(row);
          if (liveSrc) startEmbedEdit(view, row, liveSrc, np);
          return;
        }
        if (Date.now() - t0 < 4000) window.setTimeout(tryFind, 60);
      };
      tryFind();
    };

    // ---- 1) Insert the new empty block into the source ----
    // ---- 2) Refresh the embed box -------------------------
    // ---- 3) In-place edit the new row ---------------------
    const insertViaView = (view: EmbedEditHost): number[] | null => {
      const addrRoot = isPageEmbed ? pseudoRootOf(view.doc.blocks) : findBlockById(view.doc.blocks, src.id);
      const plan = planInsert(view.doc.blocks, addrRoot);
      if (!plan) return null;
      const nb = createBlock('');
      view.mutate(() => {
        plan.list.splice(plan.index, 0, nb);
        nb.parent = plan.parent;
      });
      return plan.newPath;
    };

    if (isLocal && !isPageEmbed) {
      // Same-file block embed: model insert in THIS view, then re-render the
      // box from the live model (fresher than disk during the save debounce).
      // mutate() may fully re-render the view (virtual cap / patch fallback),
      // replacing the box DOM — re-locate it afterwards.
      const np = insertViaView(view);
      if (!np) return;
      const boxNow = findEmbedBox(view, src.id);
      const fresh = findBlockById(view.doc.blocks, src.id);
      if (!boxNow || !fresh) return;
      const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
      renderEmbedBodyFrom(boxNow, freshSrc, src.id, view);
      editNewRowWhenReady(np);
      return;
    }

    const filePath = src.file?.path ?? '';
    const other = isLocal ? null : findOpenBlockEditor(view, filePath);
    if (other) {
      // Source page open in another block-editor view: insert through ITS
      // model so unsaved edits / undo / save stay authoritative.
      const np = insertViaView(other);
      if (!np) return;
      if (isPageEmbed) {
        void refreshPageEmbedBox(view, box, src.file!).then(() => editNewRowWhenReady(np));
      } else {
        const fresh = findBlockById(other.doc.blocks, src.id);
        if (!fresh) return;
        const freshSrc: EmbedSource = { block: fresh, crumbs: src.crumbs, file: src.file, id: src.id };
        renderEmbedBodyFrom(box, freshSrc, src.id, view);
        editNewRowWhenReady(np);
      }
      return;
    }

    // Nobody has the source open: patch the file on disk (guarded write:
    // backup + operation log), re-render the box from disk, then edit the
    // new row. An open native-editor view adopts the change via its own
    // vault-modify handler — no forced reload from here.
    if (!src.file) return;
    let npDisk: number[] | null = null;
    void mutatePageEmbedSource(view, src.file, (doc) => {
      const addrRoot = isPageEmbed ? pseudoRootOf(doc.blocks) : findBlockById(doc.blocks, src.id);
      // 同 commitEmbedEditTabInner:重连父子指针,嵌套行的兄弟查找才不落空。
      if (addrRoot) linkParents([addrRoot]);
      const plan = planInsert(doc.blocks, addrRoot);
      if (!plan) return;
      const nb = createBlock('');
      plan.list.splice(plan.index, 0, nb);
      nb.parent = plan.parent;
      npDisk = plan.newPath;
    }).then((ok) => {
      const np = npDisk as number[] | null;
      if (!ok || !np) return;
      const refreshed = isPageEmbed
        ? refreshPageEmbedBox(view, box, src.file!)
        : refreshEmbedBox(view, box, src.id);
      void Promise.resolve(refreshed).then(() => editNewRowWhenReady(np));
    });
  }

  /** Commit + tear down the in-place embed editor; resolves after any disk write lands. */
export async function commitEmbedEdit(view: EmbedEditHost): Promise<boolean> {
    const cur = view.embedEdit;
    view.embedEdit = null;
    if (!cur) return false;
    const raw = expandTemplates(cur.view.state.doc.toString(), new Date(), view.templateContext());
    cur.view.dom.removeEventListener('keydown', cur.escHandler, true);
    cur.view.destroy();
    clearActiveBlockEditor(view.app);
    cur.row.classList.remove('is-editing');
    cur.row.closest('.block-embed')?.classList.remove('is-editing');
    const target = blockAtPath(cur.source.block, cur.path) ?? cur.source.block;
    const { text: clean, props } = splitPropLines(raw);
    const changed = clean !== target.text || !propsShallowEqual(editableProps(target), props);
    if (changed) {
      target.text = clean;
      applyBlockProps(target, props);
      // Writers re-extract, so the raw doc text is safe to hand over.
      await writeEmbedText(view, cur.source, cur.path, raw);
    }
    rerenderEmbedRow(cur.row, cur.source, cur.path, view);
    return changed;
  }

  /** Write an in-place embed edit back into the block the row renders. */
async function writeEmbedText(view: EmbedEditHost,src: EmbedSource, path: number[], text: string): Promise<void> {
    const filePath = src.file?.path;
    // Same file: go through the model so undo / dirty / rendering stay in sync.
    if (!filePath || filePath === view.file?.path) {
      // Page-embed rows of THIS file (no id) are addressed by path, not by id.
      if (src.id === '') {
        applyBlockTextAtPath(view, path, text);
        return;
      }
      applyBlockText(view, src.id, path, text);
      return;
    }
    // Another file: prefer the block editor that has it open (keeps its undo
    // stack and any unsaved edits), otherwise patch the markdown on disk.
    const other = view.app.workspace
      .getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)
      .map((l) => l.view as unknown as EmbedEditHost)
      .find((v) => v.file?.path === filePath);
    if (other) {
      if (src.id === '') applyBlockTextAtPath(other, path, text);
      else applyBlockText(other, src.id, path, text);
      return;
    }
    const file = view.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    // Path-based addressing handles id-less blocks (page-embed rows) and
    // id-carrying blocks alike; the paths were captured from the same parse.
    const ok = await mutatePageEmbedSource(view, file, (doc) => {
      const root = src.id ? findBlockById(doc.blocks, src.id) : pseudoRootOf(doc.blocks);
      if (!root) return;
      const b = blockAtPath(root, path);
      if (!b) return;
      const { text: clean, props } = splitPropLines(text);
      b.text = clean;
      applyBlockProps(b, props);
    });
    if (ok) {
      // An open view adopts the change via its vault-modify handler (its own
      // unsaved edits win and re-save) — no forced reload here.
    }
  }

  /** Apply a text change to a block addressed by child-index path (id-less rows). */
export function applyBlockTextAtPath(view: EmbedEditHost,path: number[], text: string): boolean {
    const root = pseudoRootOf(view.doc.blocks);
    const b = blockAtPath(root, path);
    if (!b) return false;
    const { text: clean, props } = splitPropLines(text);
    if (b.text === clean && propsShallowEqual(editableProps(b), props)) return false;
    view.undo.push(view.serializeCurrent());
    b.text = clean;
    applyBlockProps(b, props);
    view.markDirty();
    refreshBlockContent(b, view);
    view.focusStartSnapshot = serializeDocument(view.doc);
    return true;
  }

  /** First open block-editor view showing `path` (view view included), if any. */
export function findOpenBlockEditor(view: EmbedEditHost, path: string): EmbedEditHost | null {
    return (
      view.app.workspace
        .getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)
        .map((l) => l.view as unknown as EmbedEditHost)
        .find((v) => v.file?.path === path) ?? null
    );
  }

  /** Apply a text change made outside view view (e.g. an in-place embed edit). */
function applyBlockText(view: EmbedEditHost, id: string, path: number[], text: string): boolean {
    const root = findBlockById(view.doc.blocks, id);
    const b = root ? blockAtPath(root, path) : null;
    if (!b) return false;
    const { text: clean, props } = splitPropLines(text);
    if (b.text === clean && propsShallowEqual(editableProps(b), props)) return false;
    view.undo.push(view.serializeCurrent());
    b.text = clean;
    applyBlockProps(b, props);
    view.markDirty();
    refreshBlockContent(b, view);
    view.focusStartSnapshot = serializeDocument(view.doc);
    return true;
  }

  // ------------------------------------------------------------------
