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

import { MarkdownRenderer, setIcon } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import type { Block } from '../types';
import { blockId } from '../types';
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

export function renderBlockTree(container: HTMLElement, roots: Block[], host: BlockEditorView): void {
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
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
  for (const b of roots) {
    if (budget && (budget.left <= 0 || budget.stopped)) {
      budget.stopped = true;
      break;
    }
    if (budget) budget.left--;
    frag.appendChild(renderBlock(b, host, budget));
  }
  container.appendChild(frag);

  // Logseq parity: the empty area under the last block is an add-block
  // affordance — hovering shows a faint line + plus, clicking appends and
  // focuses a new block at the end of the visible outline.
  container
    .createEl('div', { cls: 'block-editor-addblock' })
    .addEventListener('click', (e) => {
      e.stopPropagation();
      host.addBlockAtEnd();
    });

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
}

function renderBlock(b: Block, host: BlockEditorView, budget?: RenderBudget): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'block-wrap' + (b.kind === 'raw' ? ' block-raw' : '');
  if (host.selectedBlocks.has(b)) wrap.classList.add('is-selected');
  const id = blockId(b);
  if (id) wrap.dataset.blockId = id;
  blockElMap.set(b, wrap);
  blockOfEl.set(wrap, b);

  const main = wrap.createEl('div', { cls: 'block-main' });

  // --- controls ---
  const controls = main.createEl('div', { cls: 'block-controls' });
  if (b.kind === 'list') {
    controls.setAttribute('draggable', 'true'); // block drag handle zone
    // Reserved slot where the floating caret appears (kept in flow so the
    // bullet column aligns across sibling rows; the caret itself floats).
    controls.createEl('div', { cls: 'block-caret-spacer' });
    if (b.children.length > 0) {
      const collapsed = b.props['collapsed'] === 'true';
      const caret = controls.createEl('div', {
        cls: 'block-caret' + (collapsed ? ' is-collapsed' : ''),
      });
      caret.innerHTML = CARET_SVG;
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        host.toggleCollapse(b);
      });
    }
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
  } else {
    controls.createEl('div', { cls: 'block-caret-spacer' });
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
  if (host.focusedBlock === b) {
    content.classList.add('is-editing');
    // CM6 gets mounted here by the view after the tree render pass.
    host.mountFocusedInto(content);
  } else if (isPropsBlock(b, host)) {
    // The page-properties block renders its props AS the content — the same
    // `key:: value` lines the editor shows, so both states look alike.
    renderPropsAsContent(content, b, host);
  } else {
    attachStaticContent(content, b, host);
  }

  // --- children: the guide line hangs from the bullet dot and doubles as a
  // collapse toggle (click = fold the content inside it). Folded blocks render
  // NO container/line at all — expansion lives on the always-visible caret. ---
  const collapsed = b.props['collapsed'] === 'true';
  const kidsVisible = b.children.length > 0 && !collapsed;
  if (kidsVisible && (!budget || budget.left > 0)) {
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

  return wrap;
}

const WRAP_PROPS_SKIP = new Set(['id', 'collapsed', 'style']);

/**
 * One `key:: value` line under a block (Logseq parity): dimmed like the
 * editor's property lines, and BOTH the key and the value are pages —
 * clicking either opens/creates that page.
 */
function renderPropLine(parent: HTMLElement, k: string, v: string, host: BlockEditorView, sep = ':: '): void {
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
function syncPropsRow(wrap: HTMLElement, b: Block, host: BlockEditorView, editing = false): void {
  wrap.querySelector(':scope > .block-props-row')?.remove();
  // While the block is being edited the props show as text lines in the
  // editor itself — the row would duplicate them.
  if (editing) return;
  const entries = Object.entries(b.props).filter(([k]) => !WRAP_PROPS_SKIP.has(k));
  if (entries.length === 0) return;
  const row = wrap.createEl('div', { cls: 'block-props-row' });
  // Logseq parity: props sit directly under the block text, BEFORE its children.
  wrap.querySelector(':scope > .block-main')?.insertAdjacentElement('afterend', row);
  for (const [k, v] of entries) renderPropLine(row, k, v, host);
}

/** True when the block body is a single {{query ...}} / {{query-table ...}} expression. */
function isQueryBlock(b: Block, host: BlockEditorView): boolean {
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
function syncQueryContainer(wrap: HTMLElement, b: Block, host: BlockEditorView): void {
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
function renderQueryResults(b: Block, host: BlockEditorView): HTMLElement {
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
function renderQueryList(b: Block, host: BlockEditorView): HTMLElement {
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
function renderQueryTable(b: Block, host: BlockEditorView): HTMLElement {
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

function queryResultItem(r: IndexedBlock, host: BlockEditorView): HTMLElement {
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
export function refreshQueryBlocks(container: HTMLElement, host: BlockEditorView): void {
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

/** Render static content with cache reuse when the block text is unchanged. */
function attachStaticContent(content: HTMLElement, b: Block, host: BlockEditorView): void {
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
  const pageEmbedTokens: { token: string; page: string }[] = [];
  const hasPageEmbed = /!\[\[[^\[\]]+\]\]/.test(b.text);
  const mdSource = withTableSeparation(
    hasPageEmbed
      ? b.text.replace(/!\[\[([^\[\]]+)\]\]/g, (_m, page: string) => {
          const token = `LGPAGEEMBED${pageEmbedTokens.length}LGPAGEEMBED`;
          pageEmbedTokens.push({ token, page });
          return token;
        })
      : b.text,
  );
  MarkdownRenderer.render(host.app, mdSource, holder, host.file?.path ?? '', host).then(() => {
    if (host.renderGeneration !== gen) return; // stale (file switched)
    wireContentEvents(holder, b, host);
    if (!holder.hasClass('block-dataview')) {
      // Embeds FIRST: `{{embed ((id))}}` contains an inner `((id))` that
      // enhanceBlockRefs would otherwise turn into a chip, splitting the text
      // node so the embed pattern no longer matches.
      enhanceEmbeds(holder, host);
      enhanceCodeBlocks(holder);
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
 * the code text and flashes a check mark.
 */
function enhanceCodeBlocks(holder: HTMLElement): void {
  for (const pre of holder.querySelectorAll('pre')) {
    if (pre.closest('.lgp-code-block')) continue;
    const code = pre.querySelector('code');
    const lang = /language-([\w#+-]+)/.exec(code?.className ?? '')?.[1] ?? '';
    if (code) enhanceCodeTokens(code);
    const wrap = document.createElement('div');
    wrap.className = 'lgp-code-block';
    pre.replaceWith(wrap);
    const bar = wrap.createDiv({ cls: 'lgp-code-toolbar' });
    if (lang) bar.createEl('span', { cls: 'lgp-code-lang', text: lang });
    const btn = bar.createEl('span', { cls: 'lgp-code-copy', attr: { 'aria-label': 'Copy code' } });
    setIcon(btn, 'copy');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void navigator.clipboard
        .writeText(code?.textContent ?? pre.textContent ?? '')
        .then(() => {
          setIcon(btn, 'check');
          setTimeout(() => setIcon(btn, 'copy'), 1200);
        })
        .catch(() => {});
    });
    wrap.appendChild(pre);
  }
}

/**
 * Fill the syntax-coloring gap between the reading render and the editor:
 * Prism's grammars leave function calls as plain text (`TensorDataset(x, y)`,
 * `torch.randn(100, 1)` — every identifier but keywords/strings/numbers), so
 * most of a code block reads as one color while the CM6 editor colors calls.
 * Conservative fix-up: wrap a trailing identifier in `.token.function` when
 * the next sibling is the call's `(` punctuation span. Text inside existing
 * tokens (strings, comments, keywords — anything `.token`) is never touched;
 * render-only, the block model and the saved file stay untouched.
 */
function enhanceCodeTokens(code: HTMLElement): void {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? '';
    if (!/[A-Za-z_$][\w$]*\s*$/.test(text)) continue;
    if ((n.parentElement)?.closest('.token')) continue; // inside a string/comment/keyword
    const next = n.nextSibling;
    if (next?.nodeType !== Node.ELEMENT_NODE) continue;
    const el = next as HTMLElement;
    if (!(el.classList.contains('token') && el.textContent?.startsWith('('))) continue;
    targets.push(n as Text);
  }
  for (const node of targets) {
    const text = node.textContent ?? '';
    const m = /([A-Za-z_$][\w$]*)(\s*)$/.exec(text);
    if (!m) continue;
    const span = document.createElement('span');
    span.className = 'token function';
    span.textContent = m[1];
    node.textContent = text.slice(0, text.length - m[0].length);
    const tail = document.createTextNode(m[2]);
    const parent = node.parentNode;
    if (!parent) continue;
    parent.insertBefore(span, node.nextSibling);
    parent.insertBefore(tail, span.nextSibling);
  }
}

function wireContentEvents(holder: HTMLElement, b: Block, host: BlockEditorView): void {
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
function isPropsBlock(b: Block, host: BlockEditorView): boolean {
  return host.doc.blocks[0] === b && b.kind === 'list' && (b.text === '' || b.frontmatter === true);
}

/**
 * The page-properties block renders its props AS its content — the same
 * dimmed `key:: value` lines the editor shows, so the editing and reading
 * states look alike (Logseq parity).
 */
function renderPropsAsContent(content: HTMLElement, b: Block, host: BlockEditorView): void {
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
export function refreshBlockContent(b: Block, host: BlockEditorView): void {
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
export function patchBlockSubtree(b: Block, host: BlockEditorView): boolean {
  const wrap = blockElMap.get(b);
  const parentEl = wrap?.parentElement ?? null;
  if (!wrap || !parentEl) return false;
  host.destroyFocusedInside(wrap);
  const fresh = renderBlock(b, host);
  parentEl.replaceChild(fresh, wrap);
  return true;
}

/**
 * Incremental render: rebuild the child list of `parent` (null = root list;
 * the zoomed block's children also live at the root level). When the parent's
 * chrome (caret / children container) no longer matches the model — e.g. it
 * gained its first child — its whole subtree is rebuilt instead.
 */
export function patchSiblingList(parent: Block | null, host: BlockEditorView): boolean {
  if (parent === null || parent === host.zoomedBlock) {
    renderBlockTree(host.contentTreeEl, host.visibleRoots, host);
    return true;
  }
  const wrap = blockElMap.get(parent);
  if (!wrap) return false; // not rendered (virtualized / above the zoom root)
  const collapsed = parent.props['collapsed'] === 'true';
  const kidsEl = wrap.querySelector(':scope > .block-children-container > .block-children');
  if (!kidsEl || collapsed || parent.children.length === 0) {
    return patchBlockSubtree(parent, host); // chrome changed: rebuild parent wrap
  }
  host.destroyFocusedInside(kidsEl as HTMLElement);
  const frag = document.createDocumentFragment();
  for (const c of parent.children) frag.appendChild(renderBlock(c, host));
  (kidsEl as HTMLElement).empty();
  kidsEl.appendChild(frag);
  return true;
}

/** Drop content cache entries for all blocks (full reload). */
export function clearAllBlockCaches(roots: Block[]): void {
  const walk = (b: Block) => {
    forgetBlockCache(b);
    b.children.forEach(walk);
  };
  roots.forEach(walk);
}
