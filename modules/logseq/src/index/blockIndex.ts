/**
 * Vault-wide block index: block id → owning block, per-block metadata
 * (marker / tags / links) for embedded queries, and a reverse link index
 * (page → referencing blocks) for the backlinks panel.
 *
 * Obsidian's metadataCache does not index Logseq-style `id::` property lines,
 * so we maintain our own index with incremental updates on modify/rename/delete.
 */

import { TFile, debounce, type App, type EventRef } from 'obsidian';
import { registerLogseqPageProps, clearLogseqPageProps } from '../pagePropsRegistry';
import { normalizeLinkTarget, type QueryBlock } from '../features/query';
import {
  lookupSupertag,
  normalizeTag,
  supertagDefFrom,
  type SupertagDef,
  type SupertagRegistry,
} from '../features/supertags';
import { extractFile } from './fileFacts';

export type IndexedBlock = QueryBlock & {
  /**
   * EVERY block property, not just the query-relevant subset in `props`.
   * Supertag collections read their columns' values from here, and
   * `props` stays narrow so `{{query-table}}` columns are unchanged.
   */
  blockProps: Record<string, string>;
  /** Owning id of the parent block ('' at the top level). Powers the Prolog
   *  `parent/2` and `ancestor/2` facts. */
  parentId: string;
};

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
  /**
   * Effective refs of the referencing block (normalized page names): its own
   * `[[links]]` / `#tags`, everything inherited from its ANCESTORS (a child of
   * a linked block is linked too) and the page it lives on — so a filter can
   * select by source page as well. Mirrors Logseq's `effective-refs`.
   */
  refs: string[];
}

export class BlockIndex {
  /** Bumped after every rebuild — consumers cache query results against it. */
  version = 0;

  private byId = new Map<string, IndexedBlock>();
  /** Block-level backlinks: referenced block id → referencing blocks. */
  private refsTo = new Map<string, BacklinkEntry[]>();
  private all: IndexedBlock[] = [];
  private tagsByPath = new Map<string, Set<string>>();
  /** normalized page target → referencing blocks */
  private backlinks = new Map<string, BacklinkEntry[]>();
  private cards: CardEntry[] = [];
  /** Supertag definitions keyed by normalized tag name (see supertags.ts). */
  private supertags: SupertagRegistry = new Map();
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

  /**
   * Every tag that carries a field template, i.e. whose own page declares
   * properties (`Person.md` with `last name::` makes `#Person` a supertag).
   * Plain tag pages contribute no definition and are absent here.
   */
  supertagRegistry(): SupertagRegistry {
    return this.supertags;
  }

  /** The definition for one tag, or null when it is an ordinary tag. */
  supertagDef(name: string): SupertagDef | null {
    return lookupSupertag(this.supertags, name);
  }

  /**
   * Blocks carrying `tag` — the supertag's "collection" (Tana) / the table on
   * a new-tag page (Logseq DB). Includes blocks that only INHERIT the tag from
   * an ancestor, matching how the template is resolved.
   */
  supertagInstances(tag: string): IndexedBlock[] {
    const t = normalizeTag(tag);
    if (!t) return [];
    return this.all.filter((b) => b.tags.includes(t));
  }

  /** Blocks from other files that link to `path` (matched by basename). */
  backlinksTo(path: string): BacklinkEntry[] {
    const target = normalizeLinkTarget(path);
    const self = path.toLowerCase();
    return (this.backlinks.get(target) ?? []).filter((e) => e.sourcePath.toLowerCase() !== self);
  }

  /** Blocks that reference the given block id via ((id)) — excluding self-references. */
  refsToBlock(id: string): BacklinkEntry[] {
    if (!id) return [];
    const self = this.byId.get(id);
    return (this.refsTo.get(id) ?? []).filter((e) => !self || e.sourcePath !== self.path || e.blockId !== id);
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
    this.refsTo.clear();
    this.cards = [];
    this.supertags = new Map();
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

  /**
   * Materialize one file's markdown into this index. The parsing itself lives
   * in `fileFacts.extractFile` — the shared extractor — so the SQLite index
   * and this one always agree on what a file means.
   */
  private indexContent(path: string, content: string): void {
    const facts = extractFile(path, content);
    // Vault-wide Logseq page-props registry (usually only open files are
    // registered by their view): feeds the per-page `editor` property and
    // the getFileCache frontmatter merge for never-opened files too.
    registerLogseqPageProps(path, facts.pageProps);
    this.tagsByPath.set(path, new Set(facts.tags));
    // A block inherits its ancestors' refs, and its own page counts as a ref
    // too (Logseq's `own-refs` / `effective-refs`), so a filter can select
    // references by the page they live on.
    const pageRef = facts.page;

    // A page whose own properties declare fields/parents IS the supertag
    // definition for its name (Logseq DB: the tag page holds the template).
    // A page with no properties contributes nothing — plain tags stay plain.
    const def = supertagDefFrom(pageRef, facts.pageProps);
    if (def) this.supertags.set(def.name, def);

    // `effective` refs are folded top-down; the extractor emits blocks in
    // document order, so a parent's refs are always already known.
    const refsByKey = new Map<string, string[]>();
    for (const bf of facts.blocks) {
      const inherited = bf.parentKey ? refsByKey.get(bf.parentKey) ?? [] : [];
      const effective = [...new Set([...inherited, ...bf.links, ...bf.tags, pageRef])];
      refsByKey.set(bf.bkey, effective);

      const ib: IndexedBlock = {
        path,
        blockId: bf.id,
        text: bf.text,
        marker: bf.marker,
        tags: bf.tags,
        links: bf.links,
        props: bf.props,
        blockProps: bf.blockProps,
        parentId: bf.parentId,
      };
      this.all.push(ib);
      if (bf.id) this.byId.set(bf.id, ib);
      // Flashcards: any block tagged #card (children = answer side).
      if (bf.isCard) {
        this.cards.push({
          path,
          blockId: bf.id,
          question: bf.text,
          answer: bf.answer,
          marker: bf.marker,
          props: { ...bf.blockProps },
        });
      }
      for (const l of bf.links) {
        const list = this.backlinks.get(l) ?? [];
        list.push({ sourcePath: path, blockId: bf.id, text: bf.text, marker: bf.marker, refs: effective });
        this.backlinks.set(l, list);
      }
      for (const refId of bf.refs) {
        const list = this.refsTo.get(refId) ?? [];
        list.push({ sourcePath: path, blockId: bf.id, text: bf.text, marker: bf.marker, refs: effective });
        this.refsTo.set(refId, list);
      }
    }
  }

  private forgetFile(path: string): void {
    clearLogseqPageProps(path);
    this.all = this.all.filter((b) => b.path !== path);
    this.cards = this.cards.filter((c) => c.path !== path);
    for (const [id, info] of this.byId) {
      if (info.path === path) this.byId.delete(id);
    }
    this.tagsByPath.delete(path);
    // This page may have been a supertag definition; drop it so a rename or
    // delete can't leave a ghost template behind (rebuild re-adds if it still
    // exists under a new name).
    this.supertags.delete(normalizeLinkTarget(path));
    for (const [target, list] of this.refsTo) {
      const filtered = list.filter((e) => e.sourcePath !== path);
      if (filtered.length === 0) this.refsTo.delete(target);
      else if (filtered.length !== list.length) this.refsTo.set(target, filtered);
    }
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
