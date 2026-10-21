/**
 * Vault-wide block index: block id → owning block, per-block metadata
 * (marker / tags / links) for embedded queries, and a reverse link index
 * (page → referencing blocks) for the backlinks panel.
 *
 * Obsidian's metadataCache does not index Logseq-style `id::` property lines,
 * so we maintain our own index with incremental updates on modify/rename/delete.
 */

import { TAbstractFile, TFile, debounce, type App, type EventRef } from 'obsidian';
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
  /**
   * Blocks grouped by owning file, so a signature rebuild after an edit costs
   * one file instead of the vault. Kept in lockstep with `all`:
   * `indexContent` resets the group, `forgetFile` drops it.
   */
  private blocksByPath = new Map<string, IndexedBlock[]>();
  /** Lazily built 128-bit character signatures, one per file group. See `scanFor`. */
  private fileSig = new Map<string, Uint32Array>();
  private listeners = new Set<() => void>();
  /**
   * Serializes every mutation of the maps above. A full rebuild and a
   * single-file patch both rewrite the same structures, so they must never
   * interleave — a patch landing while `buildAll` is mid-pass would be either
   * wiped by its `clear()` or added twice.
   */
  private queue: Promise<void> = Promise.resolve();
  private building: Promise<void> | null = null;
  /**
   * Paths whose content changed and whose patch is still pending. Editing eight
   * files in two seconds costs eight single-file patches, not eight full
   * rebuilds — and none of them is the vault-wide pass.
   */
  private dirty = new Set<string>();
  private flush: () => void;

  constructor(private app: App) {
    this.flush = debounce(() => void this.flushDirty(), 2000, true);
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

  /**
   * Diagnostics from the last full rebuild. `longestSliceMs` is the number
   * that matters: it is the longest the main thread was ever held without
   * yielding, i.e. the worst stall the UI can see. A one-task rebuild reports
   * one slice the size of the whole build.
   */
  lastBuild = { files: 0, slices: 0, longestSliceMs: 0, slowSlices: 0 };

  /** Subscribe to index rebuilds; returns a disposer. */
  onRebuild(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ------------------------------------------------------------------
  // Unlinked-mention scan (this index owns the data, so it owns the query)
  // ------------------------------------------------------------------

  /**
   * Blocks whose text mentions `title` without linking it — the bottom-of-page
   * "unlinked references" list.
   *
   * The naive form walks every block doing a substring test: ~983k blocks,
   * 132–224ms per section render on the main vault, and it used to be worse
   * (778ms) whenever a rebuild had just swapped all the block objects out.
   *
   * Each file's blocks therefore get a 128-bit character signature: two bits
   * set per character it contains. A candidate must have ALL of the query's
   * character bits set, which is a handful of `&` tests per block and leaves
   * only 0.1–2.2% to string-match — 9–12ms measured. Per-FILE, so editing one
   * note rebuilds one group (sub-millisecond) rather than the vault.
   *
   * The signature can only produce false positives, never false negatives: a
   * block containing the title contains its characters. So the candidate set
   * is always a superset and results stay exact.
   */
  unlinkedMentions(
    title: string,
    currentPath: string,
    max: number,
  ): Array<{ entry: IndexedBlock; count: number }> {
    const q = title.trim().toLowerCase();
    if (q.length < 3) return [];
    const self = currentPath.toLowerCase();
    const masks = queryMasks(q);
    const out: Array<{ entry: IndexedBlock; count: number }> = [];

    // Inlined rather than factored through a generator: this loop runs over
    // ~8.4k file groups per keystroke-driven refresh, and yielding an object
    // per group cost more than the scan it was accelerating.
    for (const [path, blocks] of this.blocksByPath) {
      if (path.toLowerCase() === self) continue;
      let sig = this.fileSig.get(path);
      if (!sig || sig.length !== blocks.length * SIG_WORDS) {
        sig = buildSignatures(blocks);
        this.fileSig.set(path, sig);
      }
      for (let i = 0; i < blocks.length; i++) {
        if (!sigMatches(sig, i, masks)) continue;
        const b = blocks[i];
        const lower = b.text.toLowerCase();
        if (!lower.includes(q)) continue;
        if (b.links.some((l) => l.toLowerCase() === q)) continue;
        out.push({ entry: b, count: lower.split(q).length - 1 });
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Building
  // ------------------------------------------------------------------

  /**
   * Full rebuild; concurrent calls coalesce into one run. This is the vault-wide
   * pass — startup cost only (every file, re-parsed). It must NOT be reachable
   * from the editing path: on a large vault it blocks the main thread for
   * seconds, which is exactly what made opening a file right after an edit
   * stall. File changes go through `markDirty` instead.
   */
  buildAll(): Promise<void> {
    if (this.building) return this.building;
    this.dirty.clear(); // whatever changed will be re-read by rebuild itself
    this.building = this.enqueue(() => this.doBuildAll()).finally(() => {
      this.building = null;
    });
    return this.building;
  }

  /** Run `task` after — never concurrent with — every other index mutation. */
  private enqueue(task: () => void | Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Bump the version and wake every consumer cache keyed against it. */
  private notify(): void {
    this.version++;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        /* listener errors must not break the rebuild loop */
      }
    }
  }

  // ------------------------------------------------------------------
  // Incremental updates (the editing path)
  // ------------------------------------------------------------------

  /**
   * Queue a single-file refresh for the next pause in editing. The file is
   * re-read and re-parsed then, replacing exactly the entries it contributed
   * before — no other file's data is touched, so the cost is one page's worth
   * of parsing (tens of ms) instead of the whole vault's.
   */
  markDirty(path: string): void {
    this.dirty.add(path);
    this.flush();
  }

  private async flushDirty(): Promise<void> {
    if (this.dirty.size === 0) return;
    const paths = [...this.dirty];
    this.dirty.clear();
    await this.enqueue(() => this.doReindex(paths));
  }

  private async doReindex(paths: string[]): Promise<void> {
    let changed = false;
    for (const path of paths) {
      if (await this.reindexOne(path)) changed = true;
    }
    if (changed) this.notify();
  }

  /**
   * Replace one path's contribution. `forgetFile` first removes precisely the
   * entries this path owns (`backlinks`/`refsTo` list entries are keyed by
   * TARGET but filtered by SOURCE path, so other files' cross-references
   * survive untouched), then the current content is indexed fresh. Always
   * returns true — even when the file simply went away, removing its entries
   * is itself a change consumers must see.
   */
  private async reindexOne(path: string): Promise<boolean> {
    // `getAbstractFileByPath` doubles as the existence check — a path that was
    // deleted or renamed after it entered the queue must drop its entries
    // rather than keep serving stale blocks. Optional-chained because trimmed
    // vault doubles in tests implement only getMarkdownFiles/cachedRead.
    const file = this.app.vault.getAbstractFileByPath?.(path) as Partial<TFile> | null | undefined;
    let content: string | null = null;
    if (file && this.notePath(file as TAbstractFile)) {
      try {
        content = await this.app.vault.cachedRead(file as TFile);
      } catch {
        content = null;
      }
    }
    this.forgetFile(path);
    if (content !== null && content.length <= 2_000_000) this.indexContent(path, content);
    // Always a change: removing entries is itself something consumers must see.
    return true;
  }

  /**
   * Build every file's signature ahead of time, so the first time the user
   * expands Unlinked references they get ~10ms instead of paying ~0.5s to
   * build all 8.4k groups right then.
   *
   * Same slicing discipline as `doBuildAll`, because "background" is not the
   * same as "free": ~0.5s of continuous CPU would still be felt. Aborts if the
   * index is rebuilt underneath us — that work is already garbage.
   */
  async prewarmSignatures(): Promise<void> {
    const born = this.version;
    let slice = performance.now();
    for (const [path, blocks] of this.blocksByPath) {
      if (performance.now() - slice >= YIELD_BUDGET_MS) {
        await yieldToBrowser();
        if (this.version !== born) return; // index rebuilt: start over later
        slice = performance.now();
      }
      if (this.fileSig.has(path)) continue;
      this.fileSig.set(path, buildSignatures(blocks));
    }
  }

  /**
   * The path when `file` is a markdown note, else null (folders, attachments).
   * Duck-typed rather than `instanceof TFile` so it also holds under the unit
   * test stub, where TFile is an empty class and files are plain objects.
   */
  private notePath(file: TAbstractFile): string | null {
    const ext = (file as unknown as { extension?: string }).extension;
    return file instanceof TFile || ext === 'md' ? file.path : null;
  }

  private async doBuildAll(): Promise<void> {
    this.byId.clear();
    this.all = [];
    this.tagsByPath.clear();
    this.backlinks.clear();
    this.refsTo.clear();
    this.cards = [];
    this.supertags = new Map();
    this.blocksByPath.clear();
    this.fileSig.clear();
    const files = this.app.vault.getMarkdownFiles();
    // Sliced, not running to completion in one task: see `yieldToBrowser`.
    // Budget by ELAPSED CPU time rather than a file count, so a fat file can't
    // blow the budget on its own and a folder of empty notes can't make us
    // yield every other file.
    let slice = performance.now();
    let slices = 0;
    let longest = 0;
    let slow = 0;
    for (const f of files) {
      let content: string;
      try {
        content = await this.app.vault.cachedRead(f);
      } catch {
        continue;
      }
      if (content.length > 2_000_000) continue; // skip huge files
      this.indexContent(f.path, content);
      const spent = performance.now() - slice;
      if (spent >= YIELD_BUDGET_MS) {
        if (spent > longest) longest = spent;
        // Budget is checked BETWEEN files, so one enormous file is one slice:
        // a 2MB note costs what it costs and cannot be interrupted mid-parse.
        // Counting them separately keeps that honest.
        if (spent > 33) slow++;
        slices++;
        await yieldToBrowser();
        slice = performance.now();
      }
    }
    this.lastBuild = {
      files: files.length,
      slices,
      longestSliceMs: Math.round(longest),
      slowSlices: slow,
    };
    this.notify();
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
    // This path is about to own a fresh set of blocks; anything cached from
    // the previous version (its character signatures above all) is now stale.
    const group: IndexedBlock[] = [];
    this.blocksByPath.set(path, group);
    this.fileSig.delete(path);
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
      group.push(ib);
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
    this.blocksByPath.delete(path);
    this.fileSig.delete(path);
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

  /**
   * Wire vault events via the plugin so they are cleaned up on unload.
   *
   * None of these schedules `buildAll`: on the user's vault that pass costs
   * ~8.4s of the main thread, so running it two seconds after every edit is
   * what froze the app while opening the next file. Create/modify/rename all
   * funnel into `markDirty`, which re-parses only the paths that changed.
   */
  attach(plugin: { registerEvent: (eventRef: EventRef) => void }): void {
    const touch = (file: TAbstractFile): void => {
      const p = this.notePath(file);
      if (p !== null) this.markDirty(p);
    };
    plugin.registerEvent(
      this.app.vault.on('modify', (file) => {
        touch(file);
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        // Drop any pending patch for the old path first: by the time it ran,
        // `oldPath` no longer resolves and would just remove its entries.
        this.dirty.delete(oldPath);
        void this.enqueue(() => {
          this.forgetFile(oldPath);
          this.notify();
        });
        touch(file);
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('delete', (file) => {
        // Deliberately not restricted to markdown: deleting a folder reports
        // each child, and stale entries for any of them survive otherwise.
        this.dirty.delete(file.path);
        void this.enqueue(() => {
          this.forgetFile(file.path);
          this.notify();
        });
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('create', (file) => {
        touch(file);
      }),
    );
  }
}

// ----------------------------------------------------------------------
// Cooperative multitasking
// ----------------------------------------------------------------------

/**
 * How long a single slice may run before handing the thread back — one frame.
 *
 * Deliberately not smaller: slicing is not free. At 8ms the main vault needed
 * ~1000 slices and the rebuild took roughly twice as long end to end, because
 * each yield costs far more than the ~0.1ms a browser message task should
 * (measured ~8.7ms under Node). The worst slice is set by the biggest single
 * file either way — a 2MB note cannot be interrupted mid-parse — so shrinking
 * the budget below that buys nothing and costs real time.
 */
const YIELD_BUDGET_MS = 16;

/**
 * Hand the main thread back for one task, then resume.
 *
 * Why this exists: `vault.cachedRead` resolves out of an in-memory WeakMap, so
 * awaiting it is a MICROtask — and microtasks never let the browser paint or
 * process input. Every other await in this file is likewise microtask-only.
 * That is why parsing the whole vault froze Obsidian solid for ~7 seconds even
 * though the code looks politely asynchronous. `yieldToBrowser` is the only
 * real yield here.
 *
 * Three tiers, best first:
 *
 * 1. `requestIdleCallback` — the real target (Chromium/Electron). Resumes in
 *    the browser's own spare time, so slicing costs nothing noticeable and
 *    never competes with input. The timeout guarantees forward progress even
 *    if the user keeps the main thread busy.
 * 2. `MessageChannel` — fallback. Nested `setTimeout(0)` is clamped to ~4ms,
 *    which at ~600 slices would add seconds to every rebuild; a message task
 *    is scheduled promptly. NOTE: measured ~8-12ms per call under Node, so
 *    tests here run slower than Obsidian will.
 * 3. `setTimeout` — last resort where neither exists.
 */
let channel: MessageChannel | null | undefined;

function yieldToBrowser(): Promise<void> {
  const idle = (globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof idle === 'function') {
    return new Promise<void>((resolve) => {
      idle(() => resolve(), { timeout: 250 });
    });
  }
  if (channel === undefined) {
    channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    channel?.port1.start();
  }
  if (!channel) return new Promise<void>((r) => setTimeout(r, 0));
  return new Promise<void>((resolve) => {
    // Safe to overwrite: callers await serially, so at most one handler is
    // ever pending at a time.
    channel!.port1.onmessage = () => resolve();
    channel!.port2.postMessage(null);
  });
}

// ----------------------------------------------------------------------
// Character signatures — see BlockIndex.unlinkedMentions for the rationale
// ----------------------------------------------------------------------

/** 128 bits, as 4 x u32 words per block. */
const SIG_WORDS = 4;
/** Bits set per character. At 128 bits this leaves 0.1–2.2% candidates. */
const SIG_BITS_PER_CHAR = 2;

/** Case folding without allocating a lowercase copy of the block text. */
function foldChar(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function hashChar(code: number): number {
  return (code * 2654435761) >>> 0;
}

function bitPosition(h: number, j: number): number {
  return (h >>> (j * 5)) & (SIG_WORDS * 32 - 1);
}

/**
 * Flat [wordIndex, mask, ...] pairs: every distinct character of the query
 * contributes `SIG_BITS_PER_CHAR` bits that a block must have set.
 */
function queryMasks(q: string): number[] {
  const masks: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < q.length; i++) {
    const c = foldChar(q.charCodeAt(i));
    if (seen.has(c)) continue;
    seen.add(c);
    const h = hashChar(c);
    for (let j = 0; j < SIG_BITS_PER_CHAR; j++) {
      const bit = bitPosition(h, j);
      masks.push(bit >>> 5, 1 << (bit & 31));
    }
  }
  return masks;
}

/** One block's signature against the query masks. False positives only. */
function sigMatches(sig: Uint32Array, i: number, masks: number[]): boolean {
  const base = i * SIG_WORDS;
  for (let k = 0; k < masks.length; k += 2) {
    if ((sig[base + masks[k]] & masks[k + 1]) === 0) return false;
  }
  return true;
}

function buildSignatures(blocks: IndexedBlock[]): Uint32Array {
  const sig = new Uint32Array(blocks.length * SIG_WORDS);
  for (let i = 0; i < blocks.length; i++) {
    const t = blocks[i].text;
    const base = i * SIG_WORDS;
    for (let c = 0; c < t.length; c++) {
      const h = hashChar(foldChar(t.charCodeAt(c)));
      for (let j = 0; j < SIG_BITS_PER_CHAR; j++) {
        const bit = bitPosition(h, j);
        sig[base + (bit >>> 5)] |= 1 << (bit & 31);
      }
    }
  }
  return sig;
}
