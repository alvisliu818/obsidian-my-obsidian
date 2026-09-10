/**
 * Link-related editing features:
 * - CM6 autocomplete sources: [[wiki links]], #tags, ((block references))
 * - Static render enhancement: ((uuid)) text → clickable block-ref chips
 * - {{embed ((uuid))}} → inline embedded block sub-trees
 */

import { MarkdownRenderer, TFile } from 'obsidian';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { BlockEditorView } from '../view/BlockEditorView';
import { blockSummary } from '../types';
import { slashMenuSource } from './slashMenu';
import { parseDocument } from '../core/parser';
import { findBlockById, linkParents } from '../core/treeOps';
import { serializeBlockContent } from '../core/serializer';
import type { Block } from '../types';

const BLOCK_REF_RE = /\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)/g;
const EMBED_RE = /\{\{embed\s*\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)\}\}/g;

// uuid → rendered sub-tree markdown, keyed by index version (cache invalidation)
const embedCache = new Map<string, { version: number; md: string }>();
/** Embeds being resolved right now — breaks A→B→A reference cycles. */
const resolvingEmbeds = new Set<string>();

// ---------------------------------------------------------------------------
// Autocomplete sources
// ---------------------------------------------------------------------------

export function autocompleteSources(host: BlockEditorView): CompletionSource[] {
  return [wikiLinkSource(host), tagSource(host), blockRefSource(host), slashMenuSource(host)];
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
// {{embed ((uuid))}} → inline embedded sub-tree
// ---------------------------------------------------------------------------

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
      const box = document.createElement('div');
      box.className = 'block-embed';
      void renderEmbedInto(box, uuid, host);
      frag.appendChild(box);
      lastIdx = idx + m[0].length;
    }
    if (lastIdx < value.length) frag.appendChild(document.createTextNode(value.slice(lastIdx)));
    node.replaceWith(frag);
  }
}

/** Resolve an embedded block (local file first, then vault-wide) and render it. */
async function renderEmbedInto(box: HTMLElement, uuid: string, host: BlockEditorView): Promise<void> {
  box.createEl('div', { cls: 'embed-loading', text: '⏳ embedding…' });
  const md = await resolveEmbedMarkdown(uuid, host);
  box.empty();
  if (md === null) {
    box.addClass('is-broken');
    box.createEl('div', { cls: 'embed-error', text: `block not found ((${uuid.slice(0, 8)}…))` });
  } else {
    const gen = host.renderGeneration;
    await MarkdownRenderer.render(host.app, md, box, host.file?.path ?? '', host);
    if (host.renderGeneration !== gen) return; // stale: file switched mid-render
    enhanceBlockRefs(box, host);
  }
  box.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor) return; // let inner links work through their own handlers
    e.stopPropagation();
    void host.plugin.openBlockRef(uuid);
  });
}

/** Get the embedded block's markdown sub-tree; null when unresolvable. */
async function resolveEmbedMarkdown(uuid: string, host: BlockEditorView): Promise<string | null> {
  const idx = host.plugin.blockIndex;
  const version = idx?.version ?? 0;
  const cached = embedCache.get(uuid);
  if (cached && cached.version === version) return cached.md;

  // 1) Same file (freshest — includes unsaved edits; never cached).
  const local = findBlockById(host.doc.blocks, uuid);
  if (local) return serializeBlockContent(local);

  // 2) Other files via the index.
  let block: Block | null = null;
  if (idx) {
    const info = idx.get(uuid);
    if (info) {
      const f = host.app.vault.getAbstractFileByPath(info.path);
      if (f instanceof TFile) {
        if (resolvingEmbeds.has(uuid)) return null; // cycle guard
        resolvingEmbeds.add(uuid);
        try {
          const data = await host.app.vault.cachedRead(f);
          const doc = parseDocument(data);
          linkParents(doc.blocks);
          block = findBlockById(doc.blocks, uuid);
        } finally {
          resolvingEmbeds.delete(uuid);
        }
      }
    }
  }
  if (!block) return null;
  const md = serializeBlockContent(block);
  embedCache.set(uuid, { version, md });
  return md;
}
