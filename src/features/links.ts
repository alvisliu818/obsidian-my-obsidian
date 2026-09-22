/**
 * Link-related editing features:
 * - CM6 autocomplete sources: [[wiki links]], #tags, ((block references))
 * - Static render enhancement: ((uuid)) text → clickable block-ref chips
 * - {{embed ((uuid))}} → embedded block sub-trees (click to edit in place)
 */

import { MarkdownRenderer, TFile } from 'obsidian';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { BlockEditorView } from '../view/BlockEditorView';
import { blockSummary } from '../types';
import { slashMenuSource } from './slashMenu';
import { parseDocument } from '../core/parser';
import { blockAtPath, findBlockById, linkParents, pathToRoot } from '../core/treeOps';
import type { Block } from '../types';

const BLOCK_REF_RE = /\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)/g;
const EMBED_RE = /\{\{embed\s*\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)\}\}/g;

// ---------------------------------------------------------------------------
// Autocomplete sources
// ---------------------------------------------------------------------------

export function autocompleteSources(host: BlockEditorView, embed = false): CompletionSource[] {
  return [
    wikiLinkSource(host),
    tagSource(host),
    blockRefSource(host),
    slashMenuSource(host, embed),
  ];
}

function wikiLinkSource(host: BlockEditorView): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\[\[[^\[\]]*$/);
    if (!before) return null;
    const query = before.text.slice(2).toLowerCase();
    const files = host.app.vault.getMarkdownFiles();
    const options: Completion[] = [];
    for (const f of files) {
      const label = f.basename;
      if (query && !label.toLowerCase().includes(query)) continue;
      options.push({
        label,
        type: 'text',
        apply: (view, _c, from, to) => {
          view.dispatch({ changes: { from, to, insert: `[[${label}]] ` } });
        },
      });
      if (options.length >= 50) break;
    }
    if (options.length === 0) return null;
    return { from: before.from, options, validFor: /^\[\[[^\[\]]*$/ };
  };
}

function tagSource(host: BlockEditorView): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/#[\p{L}\d_\/-]*$/u);
    if (!before) return null;
    const query = before.text.slice(1).toLowerCase();
    const tags = host.plugin.blockIndex?.allTags() ?? [];
    const options: Completion[] = [];
    for (const t of tags) {
      if (query && !t.toLowerCase().includes(query)) continue;
      options.push({
        label: '#' + t,
        type: 'text',
        apply: (view, _c, from, to) => {
          view.dispatch({ changes: { from, to, insert: `#${t} ` } });
        },
      });
    }
    if (options.length === 0) return null;
    return { from: before.from, options, validFor: /^#[\p{L}\d_\/-]*$/u };
  };
}

function blockRefSource(host: BlockEditorView): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\(\([^)]*$/);
    if (!before) return null;
    const query = before.text.slice(2).toLowerCase();
    const blocks = host.plugin.blockIndex?.withIds() ?? [];
    const options: Completion[] = [];
    for (const b of blocks) {
      const label = b.text || b.blockId;
      if (query && !label.toLowerCase().includes(query) && !b.blockId.includes(query)) continue;
      options.push({
        label: blockSummary({ text: label, children: [], props: {}, parent: null, kind: 'list', marker: null }),
        detail: b.path,
        type: 'text',
        apply: (view, _c, from, to) => {
          view.dispatch({ changes: { from, to, insert: `((${b.blockId}))` } });
        },
      });
      if (options.length >= 50) break;
    }
    if (options.length === 0) return null;
    return { from: before.from, options, validFor: /^\(\([^)]*$/ };
  };
}

// ---------------------------------------------------------------------------
// Static render enhancement: ((uuid)) → clickable chips
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
      chip.textContent = info ? info.text || '(empty block)' : `((${id.slice(0, 8)}…))`;
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
// {{embed ((uuid))}} → embedded sub-tree; click to edit the source in place
// ---------------------------------------------------------------------------

/** Where an embedded block lives, what to render and what to edit. */
export interface EmbedSource {
  /** The embedded block (root of the embedded sub-tree). */
  block: Block;
  /** Location breadcrumb: [file, …ancestors], root first. */
  crumbs: string[];
  /** Container file; null = the file currently open in this view. */
  file: TFile | null;
  /** Block id of the embedded root (the embed target). */
  id: string;
}

/** Resolved source of each rendered embed box (used for in-place editing). */
const embedSources = new WeakMap<HTMLElement, EmbedSource>();
/** Each rendered row of an embed body → the block it renders (path-aware). */
const embedRows = new WeakMap<HTMLElement, { src: EmbedSource; path: number[] }>();
/** Runtime-only collapsed state of embedded sub-trees (per block object). */
const embedCollapsed = new WeakSet<Block>();

/** Same caret glyph as the main outline (kept local to avoid a module cycle). */
const EMBED_CARET_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>`;

/** Replace {{embed ((uuid))}} text with live embedded block containers. */
export function enhanceEmbeds(el: HTMLElement, host: BlockEditorView): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; matches: RegExpMatchArray[] }[] = [];
  let cur = walker.nextNode() as Text | null;
  while (cur) {
    const m = [...(cur.data.matchAll(EMBED_RE))];
    if (m.length > 0) targets.push({ node: cur, matches: m });
    cur = walker.nextNode() as Text | null;
  }
  for (const { node, matches } of targets) {
    const value = node.data;
    let lastIdx = 0;
    const frag = document.createDocumentFragment();
    for (const m of matches) {
      const uuid = m[1];
      const idx = m.index ?? 0;
      if (idx > lastIdx) frag.appendChild(document.createTextNode(value.slice(lastIdx, idx)));
      frag.appendChild(createEmbedBox(uuid, host));
      lastIdx = idx + m[0].length;
    }
    if (lastIdx < value.length) frag.appendChild(document.createTextNode(value.slice(lastIdx)));
    node.replaceWith(frag);
  }
}

/** One embed box: breadcrumb header + markdown body; click the body to edit. */
function createEmbedBox(uuid: string, host: BlockEditorView): HTMLElement {
  const box = document.createElement('div');
  box.className = 'block-embed';
  box.addEventListener('click', (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!t) return;
    // The embed owns EVERY click inside it. Without this the click bubbles up
    // to the host block, which would swap the box for the raw
    // `{{embed ((uuid))}}` source (and kill the in-place editor).
    e.stopPropagation();
    // The CM6 editor (when open) and inner links / chips / the breadcrumb own
    // their clicks — never re-mount the editor from a click inside it.
    if (t.closest('.embed-row.is-editing')) return;
    if (t.closest('a') || t.closest('.block-ref') || t.closest('.block-embed-header')) return;
    const src = embedSources.get(box);
    if (!src) {
      // Still resolving → ignore; only a broken embed jumps to the source.
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
  box.createEl('div', { cls: 'embed-loading', text: '⏳ embedding…' });
  const src = await resolveEmbed(uuid, host);
  box.empty();
  if (!src) {
    embedSources.delete(box);
    box.addClass('is-broken');
    box.createEl('div', { cls: 'embed-error', text: `block not found ((${uuid.slice(0, 8)}…))` });
    return;
  }
  embedSources.set(box, src);
  renderEmbedHeader(box, src, uuid, host);
  const body = box.createEl('div', { cls: 'block-embed-body' });
  // Rendered row by row: every row remembers the block it shows so a click
  // edits that block instead of always the root of the sub-tree.
  renderEmbedRow(body, src.block, [], src, host);
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
  } else {
    controls.createEl('div', { cls: 'block-caret-spacer' });
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

/** Breadcrumb showing where the embedded block lives; click → open the source. */
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
    if (i > 0) head.createEl('span', { cls: 'embed-bc-sep', text: '›' });
    head.createEl('span', { cls: 'embed-bc-crumb', text: label || '…' });
  });
  head.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void host.plugin.openBlockRef(uuid);
  });
}

/**
 * Resolve an embed target. This file is checked first (freshest — includes
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

/** [file, …ancestors] labels for the embed breadcrumb (root first). */
function crumbsFor(b: Block, fileLabel: string): string[] {
  return [fileLabel, ...pathToRoot(b).slice(0, -1).map(blockSummary)];
}
