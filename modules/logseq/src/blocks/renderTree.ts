/**
 * Block tree → DOM renderer (Logseq visual structure).
 *
 * DOM per block:
 *   .block-wrap
 *     .block-main
 *       .block-controls (.block-caret | spacer, .block-bullet)
 *       .block-marker (TODO/DOING/DONE checkbox, list blocks only)
 *       .block-content (static MarkdownRenderer output, or CM6 when focused)
 *     .block-children-container
 *       .block-children-left-border
 *       .block-children (recursive)
 *
 * Performance: static content elements are cached per block (WeakMap) and
 * re-attached when unchanged, so structural re-renders do not re-run the
 * async markdown renderer for untouched blocks.
 */

import { MarkdownRenderer, TFile } from 'obsidian';
import { mountCodeBlockReadOnly, parseCodeFence, syntheticFenceInfo } from './codeBlockEdit';
import { enhanceTable } from './tableEditor';
import { hasTable } from './tableModel';
import { baseOf, exists, extOf, readExternalBinary } from '../features/extFs';
import type { BlockRenderHost } from '../blocks/renderHost';
import type { Block } from '../types';
import { blockId } from '../types';
import { foldLevelOf, foldSummary, isFoldableBody, isFoldableHeading, isInsideFoldedSection, isMediaOnlyBlock, normFoldKey } from '../core/fold';
import { createPageEmbedBox, enhanceBlockRefs, enhanceEmbeds } from '../features/links';
import {
  buildQueryTableModel,
  execQuery,
  parseQueryTableText,
  parseQueryText,
  plainText,
  queryStringOf,
  queryTableStringOf,
} from '../features/query';
import type { IndexedBlock } from '../index/blockIndex';
import { flattenVisible } from '../core/treeOps';
import { layoutGuideLines } from './guideLayout';
import { renderBlockView } from './blockView';
import { isViewBlock, VIEW_COLUMNS_PROP, VIEW_PROP } from '../features/blockViews';
import { syncPrologContainer } from './prologResults';
import { detectBlockType, mediaTypeOf } from './blockTypes';
import { renderBlockTypeBadge } from './blockTypeMenu';

const contentCache = new WeakMap<Block, { el: HTMLElement; sig: string }>();
const queryCache = new WeakMap<Block, { el: HTMLElement; sig: string; version: number }>();
const blockElMap = new WeakMap<Block, HTMLElement>(); // .block-wrap of block
const blockOfEl = new WeakMap<HTMLElement, Block>(); // .block-wrap → Block (dnd)

const MAX_QUERY_RESULTS = 200;

/** Virtual scrolling: initial render cap and growth chunk (in visible blocks). */
export const VIRTUAL_INITIAL_CAP = 150;
export const VIRTUAL_CHUNK = 150;

/** Sentinel observer of the current render; replaced on every re-render. */
let loadMoreObserver: IntersectionObserver | null = null;

/** Rendering budget for virtual scrolling (counts rendered visible blocks). */
interface RenderBudget {
  left: number;
  stopped: boolean;
}

export function forgetBlockCache(b: Block): void {
  contentCache.delete(b);
  blockElMap.delete(b);
}

/**
 * 列表块文本:行首 markdown 标记('# x')加渲染期转义,围栏内部跳过。
 * 只在渲染管线里用 —— 块文本本身保持原样。
 */
/**
 * 列表块文本 → 交给 Obsidian 渲染的 markdown。
 *
 * 规则:**第 0 行保留标题语义,只转义续行里的 `#`**。
 *
 * - 第 0 行的 `#{1,6} ` 是块自己的标题 —— Logseq 里 `- ## 标题` 就是一个带
 *   圆点的二级标题,必须让渲染器把整块渲染成 <h2>。曾经这里连第 0 行一起
 *   转义,结果 `- ## 标题` 在大纲里原样显示成 `## 标题`(实机反馈)。
 * - 续行(startLine > 0)的 `#` 是普通文本 —— 多行块里第二行写 `# 备注` 被
 *   heading 化会把半行正文变成大字标题,那才是要防的。
 * - 围栏内部一律逐字(代码里的 `#` 不动)。
 * - 代码注释行不再靠这里兜底:它们进大纲时由 `escapeNoteLine` 打零宽空格
 *   (见 features/codeDoc.ts),所以第 0 行也不再以 `#` 开头。
 */
export function escapeInBlockHeadings(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null; // 当前所处围栏串(如 ```);null = 不在围栏内
  return lines
    .map((line, i) => {
      const m = /^(`{3,}|~{3,})/.exec(line);
      if (m) {
        if (!fence) fence = m[1];
        else if (m[1][0] === fence[0] && line.trim().replace(/[`\s~]/g, '') === '') fence = null;
        return line;
      }
      if (!fence && i > 0 && /^#{1,6}\s/.test(line)) return line.replace(/^(#{1,6}\s)/, '\\$1');
      return line;
    })
    .join('\n');
}

/**
 * The cached static render for `b` when it still matches the current text
 * (NOT attached — callers attach it themselves). Used by the mixed-block
 * code editor to keep the rendered prefix (image/prose) on screen while only
 * the code element is swapped for the editor.
 */
export function cachedStaticEl(b: Block): HTMLElement | null {
  const cached = contentCache.get(b);
  return cached && cached.sig === contentSig(b) ? cached.el : null;
}

export function findBlockEl(b: Block): HTMLElement | null {
  return blockElMap.get(b) ?? null;
}

export function blockFromEl(el: HTMLElement | null): Block | null {
  let cur: HTMLElement | null = el;
  while (cur) {
    const b = blockOfEl.get(cur);
    if (b) return b;
    cur = cur.parentElement;
  }
  return null;
}

const CARET_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>`;

function contentSig(b: Block): string {
  return JSON.stringify([b.text, b.marker ?? '', b.kind]);
}

export function renderBlockTree(container: HTMLElement, roots: Block[], host: BlockRenderHost): void {
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
  // A full rebuild empties the scroller for an instant — the browser clamps
  // scrollTop to the collapsed height and never restores it, so EVERY edit
  // that rebuilds the whole tree (root-level Enter → patchSiblingList(null),
  // patch fallback → renderInner) jumped the page to the top. Pin the scroll
  // position across the swap, but only on the editing path (a focused block
  // exists) — file loads and zooms render with no focused block and should
  // keep natural scrolling.
  const sc = container.closest('.block-editor-scroller');
  const savedTop = sc?.scrollTop ?? 0;
  const preserveScroll = savedTop > 0 && !!host.focusedBlock;
  container.empty();
  if (roots.length === 0) {
    const empty = container.createEl('div', { cls: 'block-editor-empty' });
    empty.setText('Empty page — click here to create the first block.');
    empty.addEventListener('click', () => host.createFirstBlock());
    return;
  }
  // Virtual scrolling: cap the rendered block count on huge documents; the
  // sentinel below grows the cap (host.bumpScrollCap) as the user approaches.
  const cap = host.scrollCap;
  const total = flattenVisible(roots).length;
  const budget: RenderBudget | undefined = total > cap ? { left: cap, stopped: false } : undefined;

  const frag = document.createDocumentFragment();
  // Section folding (SiYuan's `removeFoldHeading`): a folded heading hides the
  // blocks it introduces — the following siblings of a deeper heading level,
  // up to the next heading of the same or a shallower level. A markdown heading
  // cannot own them as children, so the section is defined by scanning the
  // visible sequence rather than by tree structure.
  const seq = flattenVisible(roots);
  const posOf = new Map<Block, number>(seq.map((b, i) => [b, i] as const));
  for (const b of roots) {
    if (budget && (budget.left <= 0 || budget.stopped)) {
      budget.stopped = true;
      break;
    }
    if (isInsideFoldedSection(b, posOf.get(b) ?? -1, seq)) continue;
    if (budget) budget.left--;
    frag.appendChild(renderBlock(b, host, budget));
  }
  container.appendChild(frag);

  // Logseq parity: the empty area under the last block is an add-block
  // affordance — hovering shows a faint line + plus, clicking appends and
  // focuses a new block at the end of the visible outline. Switched OFF by
  // 设置 → 文末添加块, which drops the whole row: the page then ends at the
  // last bullet (the row is display-level only — nothing else depends on it).
  if (host.plugin.settings.addBlockAffordance !== false) {
    // 装饰细分开关(设置 → 文末加号与横线):关掉后行保留——仍可点击在文末
    // 追加块,只是不再画横线和加号(.lgp-addblock-no-marks 隐藏两个伪元素)。
    const cls =
      host.plugin.settings.addBlockMarks !== false
        ? 'block-editor-addblock'
        : 'block-editor-addblock lgp-addblock-no-marks';
    container
      .createEl('div', { cls })
      .addEventListener('click', (e) => {
        e.stopPropagation();
        host.addBlockAtEnd();
      });
  }

  if (budget) {
    const hidden = total - cap;
    const sentinel = container.createEl('div', {
      cls: 'block-editor-load-more',
      text: `Load more · ${hidden} blocks below`,
    });
    const bump = (): void => {
      loadMoreObserver?.disconnect();
      loadMoreObserver = null;
      host.bumpScrollCap();
    };
    sentinel.addEventListener('click', bump);
    loadMoreObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) bump();
      },
      { rootMargin: '800px 0px' },
    );
    loadMoreObserver.observe(sentinel);
  }

  // The rebuild above replaced every guide line, so their inline calibration
  // is gone and the CSS approximations show. The container ResizeObserver
  // only re-fires when the tree's SIZE changed — same-height re-renders (e.g.
  // clicking the breadcrumb file name) left the lines at the approximation
  // (visibly shifted). Always recalibrate after a render, once laid out.
  requestAnimationFrame(() => layoutGuideLines(container));

  // Content is back in the DOM (cached statics mount synchronously) — put the
  // scroller back where the edit happened.
  if (preserveScroll && sc) sc.scrollTop = savedTop;
}

function renderBlock(b: Block, host: BlockRenderHost, budget?: RenderBudget): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'block-wrap' + (b.kind === 'raw' ? ' block-raw' : '');
  // SiYuan parity: the type is derived from the markdown on every render
  // (never stored), and exposed to CSS / the gutter badge below.
  const btype = detectBlockType(b);
  wrap.dataset.blockType = btype;
  wrap.classList.add('block-type-' + btype);
  // 段落容器(bare)标记:styles.css 用它把 controls 改成行首覆盖层(不占布局),
  // 段落文字因此顶格,与思源的几何一致(圆点列只属于列表块)。
  if (b.bare) wrap.classList.add('is-bare');
  if (host.selectedBlocks.has(b)) wrap.classList.add('is-selected');
  const id = blockId(b);
  if (id) wrap.dataset.blockId = id;
  blockElMap.set(b, wrap);
  blockOfEl.set(wrap, b);

  // Native properties editor for the props block: the row drops its outline
  // chrome (no bullet, no drag handle) — the container renders exactly like
  // the native page properties.
  const nativeProps =
    isPropsBlock(b, host) && host.plugin.settings.pagePropsEditor === 'native';
  if (nativeProps) wrap.classList.add('block-native-props');

  const main = wrap.createEl('div', { cls: 'block-main' });

  // --- controls ---
  const controls = main.createEl('div', { cls: 'block-controls' });
  // 注释区(混合编辑视图)行号:块 ↔ 文件行,渲染在 controls 列 —— 段落几何
  // 下圆点列改作行号 gutter(数字取代圆点,文字列位置不变,与代码编辑器
  // 的行号列同一职责)。普通大纲不传,行为零变化。
  const noteLine = host.noteLineNumberOf?.(b) ?? null;
  if (noteLine !== null) {
    const ln = controls.createEl('div', { cls: 'block-line-no' });
    ln.textContent = String(noteLine);
  }
  // Raw (verbatim) blocks get the drag handle too: a table, divider, formula
  // or media embed is real content the user expects to be able to move.
  const draggable = b.kind === 'list' || b.kind === 'raw';
  if (draggable && !nativeProps) {
    controls.setAttribute('draggable', 'true'); // block drag handle zone
  }
  // 段落容器(is-bare):controls 被样式改成行首覆盖层(不占布局,见
  // styles.css 的 .is-bare 规则),折叠箭头与拖拽热区都在这一条上。单击它
  // 按坐标落焦点——否则行首 16px 是死区,光标放不到段首。
  if (b.bare) {
    controls.addEventListener('click', (e) => {
      e.stopPropagation();
      host.focusBlockFromClick(b, e);
    });
  }
  if (!nativeProps && host.foldEnabled && (isFoldableBody(b) || isFoldableHeading(b))) {
    // The caret belongs to EVERY foldable body, not just a list block with
    // children: a heading, a fenced code block, a table, a quote, a
    // media-only block and a multi-line paragraph all span more than one
    // rendered line, and all of them can be folded.
    //
    // Collapsed state lives on the wrap (the bullet draws the gray halo);
    // the caret itself is hover-only, floating in the left margin.
    const level = foldLevelOf(b.props);
    if (level !== 'none') wrap.addClass('is-collapsed');
    const caret = controls.createEl('div', {
      cls: 'block-caret' + (level !== 'none' ? ' is-collapsed' : ''),
    });
    caret.innerHTML = CARET_SVG;
    caret.setAttribute('role', 'button');
    caret.setAttribute('tabindex', '0');
    caret.setAttribute('aria-label', level === 'none' ? '折叠此块' : '展开此块');
    caret.setAttribute('title', '点击折叠 · Alt+点击折叠所有子块');
    const onCaretActivate = (e: MouseEvent): void => {
      e.stopPropagation();
      e.preventDefault();
      // Alt is SiYuan's `toggleListFold`: fold (or unfold) EVERY descendant,
      // not a deeper level of this block. A plain click toggles just this one.
      if (e.altKey) host.foldSubtree(b);
      else host.cycleFold(b);
    };
    caret.addEventListener('click', onCaretActivate);
    // Keyboard parity: the caret is focusable, so Enter/Space must work too.
    caret.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.stopPropagation();
      e.preventDefault();
      if (e.altKey) host.foldSubtree(b);
      else host.cycleFold(b);
    });
    // Hover-only, like every other caret in the outline: the fold arrow is a
    // per-row affordance and a column of permanently visible arrows competes
    // with the text it is meant to fold. A FOLDED block keeps its caret
    // visible, because there the arrow is the only way back — and it is the
    // one row whose direction has changed.
    if (level !== 'none') caret.addClass('is-persistent');
  }
  // 大纲圆点只属于列表容器。段落容器(bare:源文件没有列表标志)不显示圆点;
  // 但带任务标记的裸行(`TODO x`)语义上是任务项,圆点照显(复选框在下面)。
  // 注释区(noteLine 非 null)同样不画圆点:那一列是行号 gutter。
  if (b.kind === 'list' && !b.bare && !nativeProps && noteLine === null) {
    const bullet = controls.createEl('div', { cls: 'block-bullet' });
    bullet.setAttribute('aria-label', 'Focus this block');
    bullet.setAttribute('title', 'Click to focus · Shift/Ctrl+click to select');
    bullet.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        host.selectFromClick(b, e); // multi-select from the bullet
        return;
      }
      // Single click = focus (zoom) the block; collapsing lives on the caret.
      host.zoomIn(b);
    });
    // The bullet is not inside the content holder, so it needs its own
    // mousedown capture for the same reason (see captureRangeAnchor).
    bullet.addEventListener('mousedown', (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) host.captureRangeAnchor(e);
    });
  }

  // --- block type badge (SiYuan parity): names the type and opens the
  // conversion menu. Plain paragraphs and the props block already read as
  // what they are, so they stay clean. ---
  if (btype !== 'paragraph' && btype !== 'props' && !nativeProps) {
    renderBlockTypeBadge(controls, host, b, btype);
  }

  // --- marker checkbox ---
  if (b.kind === 'list' && b.marker) {
    const mk = main.createEl('div', { cls: 'block-marker ' + b.marker.toLowerCase() });
    mk.setAttribute('aria-label', b.marker);
    mk.addEventListener('click', (e) => {
      e.stopPropagation();
      host.toggleMarker(b);
    });
  }

  // --- content ---
  // Property chips (priority/scheduled/deadline badges) are intentionally NOT
  // rendered here: the props row below shows every `key:: value` pair, which
  // is exactly what the editing state shows — one display, both states.
  const content = main.createEl('div', { cls: 'block-content' });
  if (b.props['style']) {
    for (const [k, v] of Object.entries(parseStyleProp(b.props['style']))) {
      content.style.setProperty(k, v);
    }
  }
  // Folding, in SiYuan's sense (`[fold="1"]`): a CONTAINER keeps its own text
  // and collapses its children to folded rows — what changes is the children
  // container, not the block's content. A block with nothing to keep (a fence,
  // a table, media) is replaced by a one-line summary, because there is no
  // second row to show. A heading folds the section it introduces.
  //
  // Either way the markdown is untouched; this is purely a view state.
  const foldLevel = foldLevelOf(b.props);
  const heading = isFoldableHeading(b);
  // A folded heading is excluded from the editing path too: it has no body to
  // edit in place — its section is what got hidden.
  if (host.focusedBlock === b && (foldLevel === 'none' || heading)) {
    content.classList.add('is-editing');
    // CM6 gets mounted here by the view after the tree render pass.
    host.mountFocusedInto(content);
  } else if (foldLevel !== 'none' && !heading && b.children.length === 0) {
    // Childless: nothing would be left visible, so summarise it.
    // Focusing a folded block is not an error: clicking the summary unfolds it
    // so the real text can be edited.
    renderFoldSummary(content, b, host);
  } else if (isPropsBlock(b, host)) {
    // The page-properties block: Obsidian's NATIVE properties editor when the
    // setting picks it (falls back to the Logseq rendering until the native
    // component class resolves), otherwise the same `key:: value` lines the
    // editor shows, so both states look alike.
    if (!(nativeProps && host.nativePropsEditorFor(content, b))) {
      renderPropsAsContent(content, b, host);
    }
  } else {
    attachStaticContent(content, b, host);
    if (b.text === '' && !nativeProps) {
      // Empty block: the static holder renders NOTHING (zero-height), so the
      // focus handler wired on it can never receive a click — the row was
      // unclickable and un-deletable. Wire the whole row (the wrap) instead:
      // it is the only element guaranteed to cover the empty row's area.
      wrap.addEventListener('mousedown', (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) host.captureRangeAnchor(e);
      });
      wrap.addEventListener('click', (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          host.selectFromClick(b, e);
          return;
        }
        host.focusBlockFromClick(b, e);
      });
    }
  }

  // --- children: the guide line hangs from the bullet dot and doubles as a
  // collapse toggle (click = fold the content inside it). Folded blocks render
  // NO container/line at all — expansion lives on the always-visible caret. ---
  const collapsed = b.props['collapsed'] === 'true';
  const kidsVisible = b.children.length > 0 && !collapsed;
  // A `view::` property renders the children as a table / cards / tabs instead
  // of an outline list. The data stays the same indented markdown — only the
  // presentation changes, and removing the property restores the list.
  const viewEl = kidsVisible && (!budget || budget.left > 0) ? renderBlockView(b, host) : null;
  if (viewEl) {
    wrap.appendChild(viewEl);
    if (budget) budget.left--; // the view consumed the child budget as one unit
  } else if (kidsVisible && (!budget || budget.left > 0)) {
    const cc = wrap.createEl('div', { cls: 'block-children-container' });
    const guide = cc.createEl('div', { cls: 'block-children-left-border' });
    guide.setAttribute('aria-label', 'Collapse child blocks');
    guide.addEventListener('click', (e) => {
      e.stopPropagation();
      host.toggleCollapseGuide(b);
    });
    const inner = cc.createEl('div', { cls: 'block-children' });
    for (const c of b.children) {
      if (budget && budget.left <= 0) {
        budget.stopped = true;
        break;
      }
      if (budget) budget.left--;
      inner.appendChild(renderBlock(c, host, budget));
    }
  } else if (b.children.length > 0 && budget) {
    // Collapsed (nothing to render) or budget exhausted (virtualized).
    if (!collapsed) budget.stopped = true;
  }

  // --- block properties below content (Logseq md parity) — hidden while
  // the block is being edited (the editor shows the prop lines itself) and
  // for the props block (its props ARE the content). ---
  if (!isPropsBlock(b, host)) syncPropsRow(wrap, b, host, host.focusedBlock === b);

  // --- embedded query results ({{query ...}}) ---
  syncQueryContainer(wrap, b, host);

  // --- Prolog query results (a ```prolog fenced block) ---
  syncPrologContainer(wrap, b, host);

  // --- TraceTime parity: last-edited label at the row's right edge ---
  syncTracetimeLabel(wrap, b, host);

  return wrap;
}

/**
 * TraceTime parity: render the block's last-edited timestamp (from the
 * TraceTime plugin's tracker, see features/tracetime.ts) as its own
 * `.tracetime-label` component at the row's right edge. No-op when the plugin
 * is absent (labelFor returns null).
 */
function syncTracetimeLabel(wrap: HTMLElement, b: Block, host: BlockRenderHost): void {
  // The native properties UI has no labels of its own — keep that row bare.
  if (isPropsBlock(b, host) && host.plugin.settings.pagePropsEditor === 'native') return;
  const main = wrap.querySelector(':scope > .block-main');
  if (!main) return;
  const minutes = host.tracetimeModifiedAt(b);
  let el = main.querySelector(':scope > .tracetime-label') as HTMLElement | null;
  if (minutes === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = main.createEl('div', { cls: 'tracetime-label' });
    el.createSpan('tracetime-label-dot');
    el.createSpan({ cls: 'tracetime-label-text' });
    const vertical = host.tracetimeVertical();
    if (vertical === 'start' || vertical === 'end') el.dataset.vertical = vertical;
  }
  const text = el.querySelector('.tracetime-label-text');
  const next = host.tracetimeFormat(minutes);
  if (text && text.textContent !== next) text.setText(next);
}

/** Update the labels of every rendered row after the tracker reconciled. */
export function refreshTracetimeLabels(host: BlockRenderHost): void {
  for (const wrap of host.containerEl.querySelectorAll<HTMLElement>('.block-wrap')) {
    const b = blockOfEl.get(wrap);
    if (b) syncTracetimeLabel(wrap, b, host);
  }
}

/**
 * The one-line placeholder a folded block shows instead of its body.
 *
 * Two levels, matching the two gestures on the caret:
 *   summary — the block's own first line (a fence keeps its ```python header,
 *             an image names its file), so you can still tell WHAT it is.
 *   full    — a terse `[类型]` marker for when you are scanning a document and
 *             do not need the detail; the full text is one click away.
 *
 * Clicking the summary unfolds. The text itself is never modified — folding is
 * a view state over the markdown, not a rewrite of it.
 */
/**
 * The one-line placeholder shown for a folded block that has no children to
 * keep visible (a code fence, a table, a media block) — a container keeps its
 * own text instead, and a heading hides its section.
 *
 * The row is also the unfold button: clicking it restores the real text. The
 * block's markdown is never modified, so this is a view state only.
 */
function renderFoldSummary(content: HTMLElement, b: Block, host: BlockRenderHost): void {
  const row = content.createEl('div', { cls: 'block-fold-summary' });
  row.createEl('span', { cls: 'block-fold-kind', text: blockKindLabel(b) });
  const detail = foldSummary(b);
  // The detail only differs from the label when it adds something (a file
  // name, a first line) — otherwise the row would read `[代码块] 代码块`.
  if (detail && !blockKindLabel(b).includes(detail)) {
    row.createEl('span', { cls: 'block-fold-detail', text: detail });
  }
  const lines = b.text.split('\n').length;
  const meta = lines > 1 ? `${lines} 行` : null;
  if (meta) row.createEl('span', { cls: 'block-fold-meta', text: meta });
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', '展开此块');
  const unfold = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
    host.setFold(b, 'none');
  };
  row.addEventListener('click', unfold);
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.stopPropagation();
    e.preventDefault();
    host.setFold(b, 'none');
  });
}

/** Short type name for the folded placeholder: 代码块 / 表格 / 引用 / 标题 … */
function blockKindLabel(b: Block): string {
  const text = b.text;
  if (/^\s*(?:`{3,}|~{3,})/.test(text)) return '代码块';
  if (/^\s*\$\$/.test(text)) return '公式块';
  if (/^\s*\|/.test(text)) return '表格';
  if (/^\s*>/.test(text)) return '引用';
  if (/^\s*#{1,6}\s/.test(text)) return '标题';
  if (/^\s*(?:=+|\*+|_+|~+|\++)\s*$/.test(text.split('\n')[0])) return '分隔线';
  if (isMediaOnlyBlock(text)) return /<video|\.(mp4|webm|ogv|mov|m4v)\b/i.test(text) ? '视频' : '图片';
  if (b.kind === 'raw') return '内容块';
  return b.children.length > 0 ? '列表块' : '段落';
}

/** Props that configure the block itself and are never shown as a `key:: value` row. */
const WRAP_PROPS_SKIP = new Set(['id', 'collapsed', 'style', VIEW_PROP, VIEW_COLUMNS_PROP]);

/**
 * Properties hidden from the props row, resolved per render.
 *
 * The base set configures the block itself and never renders as a row. The
 * user's list is ADDED to it — hiding is view-only, so a hidden property keeps
 * working everywhere else (folding, the SQLite index, the properties panel).
 * Compared through `normFoldKey`, so `Collapsed` and `collapsed` are one key.
 */
function hiddenPropSet(host: BlockRenderHost): Set<string> {
  const set = new Set(WRAP_PROPS_SKIP);
  for (const raw of (host.plugin.settings.hiddenProps ?? '').split(',')) {
    const name = raw.trim();
    if (name) set.add(normFoldKey(name));
  }
  return set;
}

/**
 * One `key:: value` line under a block (Logseq parity): dimmed like the
 * editor's property lines, and BOTH the key and the value are pages —
 * clicking either opens/creates that page.
 */
function renderPropLine(parent: HTMLElement, k: string, v: string, host: BlockRenderHost, sep = ':: '): void {
  const item = parent.createEl('div', { cls: 'block-prop-item' });
  const key = item.createEl('span', { cls: 'block-prop-key', text: k });
  item.createEl('span', { cls: 'block-prop-sep', text: sep });
  const val = item.createEl('span', { cls: 'block-prop-value', text: v });
  const open = (e: Event, page: string): void => {
    e.stopPropagation();
    e.preventDefault();
    void host.app.workspace.openLinkText(page, '', false);
  };
  key.addEventListener('click', (e) => open(e, k));
  val.addEventListener('click', (e) => open(e, v));
}

/** Render (or clear) the `key:: value` props row under the block content. */
function syncPropsRow(wrap: HTMLElement, b: Block, host: BlockRenderHost, editing = false): void {
  wrap.querySelector(':scope > .block-props-row')?.remove();
  // While the block is being edited the props show as text lines in the
  // editor itself — the row would duplicate them.
  if (editing) return;
  // A folded block shows a summary instead of its body, so the property row
  // would float free of any content it belongs to.
  if (foldLevelOf(b.props) !== 'none') return;
  const hidden = hiddenPropSet(host);
  const entries = Object.entries(b.props).filter(([k]) => !hidden.has(normFoldKey(k)));
  if (entries.length === 0) return;
  const row = wrap.createEl('div', { cls: 'block-props-row' });
  // Logseq parity: props sit directly under the block text, BEFORE its children.
  wrap.querySelector(':scope > .block-main')?.insertAdjacentElement('afterend', row);
  for (const [k, v] of entries) renderPropLine(row, k, v, host);
}

/** True when the block body is a single {{query ...}} / {{query-table ...}} expression. */
function isQueryBlock(b: Block, host: BlockRenderHost): boolean {
  return (
    b.kind === 'list' &&
    host.focusedBlock !== b &&
    (queryStringOf(b.text) !== null || queryTableStringOf(b.text) !== null)
  );
}

/** style:: whitelist — safe CSS declarations applied to the block content. */
const STYLE_ALLOWED = new Set([
  'color',
  'background-color',
  'font-weight',
  'font-style',
  'font-size',
  'text-decoration',
]);

/** Parse `style:: color: red; font-weight: bold` into safe CSS declarations. */
export function parseStyleProp(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of style.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop && STYLE_ALLOWED.has(prop) && value) {
      // Only one declaration per property; values are plain (no url()/expression()).
      out[prop] = value;
    }
  }
  return out;
}

/** Add / remove / refresh the .block-query-results container of a block wrap. */
function syncQueryContainer(wrap: HTMLElement, b: Block, host: BlockRenderHost): void {
  const isQuery = isQueryBlock(b, host);
  wrap.classList.toggle('block-has-query', isQuery);
  const old = wrap.querySelector(':scope > .block-query-results');
  if (!isQuery) {
    old?.remove();
    return;
  }
  const el = renderQueryResults(b, host);
  if (old) old.replaceWith(el);
  else {
    const cc = wrap.querySelector(':scope > .block-children-container');
    if (cc) wrap.insertBefore(el, cc);
    else wrap.appendChild(el);
  }
}

/** Render (or reuse from cache) the results container of a query block. */
function renderQueryResults(b: Block, host: BlockRenderHost): HTMLElement {
  const idx = host.plugin.blockIndex;
  const version = idx?.version ?? 0;
  const sig = b.text;
  const cached = queryCache.get(b);
  if (cached && cached.sig === sig && cached.version === version) return cached.el;

  const el =
    queryTableStringOf(b.text) !== null ? renderQueryTable(b, host) : renderQueryList(b, host);
  queryCache.set(b, { el, sig, version });
  return el;
}

/** {{query ...}} — flat result list. */
function renderQueryList(b: Block, host: BlockRenderHost): HTMLElement {
  const el = document.createElement('div');
  el.className = 'block-query-results';
  const idx = host.plugin.blockIndex;
  const ast = parseQueryText(b.text);
  if (!ast) {
    el.createEl('div', { cls: 'query-error', text: 'Invalid query' });
  } else if (!idx) {
    el.createEl('div', { cls: 'query-error', text: 'Block index unavailable' });
  } else {
    const results = execQuery(ast, idx.allBlocks());
    for (const r of results.slice(0, MAX_QUERY_RESULTS)) el.appendChild(queryResultItem(r, host));
    if (results.length === 0) {
      el.createEl('div', { cls: 'query-empty', text: 'No results' });
    } else if (results.length > MAX_QUERY_RESULTS) {
      el.createEl('div', { cls: 'query-more', text: `… ${results.length - MAX_QUERY_RESULTS} more` });
    }
  }
  return el;
}

/** {{query-table ...}} — results as a table with dynamic property columns. */
function renderQueryTable(b: Block, host: BlockRenderHost): HTMLElement {
  const el = document.createElement('div');
  el.className = 'block-query-results block-query-table-wrap';
  const idx = host.plugin.blockIndex;
  const ast = parseQueryTableText(b.text);
  if (!ast) {
    el.createEl('div', { cls: 'query-error', text: 'Invalid query' });
    return el;
  }
  if (!idx) {
    el.createEl('div', { cls: 'query-error', text: 'Block index unavailable' });
    return el;
  }
  const results = execQuery(ast, idx.allBlocks()).slice(0, MAX_QUERY_RESULTS);
  const model = buildQueryTableModel(results);
  if (model.rows.length === 0) {
    el.createEl('div', { cls: 'query-empty', text: 'No results' });
    return el;
  }

  const table = el.createEl('table');
  const headRow = table.createEl('thead').createEl('tr');
  headRow.createEl('th', { text: 'Block' });
  for (const c of model.columns) headRow.createEl('th', { text: c });
  headRow.createEl('th', { text: 'Source' });

  const tbody = table.createEl('tbody');
  for (const r of model.rows) {
    const tr = tbody.createEl('tr');
    tr.createEl('td', {
      cls: 'qt-text',
      text: (r.marker ? r.marker + ' ' : '') + (plainText(r.text) || '(empty)'),
    });
    for (const c of model.columns) {
      tr.createEl('td', { text: r.props[c] ?? '' });
    }
    tr.createEl('td', { cls: 'qt-src', text: r.path });
    tr.addEventListener('click', () => {
      if (r.blockId) void host.plugin.openBlockRef(r.blockId);
      else host.openLink(r.path);
    });
  }
  return el;
}

function queryResultItem(r: IndexedBlock, host: BlockRenderHost): HTMLElement {
  const item = document.createElement('div');
  item.className = 'query-result-item';
  if (r.marker) {
    const mk = item.createEl('span', { cls: 'block-marker ' + r.marker.toLowerCase() });
    mk.setAttribute('aria-label', r.marker);
  }
  item.createEl('span', { cls: 'query-result-text' }).setText(plainText(r.text) || '(empty)');
  item.createEl('span', { cls: 'query-result-src', text: r.path });
  item.addEventListener('click', () => {
    if (r.blockId) void host.plugin.openBlockRef(r.blockId);
    else host.openLink(r.path);
  });
  return item;
}

/** Refresh query results of all visible query blocks (index rebuilt). */
export function refreshQueryBlocks(container: HTMLElement, host: BlockRenderHost): void {
  for (const wrap of Array.from(container.querySelectorAll('.block-has-query'))) {
    const b = blockFromEl(wrap as HTMLElement);
    if (b) syncQueryContainer(wrap as HTMLElement, b, host);
  }
}

/** True when the block body is a dataview / dataviewjs code fence. */
function isDataviewBlock(b: Block): boolean {
  return /^\s*```(dataview|dataviewjs)\b/i.test(b.text);
}

/**
 * GFM tables only parse when the header row starts a new block (blank line
 * before it), but Logseq-format files keep table rows hugging the block's
 * first line — `| a | b |` right under the text renders as literal pipes.
 * Insert a render-only blank line before a detected table (never inside a
 * code fence); the block model and the saved file stay untouched.
 */
export function withTableSeparation(text: string): string {
  if (!/^\s*\|/m.test(text)) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceOpen = /^\s*(```|~~~)/.exec(line);
    if (fenceOpen && !inFence) {
      inFence = true;
      fenceMarker = fenceOpen[1];
    } else if (inFence && line.trimStart().startsWith(fenceMarker)) {
      inFence = false;
    }
    if (
      !inFence &&
      /^\s*\|/.test(line) &&
      out.length > 0 &&
      out[out.length - 1].trim() !== '' &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])
    ) {
      out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * A lone `>` line inside a block (Logseq's empty quote row) is dropped by
 * CommonMark when it trails the quote and renders as an invisible gap when it
 * sits between quote lines. Insert a render-only blank line before it so it
 * becomes its own empty blockquote (styled visible via the CSS min-height).
 * Never inside a code fence; the block model and the saved file stay untouched.
 */
export function withQuoteRowSeparation(text: string): string {
  if (!/^\s*>\s*$/m.test(text)) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceOpen = /^\s*(```|~~~)/.exec(line);
    if (fenceOpen && !inFence) {
      inFence = true;
      fenceMarker = fenceOpen[1];
    } else if (inFence && line.trimStart().startsWith(fenceMarker)) {
      inFence = false;
    }
    const prevIsQuote = out.length > 0 && /^>/.test(out[out.length - 1].trimStart());
    if (!inFence && /^\s*>\s*$/.test(line) && prevIsQuote) out.push('');
    out.push(line);
  }
  return out.join('\n');
}

/** Render static content with cache reuse when the block text is unchanged. */
function attachStaticContent(content: HTMLElement, b: Block, host: BlockRenderHost): void {
  const sig = contentSig(b);
  const cached = contentCache.get(b);
  if (cached && cached.sig === sig) {
    content.appendChild(cached.el); // DOM move preserves rendered children
    return;
  }
  const holder = document.createElement('div');
  holder.className = 'block-content-static';
  // Dataview coexistence: mark the container so the code block keeps its own
  // rendering (Dataview registers a ```dataview post-processor that
  // MarkdownRenderer invokes); skip our block-ref/embed enhancements so we
  // never fight over the DOM it produces.
  if (isDataviewBlock(b)) {
    holder.classList.add('block-dataview');
    content.classList.add('has-dataview');
    if (!(host.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.['dataview']) {
      holder.createEl('div', {
        cls: 'dataview-missing',
        text: 'Dataview plugin is not enabled — this block renders as plain code.',
      });
      content.appendChild(holder);
      contentCache.set(b, { el: holder, sig });
      return;
    }
  }
  content.appendChild(holder);
  // Capture the document generation: async render results from a previous
  // file load must not land in the current one.
  const gen = host.renderGeneration;
  if (b.text === '') {
    // Empty block: keep the slot clickable but render nothing.
    wireContentEvents(holder, b, host);
    contentCache.set(b, { el: holder, sig });
    return;
  }
  // ![[Page]] page-embeds: Obsidian's markdown renderer would render the
  // inner [[Page]] as an internal link BEFORE our embed pass can see the
  // raw text. Protect the page-embed syntax with a token placeholder during
  // markdown render, then swap tokens for live page-embed boxes.
  // MEDIA targets (`![[img.png]]` / video / audio, by extension — `|W` width
  // suffix stripped first) are NOT tokenized: the markdown renderer renders
  // them natively (<img>/<video>/<audio>) and the enhanceImages pass picks
  // them up; tokenizing them produced a "page not found" box instead.
  const pageEmbedTokens: { token: string; page: string }[] = [];
  const hasWikiEmbed = /!\[\[[^\[\]]+\]\]/.test(b.text);
  // HTML img 相对 src 锚定：防库内同名图片劫持（见 anchorRelativeImgSrcs 注释）
  const imgAnchorTokens: ImgAnchorToken[] = [];
  // Logseq parity: 列表块**第 0 行**的 `# 标题` 就是要渲染成标题(带圆点的
  // h1-h6),只有续行里的 `#` 才转义成字面文本。代码注释行不进这条路径 ——
  // 它们在 features/codeDoc.ts 的 escapeNoteLine 里就被零宽空格挡住了。
  // 仅影响渲染(块文本不变,往返无损);围栏内部保持逐字。raw 块不受影响。
  const blockSource = b.kind === 'list' ? escapeInBlockHeadings(b.text) : b.text;
  const mdSource = withTableSeparation(
    withQuoteRowSeparation(
      anchorRelativeImgSrcs(
        hasWikiEmbed
        ? blockSource.replace(/!\[\[([^\[\]]+)\]\]/g, (m, inner: string) => {
            if (mediaTypeOf(inner.split('|')[0].trim())) return m; // media: native render
            const token = `LGPAGEEMBED${pageEmbedTokens.length}LGPAGEEMBED`;
            pageEmbedTokens.push({ token, page: inner });
            return token;
          })
        : blockSource,
        host,
        imgAnchorTokens,
      ),
    ),
  );
  MarkdownRenderer.render(host.app, mdSource, holder, host.file?.path ?? '', host).then(() => {
    if (host.renderGeneration !== gen) return; // stale (file switched)
    wireContentEvents(holder, b, host);
    if (!holder.hasClass('block-dataview')) {
      // 锚定恢复必须先于一切包裹/检查 img 的 enhance pass
      applyAnchoredImgSrcs(holder, host, imgAnchorTokens);
      // Embeds FIRST: `{{embed ((id))}` contains an inner `((id))` that
      // enhanceBlockRefs would otherwise turn into a chip, splitting the text
      // node so the embed pattern no longer matches.
      enhanceEmbeds(holder, host);
      enhanceCodeBlocks(holder, b, host);
      // Visual table editing. Must run AFTER MarkdownRenderer (it upgrades the
      // rendered <table> in place) and after code blocks (a table inside a code
      // fence is not a table).
      enhanceTables(holder, b, host);
      // Image resize handles (native editor parity): hover corner + drag.
      enhanceImages(holder, b, host);
      // Swap page-embed tokens for live boxes ( BEFORE block-ref chips so
      // the token is not mistaken for text).
      for (const { token, page } of pageEmbedTokens) {
        const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;
        while (node) {
          const next = walker.nextNode() as Text | null;
          if (node.data.includes(token)) {
            const frag = document.createDocumentFragment();
            const parts = node.data.split(token);
            parts.forEach((part, i) => {
              if (i > 0) frag.appendChild(createPageEmbedBox(page, host));
              if (part) frag.appendChild(document.createTextNode(part));
            });
            node.replaceWith(frag);
            break;
          }
          node = next;
        }
      }
      enhanceBlockRefs(holder, host);
    }
  });
  contentCache.set(b, { el: holder, sig });
}

/**
 * Code-block toolbar (slim strip ABOVE the code): language name left, copy
 * button right — a dedicated bar so the copy icon never overlaps the code
 * content (the native floating copy button is hidden via CSS). Click copies
 * the code text and flashes a check mark. Clicking the language label opens
 * the block in one-shot source mode with the cursor at the end of the
 * fence's language word, so the language can be edited directly.
 */
/**
 * Make every rendered table in this block visually editable.
 *
 * Obsidian's own table editor is a private CM6 extension (`.cm-table-widget`)
 * that cannot be mounted into our editor, so `tableEditor.ts` reimplements the
 * UX on the `<table>` that MarkdownRenderer already produced. Upgrading in
 * place keeps all existing table styling.
 */
/**
 * HTML img 相对 src 锚定 —— 防止库内同名文件劫持。
 *
 * Word/OneNote 导出的笔记用 <img src="media/imageN.png"> 相对路径引用图片。
 * Obsidian MarkdownRenderer 对 HTML img 的 src 走全局链接解析（库根优先，
 * 未命中后全库模糊匹配），库内存在其他笔记的同名 media/imageN.png 时会
 * 渲染出错误的图片（实测：NLP 笔记的 image6 被深度学习笔记的 tensor
 * 截图劫持，库内同名词达 10 处）。
 *
 * 修复：渲染前把能解析到库内文件的相对 src 替换成 token（解析顺序 =
 * md 所在目录优先，其次库根）；渲染后用该文件的资源 URL 恢复。
 * 解析不到文件的 src 原样保留，交给 Obsidian 的默认行为。
 */
export type ImgAnchorToken = { token: string; url: string };

const IMG_ANCHOR_PREFIX = 'LGIMGANCHOR';
const IMG_ANCHOR_RE = /^LGIMGANCHOR(\d+)LGIMGANCHOR$/;
const IMG_EXT_RE = /^(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

const IMG_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	avif: 'image/avif',
	ico: 'image/x-icon',
};

/** 库外图片的 blob URL 缓存(ImageView 同款机制):同一文件多次渲染复用,
 *  上限 80 张,超出撤销最旧的,防长编辑会话内存膨胀。 */
const externalImgUrls = new Map<string, string>();

function externalImgUrl(abs: string): string {
	const hit = externalImgUrls.get(abs);
	if (hit) return hit;
	const mime = IMG_MIME[extOf(baseOf(abs))] ?? 'application/octet-stream';
	const url = URL.createObjectURL(new Blob([readExternalBinary(abs)], { type: mime }));
	externalImgUrls.set(abs, url);
	if (externalImgUrls.size > 80) {
		const oldest = externalImgUrls.keys().next().value as string;
		const old = externalImgUrls.get(oldest);
		if (old) URL.revokeObjectURL(old);
		externalImgUrls.delete(oldest);
	}
	return url;
}

/** 文件所在目录(库外 abs;两种分隔符都认)。 */
function externalBaseDir(abs: string): string {
	const norm = abs.replace(/[\\/]+$/, '');
	const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
	return idx > 0 ? norm.slice(0, idx) : norm;
}

/**
 * 库外图片解析:src 相对 externalAbs 所在目录,一层层往上找(用户指定顺序,
 * 附件目录挂在任意祖先都命中),Node fs 在盘上探测;命中即建 blob URL。
 * 全部未命中返回 null,src 原样保留交还默认行为。
 */
function resolveExternalImgUrl(raw: string, baseDir: string): string | null {
	if (!raw || /^(app|https?|data|vault|file|mailto):/i.test(raw) || raw.startsWith('/')) return null;
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		/* 保留原文 */
	}
	const name = decoded.split(/[\\/]/).pop() ?? '';
	if (!IMG_EXT_RE.test(extOf(name))) return null;
	const parts = baseDir.split(/[\\/]/).filter(Boolean);
	const tail = decoded.split('/').join('\\');
	for (let i = parts.length; i >= 0; i--) {
		const dir = parts.slice(0, i).join('\\');
		const candidate = dir ? `${dir}\\${tail}` : tail;
		if (exists(candidate)) return externalImgUrl(candidate);
	}
	return null;
}

export function anchorRelativeImgSrcs(
	md: string,
	host: BlockRenderHost,
	tokens: ImgAnchorToken[],
): string {
	const file = host.file;
	if (!file) return md; // 片段场景无基准目录，维持现状
	// 库外文件(挂载树打开):host.file 是种子笔记,其目录不可信——以
	// externalAbs 所在目录为基准解析。否则锚定整个失效,src 漏给全局模糊
	// 匹配,被库内同名图片劫持(实测:库外 NLP 笔记被别的笔记的截图顶替)。
	const ext = host as { isExternal?: boolean; externalAbs?: string };
	const externalBase =
		ext.isExternal === true && ext.externalAbs ? externalBaseDir(ext.externalAbs) : null;
	const rewrite = (m: string, pre: string, src: string, post: string): string => {
		let url: string | null = null;
		if (externalBase) {
			url = resolveExternalImgUrl(src, externalBase);
		} else {
			const resolved = resolveVaultImgUrl(src, file, host);
			url = resolved ? host.app.vault.getResourcePath(resolved) : null;
		}
		if (!url) return m;
		const token = `${IMG_ANCHOR_PREFIX}${tokens.length}${IMG_ANCHOR_PREFIX}`;
		tokens.push({ token, url });
		return `${pre}${token}${post}`;
	};
	return md
		.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, rewrite)
		.replace(/(<img\b[^>]*?\bsrc=')([^']*)(')/gi, rewrite);
}

/** 库内解析:md 所在目录 → 逐级父目录 → 库根(用户指定顺序),再退
 * getFirstLinkpathDest(sourcePath 感知);全未命中返回 null。 */
function resolveVaultImgUrl(raw: string, file: TFile, host: BlockRenderHost): TFile | null {
	if (!raw || /^(app|https?|data|vault|file|mailto):/i.test(raw) || raw.startsWith('/')) return null;
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		/* 保留原文 */
	}
	const dir = file.parent?.path ?? '';
	const parts = dir.split('/');
	for (let i = parts.length; i >= 0; i--) {
		const base = parts.slice(0, i).join('/');
		const p = base ? `${base}/${decoded}` : decoded;
		const found = host.app.vault.getAbstractFileByPath(p);
		if (found instanceof TFile && IMG_EXT_RE.test(found.extension)) return found;
	}
	const dest = host.app.metadataCache.getFirstLinkpathDest(decoded, file.path);
	if (dest instanceof TFile && IMG_EXT_RE.test(dest.extension)) return dest;
	return null;
}

/** 渲染后：把 token src 恢复为锚定文件的资源 URL(库内 app://,库外 blob)。 */
export function applyAnchoredImgSrcs(
	holder: HTMLElement,
	_host: BlockRenderHost,
	tokens: ImgAnchorToken[],
): void {
	if (!tokens.length) return;
	holder.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
		const src = img.getAttribute('src') || '';
		const m = IMG_ANCHOR_RE.exec(src);
		if (!m) return;
		const entry = tokens[Number(m[1])];
		if (entry?.url) {
			img.setAttribute('src', entry.url);
		}
	});
}

function enhanceTables(holder: HTMLElement, b: Block, host: BlockRenderHost): void {
  if (!hasTable(b.text)) return;
  // Skip tables that are part of a query result (read-only by design) or that
  // live inside a rendered code block.
  for (const table of [...holder.querySelectorAll('table')] as HTMLTableElement[]) {
    if (table.closest('.block-query-table-wrap, .lgp-code-block, .dataview-missing')) continue;
    enhanceTable(table, b, host);
  }
}

/**
 * Image resize (native editor parity): each rendered <img> gets a hover
 * corner handle at its bottom-right; dragging resizes the image live and on
 * drop writes the width back into the block text — `![alt|W](path)` /
 * `![[path|W]]` for markdown forms, a zoom-percentage update for raw HTML
 * <img style="zoom:X%"> images. Render-only until the drop commits through
 * the block model.
 */
function enhanceImages(holder: HTMLElement, b: Block, host: BlockRenderHost): void {
  const imgs = [...holder.querySelectorAll('img')];
  imgs.forEach((img, index) => {
    if (img.closest('.lgp-img-wrap')) return;
    const wrap = document.createElement('span');
    wrap.className = 'lgp-img-wrap';
    img.replaceWith(wrap);
    wrap.appendChild(img);
    const corner = wrap.createEl('div', { cls: 'lgp-img-resize-corner' });
    corner.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = img.getBoundingClientRect().width;
      const natural = img.naturalWidth || startW;
      wrap.addClass('resizing');
      const move = (ev: MouseEvent): void => {
        const w = Math.max(24, Math.min(2000, Math.round(startW + (ev.clientX - startX))));
        img.style.width = w + 'px';
        img.style.height = 'auto';
        img.style.maxWidth = 'none';
      };
      const up = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        wrap.removeClass('resizing');
        const w = Math.max(24, Math.min(2000, Math.round(startW + (ev.clientX - startX))));
        if (Math.abs(w - startW) < 2) return; // a click, not a resize
        host.mutate(
          () => {
            writeImageWidth(b, index, w, natural);
          },
          () => ({ subtree: b }),
        );
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  });
}

/**
 * Write a resized width back into the block text: the `index`-th image
 * construct (md image / wiki embed / raw HTML zoom img, in text order)
 * gains the width — `![alt|W](path)`, `![[path|W]]`, or an updated
 * `zoom:X%` on the HTML tag.
 */
function writeImageWidth(b: Block, index: number, width: number, natural: number): void {
  let count = -1;
  const RE = /!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]|<img[^>]*style="[^"]*zoom:\s*[\d.]+%[^"]*"[^>]*>/g;
  b.text = b.text.replace(RE, (m) => {
    count++;
    if (count !== index) return m;
    if (m.startsWith('![') && !m.startsWith('![[')) {
      return m.replace(/^!\[([^\]]*)\]/, (_x, alt: string) => `![${alt.replace(/\|\d+$/, '')}|${width}]`);
    }
    if (m.startsWith('![[')) {
      return m.replace(/\|\d+\]\]$/, ']]').replace(/\]\]$/, `|${width}]]`);
    }
    const zoom = natural > 0 ? Math.round((width / natural) * 100) : 100;
    return m.replace(/zoom:\s*[\d.]+%/i, `zoom:${zoom}%`);
  });
}

function enhanceCodeBlocks(holder: HTMLElement, b: Block, host: BlockRenderHost): void {
  const pres = holder.querySelectorAll<HTMLPreElement>('pre');
  if (!pres.length) return;
  // 阅读态 = Monaco colorize 的静态 HTML(与编辑态同一个分词器/同一套主题),
  // 零编辑器实例;聚焦编辑时才建实例(见 codeBlockEdit)。围栏信息取自块文本
  // 解析 —— 单围栏块(纯/混合)用它(源码模式偏移、提交重裹都靠它);多围栏/
  // 围栏后有内容的块合成只读信息,编辑走通用编辑器(与既有行为一致)。
  const info = parseCodeFence(b.text);
  const single = pres.length === 1 && info ? info : null;
  for (const pre of pres) {
    if (pre.closest('.lgp-code-block')) continue;
    const code = pre.querySelector('code');
    const lang = /language-([\w#+-]+)/.exec(code?.className ?? '')?.[1] ?? '';
    const wrap = document.createElement('div');
    wrap.className = 'lgp-code-block';
    pre.replaceWith(wrap);
    mountCodeBlockReadOnly(wrap, b, lang, single ?? syntheticFenceInfo(lang, code?.textContent ?? pre.textContent ?? ''), host, pre);
  }
}

function wireContentEvents(holder: HTMLElement, b: Block, host: BlockRenderHost): void {
  // mousedown runs BEFORE the browser moves focus and before the click event,
  // so it is the only point where the block being edited is still recorded as
  // `focusedBlock`. See `captureRangeAnchor` for why the click handler cannot
  // read it any more.
  holder.addEventListener('mousedown', (e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) host.captureRangeAnchor(e);
  });
  holder.addEventListener('click', (e) => {
    // Logseq parity: a #tag IS a page reference — click opens the page
    // (creating it when missing) instead of Obsidian's tag search.
    const tagAnchor = (e.target as HTMLElement).closest('a.tag');
    if (tagAnchor) {
      e.preventDefault();
      e.stopPropagation();
      const href = decodeURIComponent(tagAnchor.getAttribute('href') ?? '');
      const tag = (href.replace(/^#/, '') || (tagAnchor.textContent ?? '').replace(/^#/, '')).trim();
      if (tag) host.openLink(tag);
      return;
    }
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor) {
      e.preventDefault();
      e.stopPropagation();
      const href = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
      if (!href) return;
      if (anchor.hasClass('internal-link') || anchor.getAttribute('data-href')) {
        host.openLink(href);
      } else {
        window.open(href, '_blank');
      }
      return;
    }
    if ((e.target as HTMLElement).closest('.block-ref')) {
      e.stopPropagation();
      return; // block-ref has its own handler
    }
    // Anything inside an embedded block belongs to the embed box itself —
    // never turn a click there into "edit the host block's raw source".
    if ((e.target as HTMLElement).closest('.block-embed')) return;
    // Shift/Ctrl+click anywhere on the content = multi-select (no editing).
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      host.selectFromClick(b, e);
      return;
    }
    // Plain click on block text: start editing at click position.
    host.focusBlockFromClick(b, e);
  });
}

/** The page-properties block: the doc's FIRST block, empty text. */
function isPropsBlock(b: Block, host: BlockRenderHost): boolean {
  return host.doc.blocks[0] === b && b.kind === 'list' && (b.text === '' || b.frontmatter === true);
}

/**
 * The page-properties block renders its props AS its content — the same
 * dimmed `key:: value` lines the editor shows, so the editing and reading
 * states look alike (Logseq parity).
 */
function renderPropsAsContent(content: HTMLElement, b: Block, host: BlockRenderHost): void {
  content.empty();
  const box = content.createEl('div', { cls: 'block-content-static block-props-content' });
  if (b.frontmatter) {
    // Obsidian-format page properties: the frontmatter body lines verbatim
    // (key: value — one per line; lists/comments render as-is), dimmed like
    // the editor's property lines. Keys and simple values are pages.
    for (const line of b.text.split('\n')) {
      const m = /^([A-Za-z][A-Za-z0-9_-]*):( ?(.*))?$/.exec(line);
      if (!m) {
        box.createEl('div', { cls: 'block-prop-item block-prop-raw', text: line });
        continue;
      }
      renderPropLine(box, m[1], m[3] ?? '', host, ': ');
    }
    // Clicks on the props lines must still open the editor (same as any block).
    wireContentEvents(box, b, host);
    return;
  }
  for (const [k, v] of Object.entries(b.props).filter(([k]) => !WRAP_PROPS_SKIP.has(k))) {
    renderPropLine(box, k, v, host);
  }
  // Clicks on the props lines must still open the editor (same as any block).
  wireContentEvents(box, b, host);
}

/** Refresh one block's static content in place (after blur-commit). */
export function refreshBlockContent(b: Block, host: BlockRenderHost): void {
  if (host.focusedBlock === b) return;
  if (isPropsBlock(b, host)) {
    // The props are the content here — re-render the whole wrap.
    patchBlockSubtree(b, host);
    return;
  }
  const wrap = blockElMap.get(b);
  if (!wrap) return;
  const content = wrap.querySelector(':scope > .block-main > .block-content');
  if (!content) return;
  content.empty();
  content.classList.remove('is-editing');
  // No cache invalidation: when the text is unchanged the cached static el is
  // re-attached synchronously (it was only detached, never destroyed).
  attachStaticContent(content as HTMLElement, b, host);
  // The edited text may have changed the block's properties (typed
  // `key:: value` lines are extracted into props on commit).
  syncPropsRow(wrap, b, host);
  // The edited text may have become (or stopped being) a {{query}} block.
  syncQueryContainer(wrap, b, host);
}

/**
 * Incremental render: replace the rendered wrap (whole subtree) of `b` with a
 * fresh one from the model. Returns false when `b` is not currently rendered
 * (virtualized away / zoom ancestor) — callers fall back to a full render.
 */
export function patchBlockSubtree(b: Block, host: BlockRenderHost): boolean {
  const wrap = blockElMap.get(b);
  const parentEl = wrap?.parentElement ?? null;
  if (!wrap || !parentEl) return false;
  host.destroyFocusedInside(wrap);
  const fresh = renderBlock(b, host);
  parentEl.replaceChild(fresh, wrap);
  scheduleGuideCalibration(host);
  return true;
}

/**
 * Incremental render: rebuild the child list of `parent` (null = root list;
 * the zoomed block's children also live at the root level). When the parent's
 * chrome (caret / children container) no longer matches the model — e.g. it
 * gained its first child — its whole subtree is rebuilt instead.
 */
export function patchSiblingList(parent: Block | null, host: BlockRenderHost): boolean {
  if (parent === null || parent === host.zoomedBlock) {
    renderBlockTree(host.contentTreeEl, host.visibleRoots, host);
    return true;
  }
  const wrap = blockElMap.get(parent);
  if (!wrap) return false; // not rendered (virtualized / above the zoom root)
  const collapsed = parent.props['collapsed'] === 'true';
  // A `view::` block renders a view INSTEAD of a child list — there is no
  // `.block-children-container` to patch, so rebuild the parent's wrap.
  if (isViewBlock(parent.props)) return patchBlockSubtree(parent, host);
  const kidsEl = wrap.querySelector(':scope > .block-children-container > .block-children');
  if (!kidsEl || collapsed || parent.children.length === 0) {
    return patchBlockSubtree(parent, host); // chrome changed: rebuild parent wrap
  }
  host.destroyFocusedInside(kidsEl as HTMLElement);
  const frag = document.createDocumentFragment();
  for (const c of parent.children) frag.appendChild(renderBlock(c, host));
  (kidsEl as HTMLElement).empty();
  kidsEl.appendChild(frag);
  scheduleGuideCalibration(host);
  return true;
}

/**
 * Incremental patches rebuild wraps with guide lines at the CSS approximation;
 * same-height patches never trigger the container ResizeObserver, so the lines
 * would STAY approximated. Recalibrate before the next paint (rAF runs
 * pre-paint: the approximation is never shown).
 */
function scheduleGuideCalibration(host: BlockRenderHost): void {
  requestAnimationFrame(() => {
    const el = host.contentTreeEl;
    if (el && el.isConnected) layoutGuideLines(el);
  });
}

/** Drop content cache entries for all blocks (full reload). */
export function clearAllBlockCaches(roots: Block[]): void {
  const walk = (b: Block) => {
    forgetBlockCache(b);
    b.children.forEach(walk);
  };
  roots.forEach(walk);
}
