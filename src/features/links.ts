/**
 * Link-related editing features:
 * - CM6 autocomplete sources: [[wiki links]], #tags, ((block references))
 * - Static render enhancement: ((uuid)) text 鈫?clickable block-ref chips
 * - {{embed ((uuid))}} 鈫?embedded block sub-trees (click to edit in place)
 */

import { MarkdownRenderer, TFile, Notice, setIcon } from 'obsidian';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { BlockEditorView } from '../view/BlockEditorView';
import { blockSummary } from '../types';
import { parseDocument } from '../core/parser';
import { serializeDocument } from '../core/serializer';
import { blockAtPath, findBlockById, linkParents, pathToRoot, pseudoRootOf, registerRoots } from '../core/treeOps';
import { slashMenuSource } from './slashMenu';
import type { Block } from '../types';

const BLOCK_REF_RE = /\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)/g;
const EMBED_RE = /\{\{embed\s*\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)\}\}/g;
/** Page embed: ![[Page Name]] 鈥?embeds the WHOLE page (all top-level blocks). */
const PAGE_EMBED_RE = /!\[\[([^\[\]|]+)\]\]/g;

// ---------------------------------------------------------------------------
// Autocomplete sources
// ---------------------------------------------------------------------------

export function autocompleteSources(host: BlockEditorView, embed = false): CompletionSource[] {
  // The main editor's `/` commands use the self-drawn command menu
  // (commandMenu.ts); offering the CM6 slash source there would open TWO
  // menus on `/`. The in-place embed editor has no self-drawn menu, so it
  // gets the slash source (with block-model commands filtered out).
  return embed
    ? [wikiLinkSource(host), tagSource(host), blockRefSource(host), slashMenuSource(host, embed)]
    : [wikiLinkSource(host), tagSource(host), blockRefSource(host)];
}

export function wikiLinkSource(host: BlockEditorView): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    // Supports BOTH triggers: `[[` (plain link) and `![[` (page embed, Logseq
    // md parity). `from` must sit AFTER the trigger brackets: CM6 filters the
    // options against the text between the returned `from` and the cursor, so
    // including the brackets in the range would filter every option away
    // (page names never contain `[[`) and no popup would ever show.
    const before = ctx.matchBefore(/!?\[\[[^\[\]]*$/);
    if (!before) return null;
    const from = before.from + before.text.lastIndexOf('[[') + 2;
    const query = ctx.state.sliceDoc(from, ctx.pos).toLowerCase();
    const files = host.app.vault.getMarkdownFiles();
    const options: Completion[] = [];
    for (const f of files) {
      const label = f.basename;
      if (query && !label.toLowerCase().includes(query)) continue;
      options.push({
        label,
        type: 'text',
        apply: (view, _c, f, to) => {
          // The typed `[[` / `![[` stays; only the name region is replaced.
          view.dispatch({ changes: { from: f, to, insert: `${label}]] ` } });
        },
      });
      if (options.length >= 50) break;
    }
    if (options.length === 0) return null;
    return { from, options, validFor: /^[^\[\]|]*$/ };
  };
}

export function tagSource(host: BlockEditorView): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/#[\p{L}\d_\/-]*$/u);
    if (!before) return null;
    const from = before.from + 1; // filter range starts after the '#'
    const query = ctx.state.sliceDoc(from, ctx.pos).toLowerCase();
    const tags = host.plugin.blockIndex?.allTags() ?? [];
    const options: Completion[] = [];
    for (const t of tags) {
      if (query && !t.toLowerCase().includes(query)) continue;
      options.push({
        // `label` is what CM6 filters against (bare tag); displayLabel adds
        // the '#' back for display.
        label: t,
        displayLabel: '#' + t,
        type: 'text',
        apply: (view, _c, f, to) => {
          view.dispatch({ changes: { from: f, to, insert: `${t} ` } });
        },
      });
    }
    if (options.length === 0) return null;
    return { from, options, validFor: /^[\p{L}\d_\/-]*$/u };
  };
}

export function blockRefSource(host: BlockEditorView): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    // `((id))` refs and the `{{embed ((id))}}` form share one trigger; the
    // embed variant closes with `}}` instead of `))`.
    const before =
      ctx.matchBefore(/\{\{embed\s*\(\([^)]*$/i) ?? ctx.matchBefore(/\(\([^)]*$/);
    if (!before) return null;
    const from = before.from + before.text.lastIndexOf('((') + 2;
    const query = ctx.state.sliceDoc(from, ctx.pos).toLowerCase();
    const inEmbed = /^\{\{embed/i.test(before.text);
    const blocks = host.plugin.blockIndex?.withIds() ?? [];
    const options: Completion[] = [];
    for (const b of blocks) {
      const label = b.text || b.blockId;
      // Filter on the label only: CM6 fuzzy-filters the options against the
      // label too, so id-only matches would just be dropped again there.
      if (query && !label.toLowerCase().includes(query)) continue;
      options.push({
        label: blockSummary({ text: label, children: [], props: {}, parent: null, kind: 'list', marker: null }),
        detail: b.path,
        type: 'text',
        apply: (view, _c, f, to) => {
          view.dispatch({ changes: { from: f, to, insert: `${b.blockId}))${inEmbed ? '}}' : ''}` } });
        },
      });
      if (options.length >= 50) break;
    }
    if (options.length === 0) return null;
    return { from, options, validFor: /^[^)]*$/ };
  };
}

// ---------------------------------------------------------------------------
// Static render enhancement: ((uuid)) 鈫?clickable chips
// ---------------------------------------------------------------------------

export function enhanceBlockRefs(el: HTMLElement, host: BlockEditorView): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; matches: RegExpMatchArray[] }[] = [];
  let cur = walker.nextNode() as Text | null;
  while (cur) {
    const m = [...(cur.data.matchAll(BLOCK_REF_RE))];
    if (m.length > 0) targets.push({ node: cur, matches: m });
    cur = walker.nextNode() as Text | null;
  }
  for (const { node, matches } of targets) {
    const value = node.data;
    let lastIdx = 0;
    const frag = document.createDocumentFragment();
    for (const m of matches) {
      const id = m[1];
      const idx = m.index ?? 0;
      if (idx > lastIdx) frag.appendChild(document.createTextNode(value.slice(lastIdx, idx)));
      const info = host.plugin.blockIndex?.get(id);
      const chip = document.createElement('span');
      chip.className = 'block-ref';
      chip.textContent = info ? info.text || '(empty block)' : `((${id.slice(0, 8)}鈥?)`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        host.plugin.openBlockRef(id);
      });
      frag.appendChild(chip);
      lastIdx = idx + m[0].length;
    }
    if (lastIdx < value.length) {
      frag.appendChild(document.createTextNode(value.slice(lastIdx)));
    }
    node.replaceWith(frag);
  }
}

// ---------------------------------------------------------------------------
// {{embed ((uuid))}} 鈫?embedded sub-tree; click to edit the source in place
// ---------------------------------------------------------------------------

/** Where an embedded block lives, what to render and what to edit. */
export interface EmbedSource {
  /** The embedded block (root of the embedded sub-tree). */
  block: Block;
  /** Location breadcrumb: [file, 鈥ncestors], root first. */
  crumbs: string[];
  /** Container file; null = the file currently open in this view. */
  file: TFile | null;
  /** Block id of the embedded root (the embed target). */
  id: string;
}

/** Resolved source of each rendered embed box (used for in-place editing). */
const embedSources = new WeakMap<HTMLElement, EmbedSource>();
/** Each rendered row of an embed body 鈫?the block it renders (path-aware). */
const embedRows = new WeakMap<HTMLElement, { src: EmbedSource; path: number[] }>();
/** Runtime-only collapsed state of embedded sub-trees (per block object). */
const embedCollapsed = new WeakSet<Block>();

/** Same caret glyph as the main outline (kept local to avoid a module cycle). */
const EMBED_CARET_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>`;

/** Replace {{embed ((uuid))}} text with live embedded block containers. */
export function enhanceEmbeds(el: HTMLElement, host: BlockEditorView): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; matches: RegExpMatchArray[]; kind: 'block' | 'page' }[] = [];
  let cur = walker.nextNode() as Text | null;
  while (cur) {
    const pageM = [...(cur.data.matchAll(PAGE_EMBED_RE))];
    if (pageM.length > 0) {
      targets.push({ node: cur, matches: pageM, kind: 'page' });
    } else {
      const m = [...(cur.data.matchAll(EMBED_RE))];
      if (m.length > 0) targets.push({ node: cur, matches: m, kind: 'block' });
    }
    cur = walker.nextNode() as Text | null;
  }
  for (const { node, matches, kind } of targets) {
    const value = node.data;
    let lastIdx = 0;
    const frag = document.createDocumentFragment();
    for (const m of matches) {
      const key = m[1];
      const idx = m.index ?? 0;
      if (idx > lastIdx) frag.appendChild(document.createTextNode(value.slice(lastIdx, idx)));
      frag.appendChild(kind === 'page' ? createPageEmbedBox(key, host) : createEmbedBox(key, host));
      lastIdx = idx + m[0].length;
    }
    if (lastIdx < value.length) frag.appendChild(document.createTextNode(value.slice(lastIdx)));
    node.replaceWith(frag);
  }
}

/**
 * Page-embed box (![[Page Name]]): renders ALL top-level blocks of the source
 * page (click a row to edit that block in place), plus an "add block" input
 * row at the bottom 鈥?Enter appends a new block to the SOURCE page through
 * the guarded write path (backup + operation log).
 */
/**
 * Page-embed box (![[Page Name]]): renders ALL top-level blocks of the source
 * page (click a row to edit that block in place), plus an "add block" input
 * row at the bottom — Enter appends a new block to the SOURCE page through
 * the guarded write path (backup + operation log). Exported for renderTree,
 * which protects ![[ ]] from markdown rendering via tokens and swaps the
 * placeholders for live boxes afterwards.
 */
export function createPageEmbedBox(pageName: string, host: BlockEditorView): HTMLElement {
  const box = document.createElement('div');
  box.className = 'block-embed block-page-embed';
  box.addEventListener('click', (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!t) return;
    e.stopPropagation();
    if (t.closest('.embed-row.is-editing')) return;
    if (t.closest('a') || t.closest('.block-embed-header')) return;
    const row = t.closest('.embed-row') as HTMLElement | null;
    if (!row) return;
    const hit = embedRows.get(row);
    if (hit) host.startEmbedEdit(row, hit.src, hit.path);
  });
  void renderPageEmbedInto(box, pageName, host);
  return box;
}

/** (Re)render a page-embed box: header + every top-level block + add-row. */
export async function renderPageEmbedInto(
  box: HTMLElement,
  pageName: string,
  host: BlockEditorView,
): Promise<void> {
  box.empty();
  box.classList.remove('is-broken');
  box.createEl('div', { cls: 'embed-loading', text: 'embedding...' });
  const file = host.app.vault.getMarkdownFiles().find(
    (f) => f.basename.toLowerCase() === pageName.trim().toLowerCase(),
  );
  box.empty();
  if (!file) {
    box.addClass('is-broken');
    box.createEl('div', { cls: 'embed-error', text: `page not found: ![[${pageName}]]` });
    return;
  }
  // Header: page icon + name (click to jump to the source page).
  const header = box.createEl('div', { cls: 'block-embed-header' });
  const icon = header.createEl('span', { cls: 'embed-header-icon' });
  setIcon(icon, 'file-text');
  const title = header.createEl('span', { cls: 'embed-header-title', text: file.basename });
  title.addEventListener('click', () => {
    void host.app.workspace.openLinkText(file.path, '', false);
  });
  const data = await host.app.vault.cachedRead(file);
  const doc = parseDocument(data);
  linkParents(doc.blocks);
  renderPageEmbedBody(box, file, doc.blocks, host);
}

export function renderPageEmbedBody(
  box: HTMLElement,
  file: TFile,
  blocks: Block[],
  host: BlockEditorView,
): void {
  box.empty();
  box.classList.remove('is-broken');
  // Header: page icon + name (click to jump to the source page).
  const header = box.createEl('div', { cls: 'block-embed-header' });
  const icon = header.createEl('span', { cls: 'embed-header-icon' });
  setIcon(icon, 'file-text');
  const title = header.createEl('span', { cls: 'embed-header-title', text: file.basename });
  title.addEventListener('click', () => {
    void host.app.workspace.openLinkText(file.path, '', false);
  });
  const body = box.createEl('div', { cls: 'block-embed-body' });
  // Register roots so in-place editing of these rows resolves siblings.
  registerRoots(blocks);
  // Paths address top-level blocks by index (blocks may lack id:: props —
  // page-embed rows are addressed by path, never by findBlockById).
  const pseudoSrc: EmbedSource = {
    block: pseudoRootOf(blocks),
    crumbs: [file.basename],
    file,
    id: '',
  };
  blocks.forEach((b, i) => renderEmbedRow(body, b, [i], pseudoSrc, host));
}

/**
 * Refresh a page-embed box from the freshest source available: the live model
 * of an open block-editor view for that file, else the file on disk.
 */
export async function refreshPageEmbedBox(
  host: BlockEditorView,
  box: HTMLElement,
  file: TFile,
): Promise<void> {
  const open = host.findOpenBlockEditor(file.path);
  if (open) {
    renderPageEmbedBody(box, file, open.doc.blocks, host);
    return;
  }
  const data = await host.app.vault.cachedRead(file);
  const doc = parseDocument(data);
  linkParents(doc.blocks);
  renderPageEmbedBody(box, file, doc.blocks, host);
}

/** One embed box: breadcrumb header + markdown body; click the body to edit. */
function createEmbedBox(uuid: string, host: BlockEditorView): HTMLElement {
  const box = document.createElement('div');
  box.className = 'block-embed';
  box.setAttribute('data-uuid', uuid);
  box.addEventListener('click', (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!t) return;
    // The embed owns EVERY click inside it. Without this the click bubbles up
    // to the host block, which would swap the box for the raw
    // `{{embed ((uuid))}}` source (and kill the in-place editor).
    e.stopPropagation();
    // The CM6 editor (when open) and inner links / chips / the breadcrumb own
    // their clicks 鈥?never re-mount the editor from a click inside it.
    if (t.closest('.embed-row.is-editing')) return;
    if (t.closest('a') || t.closest('.block-ref') || t.closest('.block-embed-header')) return;
    const src = embedSources.get(box);
    if (!src) {
      // Still resolving 鈫?ignore; only a broken embed jumps to the source.
      if (box.hasClass('is-broken')) void host.plugin.openBlockRef(uuid);
      return;
    }
    // Clicking a row edits THAT block of the embedded sub-tree (rows carry
    // their child-index path); clicking elsewhere edits the root row.
    const row =
      (t.closest('.embed-row') as HTMLElement | null) ??
      (box.querySelector('.embed-row') as HTMLElement | null);
    if (!row) return;
    const hit = embedRows.get(row);
    host.startEmbedEdit(row, src, hit?.path ?? []);
  });
  void renderEmbedInto(box, uuid, host);
  return box;
}

/** (Re)render an embed box: breadcrumb header + markdown body. */
export async function renderEmbedInto(
  box: HTMLElement,
  uuid: string,
  host: BlockEditorView,
): Promise<void> {
  box.empty();
  box.classList.remove('is-editing');
  box.removeClass('is-broken');
  box.createEl('div', { cls: 'embed-loading', text: 'embedding...' });
  const src = await resolveEmbed(uuid, host);
  box.empty();
  if (!src) {
    embedSources.delete(box);
    box.addClass('is-broken');
    box.createEl('div', { cls: 'embed-error', text: `block not found ((${uuid.slice(0, 8)}))` });
    return;
  }
  embedSources.set(box, src);
  renderEmbedHeader(box, src, uuid, host);
  const body = box.createEl('div', { cls: 'block-embed-body' });
  // Rendered row by row: every row remembers the block it shows so a click
  // edits that block instead of always the root of the sub-tree.
  renderEmbedRow(body, src.block, [], src, host);
}

/**
 * Re-render a block-embed box from an explicit source (a live model), e.g.
 * when the source page is open in another block-editor view and disk is
 * stale. Same structure as renderEmbedInto without re-resolving.
 */
export function renderEmbedBodyFrom(
  box: HTMLElement,
  src: EmbedSource,
  uuid: string,
  host: BlockEditorView,
): void {
  embedSources.set(box, src);
  box.empty();
  box.classList.remove('is-editing');
  box.removeClass('is-broken');
  renderEmbedHeader(box, src, uuid, host);
  const body = box.createEl('div', { cls: 'block-embed-body' });
  renderEmbedRow(body, src.block, [], src, host);
}

/** The EmbedSource a rendered embed box was built from (null when unresolved). */
export function getEmbedSource(box: HTMLElement): EmbedSource | null {
  return embedSources.get(box) ?? null;
}

/** The source a rendered embed ROW belongs to (block and page-embed rows). */
export function getEmbedRowSource(row: HTMLElement): EmbedSource | null {
  return embedRows.get(row)?.src ?? null;
}

/**
 * Find the rendered embed row at the given child-index path (relative to the
 * embedded root). `[]` = the root row. Rows register themselves in
 * `embedRows`; structural staleness (paths shifted after an insert) is
 * handled by re-rendering the whole box before this lookup.
 */
export function findEmbedRow(box: HTMLElement, path: number[]): HTMLElement | null {
  const rows = [...box.querySelectorAll('.embed-row')];
  for (const r of rows) {
    const hit = embedRows.get(r as HTMLElement);
    if (hit && hit.path.length === path.length && hit.path.every((v, i) => v === path[i])) {
      return r as HTMLElement;
    }
  }
  return null;
}

/** One row of an embedded sub-tree (recursively for its children). */
function renderEmbedRow(
  parent: HTMLElement,
  b: Block,
  path: number[],
  src: EmbedSource,
  host: BlockEditorView,
): HTMLElement {
  const row = parent.createEl('div', { cls: 'embed-row' });
  row.setAttribute('title', 'Click to edit this block');
  embedRows.set(row, { src, path });

  // Outline chrome: caret (when children) + bullet, mirroring the main tree.
  const main = row.createEl('div', { cls: 'embed-main' });
  const controls = main.createEl('div', { cls: 'embed-controls' });
  const hasKids = b.children.length > 0;
  const collapsed = embedCollapsed.has(b);
  if (hasKids) {
    if (collapsed) row.addClass('is-collapsed');
    const caret = controls.createEl('div', {
      cls: 'block-caret' + (collapsed ? ' is-collapsed' : ''),
    });
    caret.innerHTML = EMBED_CARET_SVG;
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (embedCollapsed.has(b)) embedCollapsed.delete(b);
      else embedCollapsed.add(b);
      rerenderEmbedRow(row, src, path, host);
    });
  }
  controls.createEl('div', { cls: 'block-bullet' });

  const content = main.createEl('div', { cls: 'embed-content' });
  const gen = host.renderGeneration;
  void MarkdownRenderer.render(host.app, b.text, content, host.file?.path ?? '', host).then(() => {
    if (host.renderGeneration !== gen) return; // stale: file switched
    enhanceBlockRefs(content, host);
  });

  if (hasKids && !collapsed) {
    const kids = row.createEl('div', { cls: 'embed-children' });
    b.children.forEach((c, i) => renderEmbedRow(kids, c, [...path, i], src, host));
  }
  return row;
}

/** Rebuild one row of an embed in place (after an edit / collapse toggle). */
export function rerenderEmbedRow(
  row: HTMLElement,
  src: EmbedSource,
  path: number[],
  host: BlockEditorView,
): void {
  const parent = row.parentElement;
  if (!parent) return;
  const b = blockAtPath(src.block, path) ?? src.block;
  const fresh = renderEmbedRow(parent, b, path, src, host);
  row.replaceWith(fresh);
}

/**
 * Write-through view of an embed source page: parse (cached read), apply
 * `fn` to the parsed tree, serialize back through the guarded write path
 * (backup + operation log). Used by page-embed row edits and Enter-adds.
 */
export async function mutatePageEmbedSource(
  host: BlockEditorView,
  file: TFile,
  fn: (doc: ReturnType<typeof parseDocument>) => void,
): Promise<boolean> {
  try {
    const data = await host.app.vault.cachedRead(file);
    const doc = parseDocument(data);
    linkParents(doc.blocks);
    fn(doc);
    const out = serializeDocument(doc);
    return await host.plugin.backups.safeProcess(file, () => out, 'embed.source.write');
  } catch (e) {
    new Notice(`Failed to update ${file.basename}: ${String(e)}`);
    return false;
  }
}

/** Find the currently rendered embed box (block embed) holding `uuid`. */
export function findEmbedBox(host: BlockEditorView, uuid: string): HTMLElement | null {
  const tree = host.contentTreeEl;
  return (
    (tree.querySelector(`.block-embed[data-uuid="${uuid}"]`) as HTMLElement | null) ??
    (tree.querySelector('.block-embed') as HTMLElement | null)
  );
}

/**
 * Re-render an embed box in place (structure changed on the source side).
 * Resolves when the box has been re-rendered (rows re-registered).
 */
export function refreshEmbedBox(host: BlockEditorView, box: HTMLElement, uuid: string): Promise<void> {
  return renderEmbedInto(box, uuid, host);
}

/** Breadcrumb showing where the embedded block lives; click 鈫?open the source. */
function renderEmbedHeader(
  box: HTMLElement,
  src: EmbedSource,
  uuid: string,
  host: BlockEditorView,
): void {
  const head = box.createEl('div', { cls: 'block-embed-header' });
  head.setAttribute('title', 'Open the source block');
  const crumbs = src.crumbs.length > 0 ? src.crumbs : ['(unknown)'];
  crumbs.forEach((label, i) => {
    if (i > 0) head.createEl('span', { cls: 'embed-bc-sep', text: '>' });
    head.createEl('span', { cls: 'embed-bc-crumb', text: label || '?' });
  });
  head.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void host.plugin.openBlockRef(uuid);
  });
}

/**
 * Resolve an embed target. This file is checked first (freshest 鈥?includes
 * unsaved edits); otherwise the block is read from the vault so it can be
 * edited in place and written back.
 */
async function resolveEmbed(uuid: string, host: BlockEditorView): Promise<EmbedSource | null> {
  const local = findBlockById(host.doc.blocks, uuid);
  if (local) {
    return {
      block: local,
      crumbs: crumbsFor(local, host.file?.basename ?? ''),
      file: null,
      id: uuid,
    };
  }
  const info = host.plugin.blockIndex?.get(uuid);
  if (!info) {
    // Index miss: the vault may have been scanned before this file existed.
    // One targeted retry after a short wait (layout-ready race), then give up
    // with the is-broken state.
    await new Promise((r) => setTimeout(r, 300));
    const retry = host.plugin.blockIndex?.get(uuid);
    if (!retry) return null;
    return resolveFromIndex(retry, uuid, host);
  }
  return resolveFromIndex(info, uuid, host);
}

/** Build an EmbedSource from an index hit: parse the owning file, walk to the block. */
async function resolveFromIndex(
  info: { path: string },
  uuid: string,
  host: BlockEditorView,
): Promise<EmbedSource | null> {
  const file = host.app.vault.getAbstractFileByPath(info.path);
  if (!(file instanceof TFile)) return null;
  const doc = parseDocument(await host.app.vault.cachedRead(file));
  linkParents(doc.blocks);
  const b = findBlockById(doc.blocks, uuid);
  if (!b) return null;
  return { block: b, crumbs: crumbsFor(b, file.basename), file, id: uuid };
}

/** [file, 鈥ncestors] labels for the embed breadcrumb (root first). */
function crumbsFor(b: Block, fileLabel: string): string[] {
  return [fileLabel, ...pathToRoot(b).slice(0, -1).map(blockSummary)];
}



/**
 * Find the embed row rendering `target` (by model identity) inside `box`,
 * with its addressing info — used to re-open the in-place editor on a row
 * after the box re-renders (Tab indent inside embeds).
 */
export function findEmbedRowForBlock(
  box: HTMLElement,
  target: Block,
): { row: HTMLElement; src: EmbedSource; path: number[] } | null {
  for (const rowEl of Array.from(box.querySelectorAll<HTMLElement>('.embed-row'))) {
    const reg = embedRows.get(rowEl);
    if (!reg) continue;
    let b: Block | null = reg.src.block;
    for (const i of reg.path) b = b?.children[i] ?? null;
    if (b === target) return { row: rowEl, src: reg.src, path: reg.path };
  }
  return null;
}
