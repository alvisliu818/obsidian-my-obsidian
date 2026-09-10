/**
 * Vault-wide block index: block id → owning block, per-block metadata
 * (marker / tags / links) for embedded queries, and a reverse link index
 * (page → referencing blocks) for the backlinks panel.
 *
 * Obsidian's metadataCache does not index Logseq-style `id::` property lines,
 * so we maintain our own index with incremental updates on modify/rename/delete.
 */

import { TFile, debounce, type App, type EventRef } from 'obsidian';
import { parseDocument } from '../core/parser';
import { serializeBlock } from '../core/serializer';
import type { Block } from '../types';
import { normalizeLinkTarget, type QueryBlock } from '../features/query';

export type IndexedBlock = QueryBlock;

/** A flashcard: any block tagged #card. Children are the answer side. */
export interface CardEntry {
  path: string;
  blockId: string;
  question: string;
  /** Serialized child blocks (the answer side); '' for cloze-only cards. */
  answer: string;
  marker: string | null;
  /** Full block props (incl. memory-* scheduling keys). */
  props: Record<string, string>;
}

export interface BacklinkEntry {
  sourcePath: string;
  /** Owning block id ('' when the referencing block has no id). */
  blockId: string;
  text: string;
  marker: string | null;
}

const TAG_RE = /(?:^|[\s(])#([\p{L}\d][\p{L}\d_/-]*)/gu;
const LINK_RE = /\[\[([^\]]+)\]\]/g;

function collectTags(text: string): string[] {
  const bare = text.replace(LINK_RE, ' '); // tags inside [[...]] don't count
  return [...new Set([...bare.matchAll(TAG_RE)].map((m) => m[1].toLowerCase()))];
}

function collectLinks(text: string): string[] {
  return [...new Set([...text.matchAll(LINK_RE)].map((m) => normalizeLinkTarget(m[1])))].filter(Boolean);
}

export class BlockIndex {
  /** Bumped after every rebuild — consumers cache query results against it. */
  version = 0;

  private byId = new Map<string, IndexedBlock>();
  private all: IndexedBlock[] = [];
  private tagsByPath = new Map<string, Set<string>>();
  /** normalized page target → referencing blocks */
  private backlinks = new Map<string, BacklinkEntry[]>();
  private cards: CardEntry[] = [];
  private listeners = new Set<() => void>();
  private rebuild: () => void;
  private building: Promise<void> | null = null;

  constructor(private app: App) {
    this.rebuild = debounce(() => void this.buildAll(), 2000, true);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  get(id: string): IndexedBlock | null {
    return this.byId.get(id) ?? null;
  }

  /** Blocks that own an `id::` property (navigable via ((block refs))). */
  withIds(): IndexedBlock[] {
    return [...this.byId.values()];
  }

  /** Every indexed block (query pool). */
  allBlocks(): IndexedBlock[] {
    return this.all;
  }

  allTags(): string[] {
    const all = new Set<string>();
    for (const set of this.tagsByPath.values()) for (const t of set) all.add(t);
    return [...all].sort();
  }

  /** Blocks from other files that link to `path` (matched by basename). */
  backlinksTo(path: string): BacklinkEntry[] {
    const target = normalizeLinkTarget(path);
    const self = path.toLowerCase();
    return (this.backlinks.get(target) ?? []).filter((e) => e.sourcePath.toLowerCase() !== self);
  }

  /** All #card flashcards in the vault. */
  allCards(): CardEntry[] {
    return this.cards;
  }

  /** Subscribe to index rebuilds; returns a disposer. */
  onRebuild(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ------------------------------------------------------------------
  // Building
  // ------------------------------------------------------------------

  /** Full rebuild; concurrent calls coalesce into one run. */
  buildAll(): Promise<void> {
    if (this.building) return this.building;
    this.building = this.doBuildAll().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async doBuildAll(): Promise<void> {
    this.byId.clear();
    this.all = [];
    this.tagsByPath.clear();
    this.backlinks.clear();
    this.cards = [];
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      let content: string;
      try {
        content = await this.app.vault.cachedRead(f);
      } catch {
        continue;
      }
      if (content.length > 2_000_000) continue; // skip huge files
      this.indexContent(f.path, content);
    }
    this.version++;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        /* listener errors must not break the rebuild loop */
      }
    }
  }

  private indexContent(path: string, content: string): void {
    const doc = parseDocument(content);
    const tags = new Set<string>();
    this.tagsByPath.set(path, tags);

    const walk = (b: Block) => {
      const id = b.props['id'];
      const text = b.text.split('\n')[0] ?? '';
      const bTags = collectTags(b.text);
      const bLinks = collectLinks(b.text);
      // Query-relevant properties only (priority/scheduled/deadline).
      const props: Record<string, string> = {};
      for (const k of ['priority', 'scheduled', 'deadline'] as const) {
        if (b.props[k] !== undefined) props[k] = b.props[k];
      }
      const ib: IndexedBlock = {
        path,
        blockId: id ?? '',
        text,
        marker: b.marker,
        tags: bTags,
        links: bLinks,
        props,
      };
      this.all.push(ib);
      if (id) this.byId.set(id, ib);
      // Flashcards: any block tagged #card (children = answer side).
      if (bTags.includes('card')) {
        this.cards.push({
          path,
          blockId: id ?? '',
          question: text,
          answer: b.children.map((c) => serializeBlock(c, 1)).join('\n'),
          marker: b.marker,
          props: { ...b.props },
        });
      }
      for (const t of bTags) tags.add(t);
      for (const l of bLinks) {
        const list = this.backlinks.get(l) ?? [];
        list.push({ sourcePath: path, blockId: id ?? '', text, marker: b.marker });
        this.backlinks.set(l, list);
      }
      b.children.forEach(walk);
    };
    doc.blocks.forEach(walk);
  }

  private forgetFile(path: string): void {
    this.all = this.all.filter((b) => b.path !== path);
    this.cards = this.cards.filter((c) => c.path !== path);
    for (const [id, info] of this.byId) {
      if (info.path === path) this.byId.delete(id);
    }
    this.tagsByPath.delete(path);
    for (const [target, list] of this.backlinks) {
      const filtered = list.filter((e) => e.sourcePath !== path);
      if (filtered.length === 0) this.backlinks.delete(target);
      else if (filtered.length !== list.length) this.backlinks.set(target, filtered);
    }
  }

  /** Wire vault events via the plugin so they are cleaned up on unload. */
  attach(plugin: { registerEvent: (eventRef: EventRef) => void }): void {
    plugin.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') this.rebuild();
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.forgetFile(oldPath);
          this.rebuild();
        }
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) this.forgetFile(file.path);
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile && file.extension === 'md') this.rebuild();
      }),
    );
  }
}
