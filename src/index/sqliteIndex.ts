/**
 * The SQLite secondary index.
 *
 * Contract, in one sentence: **markdown is the source of truth, the database
 * is a rebuildable cache of it.** Every row is derived from the .md files
 * through `fileFacts.extractFile`, so
 *
 *   1. the database can always be dropped and rebuilt from the vault;
 *   2. a stale database is detected (mtime/size against the `files` table) and
 *      repaired by re-reading the markdown — never by writing to it;
 *   3. nothing here ever touches a .md file, so the index can never corrupt
 *      the user's notes.
 *
 * Purposely free of `obsidian`: the vault is reached through the small
 * `SqliteFileSource` / `SqliteSnapshotStore` interfaces, so the whole thing is
 * testable against a fake vault under vitest.
 */

import { extractFile, type FileFacts } from './fileFacts';
import { SqliteRuntime } from './waSqlite';
import {
  DB_FILE,
  META_BUILT_KEY,
  META_SCHEMA_KEY,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  TABLE_NAMES,
  hashText,
  planSync,
  type IndexedFileRow,
  type SqliteFileMeta,
} from './sqliteSchema';

/** Files larger than this are skipped (same guard as the in-memory index). */
export const MAX_FILE_BYTES = 2_000_000;

export interface SqliteFileSource {
  /** Every markdown file in the vault with its current signature. */
  listMarkdownFiles(): SqliteFileMeta[];
  read(path: string): Promise<string>;
}

/** Persistence for the database image (a plain binary file). */
export interface SqliteSnapshotStore {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
}

export interface SqliteIndexOptions {
  source: SqliteFileSource;
  snapshot?: SqliteSnapshotStore | null;
  onProgress?: (done: number, total: number) => void;
  maxFileBytes?: number;
}

export interface SqliteIndexStats {
  files: number;
  blocks: number;
  props: number;
  tags: number;
  links: number;
  refs: number;
  /** Files indexed in this run. */
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** True when the whole database was dropped and re-derived. */
  fullRebuild: boolean;
  /** Files skipped for being too large or unreadable. */
  skipped: string[];
  bytes: number;
  persisted: boolean;
  ms: number;
}

export interface SqliteQueryOutcome {
  columns: string[];
  rows: unknown[][];
  ms: number;
  truncated: boolean;
  /** Non-empty when SQLite rejected the statement. */
  error: string;
}

export interface SqliteVerifyOutcome {
  checked: number;
  /** Files whose bytes no longer match the fingerprint stored for them. */
  drift: string[];
  /** Vault files with no row, and rows with no file. */
  missing: string[];
  ms: number;
}

const EMPTY_STATS: SqliteIndexStats = {
  files: 0,
  blocks: 0,
  props: 0,
  tags: 0,
  links: 0,
  refs: 0,
  added: 0,
  changed: 0,
  removed: 0,
  unchanged: 0,
  fullRebuild: false,
  skipped: [],
  bytes: 0,
  persisted: false,
  ms: 0,
};

export class SqliteIndex {
  private rt: SqliteRuntime | null = null;
  private opening: Promise<void> | null = null;
  /** Serializes every mutating/reading operation (one connection, one queue). */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Set when the index was reopened but could not be opened at all. */
  private discarded = false;
  /** Rows changed since the last snapshot write. */
  private dirty = false;

  stats: SqliteIndexStats = { ...EMPTY_STATS };
  lastError: string = '';

  constructor(private opts: SqliteIndexOptions) {}

  get ready(): boolean {
    return !!this.rt && !this.closed;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Open (or restore) the database. Safe to call repeatedly; queued, so it can
   * never interleave with a running rebuild (wa-sqlite has ONE connection and
   * concurrent statements on it corrupt the WASM heap).
   */
  open(): Promise<void> {
    return this.enqueue(() => this.ensureOpen());
  }

  /**
   * The unqueued half — used by every queued operation so they do not wait on
   * the queue they are already running in.
   */
  private async ensureOpen(): Promise<void> {
    if (this.closed || this.rt) return;
    if (!this.opening) {
      this.opening = this.doOpen()
        .catch((err) => {
          this.lastError = String(err instanceof Error ? err.message : err);
          this.rt = null;
        })
        .finally(() => {
          this.opening = null;
        });
    }
    await this.opening;
  }

  private async doOpen(): Promise<void> {
    const seed = this.opts.snapshot ? await this.opts.snapshot.load().catch(() => null) : null;
    let rt = await SqliteRuntime.open(DB_FILE, seed);
    // A snapshot that does not pass integrity_check is worthless — the index
    // is rebuildable, so throw it away instead of trusting it.
    if (seed && seed.byteLength > 0 && !(await rt.integrityCheck())) {
      await rt.close().catch(() => undefined);
      rt = await SqliteRuntime.open(DB_FILE, null);
    }
    // NOTE: a discarded database is NOT re-indexed here. `ensureSchema` leaves
    // it schema-correct but EMPTY, and an empty `files` table makes the next
    // `sync()` see every file as new — so the re-derive happens on the queue
    // like any other write, never concurrently with an outer `rebuild()`.
    this.discarded = await this.ensureSchema(rt);
    this.rt = rt;
    this.lastError = '';
  }

  /** Create the schema; returns true when the database had to be discarded. */
  private async ensureSchema(rt: SqliteRuntime): Promise<boolean> {
    const version = await this.readMeta(rt, META_SCHEMA_KEY);
    if (version === String(SCHEMA_VERSION)) {
      for (const sql of SCHEMA_SQL) await rt.run(sql);
      return false;
    }
    await this.dropAll(rt);
    for (const sql of SCHEMA_SQL) await rt.run(sql);
    await rt.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      META_SCHEMA_KEY,
      String(SCHEMA_VERSION),
    ]);
    return true;
  }

  private async dropAll(rt: SqliteRuntime): Promise<void> {
    for (const t of TABLE_NAMES) await rt.run(`DROP TABLE IF EXISTS ${t}`);
  }

  private async readMeta(rt: SqliteRuntime, key: string): Promise<string | null> {
    try {
      const res = await rt.all('SELECT value FROM meta WHERE key = ?', [key], 1);
      const v = res.rows[0]?.[0];
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const rt = this.rt;
    this.rt = null;
    if (!rt) return;
    await this.persist(rt).catch(() => undefined);
    await rt.close().catch(() => undefined);
  }

  private async persist(rt: SqliteRuntime): Promise<boolean> {
    if (!this.opts.snapshot) return false;
    const image = rt.exportImage();
    if (image.byteLength === 0) return false;
    await this.opts.snapshot.save(image);
    this.stats = { ...this.stats, bytes: image.byteLength, persisted: true };
    return true;
  }

  // ------------------------------------------------------------------
  // Markdown -> rows
  // ------------------------------------------------------------------

  /** Drop every derived row and re-index the whole vault from markdown. */
  rebuild(): Promise<SqliteIndexStats> {
    return this.enqueue(async () => this.reindexAll());
  }

  private async reindexAll(): Promise<SqliteIndexStats> {
    await this.ensureOpen();
    const rt = this.rt;
    if (!rt) return { ...EMPTY_STATS };
    this.discarded = false;
    const started = Date.now();
    await this.dropAll(rt);
    for (const sql of SCHEMA_SQL) await rt.run(sql);
    await rt.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      META_SCHEMA_KEY,
      String(SCHEMA_VERSION),
    ]);

    const vault = this.opts.source.listMarkdownFiles();
    let skipped: string[] = [];
    for (let i = 0; i < vault.length; i++) {
      const f = vault[i];
      const ok = await this.indexOne(rt, f);
      if (!ok) skipped.push(f.path);
      this.opts.onProgress?.(i + 1, vault.length);
    }
    await rt.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      META_BUILT_KEY,
      String(Date.now()),
    ]);
    await this.persist(rt);
    this.dirty = false;
    const counts = await this.counts(rt);
    this.stats = {
      ...counts,
      added: vault.length - skipped.length,
      changed: 0,
      removed: 0,
      unchanged: 0,
      fullRebuild: true,
      skipped,
      bytes: this.stats.bytes,
      persisted: !!this.opts.snapshot,
      ms: Date.now() - started,
    };
    return this.stats;
  }

  /**
   * Bring the database back in line with the files: index what is new or
   * changed, forget what disappeared. Cheap when nothing moved.
   */
  sync(): Promise<SqliteIndexStats> {
    return this.enqueue(async () => this.doSync());
  }

  private async doSync(): Promise<SqliteIndexStats> {
    await this.ensureOpen();
    const rt = this.rt;
    if (!rt) return { ...EMPTY_STATS };
    const started = Date.now();
    const vault = this.opts.source.listMarkdownFiles();
    const indexed = await this.indexedFiles(rt);
    const plan = planSync(vault, indexed);
    const byPath = new Map(vault.map((f) => [f.path, f]));
    const skipped: string[] = [];

    for (const path of plan.removed) await this.forgetFile(rt, path);
    const pending = [...plan.added, ...plan.changed];
    for (let i = 0; i < pending.length; i++) {
      const f = byPath.get(pending[i]);
      if (!f) continue;
      if (!(await this.indexOne(rt, f))) skipped.push(f.path);
      this.opts.onProgress?.(i + 1, pending.length);
    }
    if (pending.length > 0 || plan.removed.length > 0) {
      await rt.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
        META_BUILT_KEY,
        String(Date.now()),
      ]);
      await this.persist(rt);
      this.dirty = false;
    }
    const counts = await this.counts(rt);
    const fullRebuild = this.discarded;
    this.discarded = false;
    this.stats = {
      ...counts,
      added: plan.added.length,
      changed: plan.changed.length,
      removed: plan.removed.length,
      unchanged: plan.unchanged,
      fullRebuild,
      skipped,
      bytes: this.stats.bytes,
      persisted: !!this.opts.snapshot,
      ms: Date.now() - started,
    };
    return this.stats;
  }

  /** Re-index exactly one file (used by vault event handlers). */
  syncFile(path: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureOpen();
      const rt = this.rt;
      if (!rt) return;
      const meta = this.opts.source.listMarkdownFiles().find((f) => f.path === path);
      if (!meta) {
        await this.forgetFile(rt, path);
        return;
      }
      if (await this.indexOne(rt, meta)) this.dirty = true;
    });
  }

  /** Forget a file that no longer exists (or is no longer markdown). */
  forget(path: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureOpen();
      if (!this.rt) return;
      await this.forgetFile(this.rt, path);
      this.dirty = true;
    });
  }

  /**
   * Write the snapshot, but only when something actually changed. Callers that
   * re-index a batch of files should do it once at the end — the image is the
   * whole database, so writing it per file would be wasteful.
   */
  persistNow(): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureOpen();
      if (!this.rt || !this.dirty) return false;
      const ok = await this.persist(this.rt);
      this.dirty = false;
      return ok;
    });
  }

  /**
   * Read the markdown, derive its facts, and replace every row for that path
   * inside one transaction. Returns false when the file was skipped.
   */
  private async indexOne(rt: SqliteRuntime, meta: SqliteFileMeta): Promise<boolean> {
    const max = this.opts.maxFileBytes ?? MAX_FILE_BYTES;
    if (meta.size > max) return false;
    let content: string;
    try {
      content = await this.opts.source.read(meta.path);
    } catch {
      return false;
    }
    const facts = extractFile(meta.path, content);
    const stmts = buildFileStatements(facts, meta, hashText(content));
    const rc = await rt.batch(
      stmts.map((s) => s.sql),
      stmts.map((s) => s.params),
    );
    return rc === 0;
  }

  private async forgetFile(rt: SqliteRuntime, path: string): Promise<void> {
    const stmts = deleteFileStatements(path);
    await rt.batch(
      stmts.map((s) => s.sql),
      stmts.map((s) => s.params),
    );
  }

  private async indexedFiles(rt: SqliteRuntime): Promise<IndexedFileRow[]> {
    const res = await rt.all('SELECT path, mtime, size, hash, blocks FROM files', undefined, 500_000);
    return res.rows.map((r) => ({
      path: String(r[0] ?? ''),
      mtime: Number(r[1] ?? 0),
      size: Number(r[2] ?? 0),
      hash: Number(r[3] ?? 0),
      blocks: Number(r[4] ?? 0),
    }));
  }

  private async counts(rt: SqliteRuntime): Promise<Omit<SqliteIndexStats, 'added' | 'changed' | 'removed' | 'unchanged' | 'fullRebuild' | 'skipped' | 'bytes' | 'persisted' | 'ms'>> {
    // Sequential on purpose: one connection, and wa-sqlite's prepare/step
    // cycles must not interleave (Promise.all here corrupted the WASM heap).
    const count = async (sql: string): Promise<number> => {
      const res = await rt.all(sql, undefined, 1);
      return Number(res.rows[0]?.[0] ?? 0);
    };
    const files = await count('SELECT COUNT(*) FROM files');
    const blocks = await count('SELECT COUNT(*) FROM blocks');
    const props = await count('SELECT COUNT(*) FROM props');
    const tags = await count('SELECT COUNT(*) FROM tags');
    const links = await count('SELECT COUNT(*) FROM links');
    const refs = await count('SELECT COUNT(*) FROM refs');
    return { files, blocks, props, tags, links, refs };
  }

  // ------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------

  /** Run arbitrary SQL (the console). Never throws — see `error`. */
  query(sql: string, limit = 500): Promise<SqliteQueryOutcome> {
    return this.enqueue(async () => {
      const started = Date.now();
      await this.ensureOpen();
      const rt = this.rt;
      if (!rt) return { columns: [], rows: [], ms: 0, truncated: false, error: 'sqlite index is not available' };
      try {
        const res = await rt.all(sql, undefined, limit + 1);
        const truncated = res.rows.length > limit;
        return {
          columns: res.columns,
          rows: truncated ? res.rows.slice(0, limit) : res.rows,
          ms: Date.now() - started,
          truncated,
          error: '',
        };
      } catch (err) {
        return {
          columns: [],
          rows: [],
          ms: Date.now() - started,
          truncated: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    });
  }

  /**
   * Proof that markdown is the truth: re-read every file and compare its
   * fingerprint with the one stored when it was indexed. Any drift means the
   * database is stale and must be re-synced (from the files — never the
   * other way round).
   */
  verify(limit = 100): Promise<SqliteVerifyOutcome> {
    return this.enqueue(async () => {
      const started = Date.now();
      await this.ensureOpen();
      const rt = this.rt;
      if (!rt) return { checked: 0, drift: [], missing: [], ms: Date.now() - started };
      const vault = this.opts.source.listMarkdownFiles();
      const rows = await this.indexedFiles(rt);
      const byPath = new Map(rows.map((r) => [r.path, r]));
      const drift: string[] = [];
      const missing: string[] = [];
      for (const f of vault) {
        const row = byPath.get(f.path);
        if (!row) {
          missing.push(f.path);
          continue;
        }
        if (drift.length + missing.length >= limit) continue;
        let content: string;
        try {
          content = await this.opts.source.read(f.path);
        } catch {
          continue;
        }
        if (hashText(content) !== row.hash) drift.push(f.path);
      }
      for (const r of rows) if (!vault.some((f) => f.path === r.path)) missing.push(r.path);
      return { checked: vault.length, drift, missing, ms: Date.now() - started };
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

interface Stmt {
  sql: string;
  params: unknown[];
}

/**
 * Deletes MUST run before the `blocks` rows they select from disappear, and
 * the `files` row last so a crash mid-batch never leaves a file claiming to be
 * indexed while its blocks are gone.
 */
function deleteFileStatements(path: string): Stmt[] {
  const owned = 'SELECT bkey FROM blocks WHERE path = ?';
  return [
    { sql: `DELETE FROM props WHERE bkey IN (${owned})`, params: [path] },
    { sql: `DELETE FROM tags WHERE bkey IN (${owned})`, params: [path] },
    { sql: `DELETE FROM links WHERE bkey IN (${owned})`, params: [path] },
    { sql: `DELETE FROM refs WHERE bkey IN (${owned})`, params: [path] },
    { sql: 'DELETE FROM blocks WHERE path = ?', params: [path] },
    { sql: 'DELETE FROM page_props WHERE path = ?', params: [path] },
    { sql: 'DELETE FROM files WHERE path = ?', params: [path] },
  ];
}

/** One file's rows, as a single atomic batch: delete the old, insert the new. */
export function buildFileStatements(facts: FileFacts, meta: SqliteFileMeta, hash: number): Stmt[] {
  const out: Stmt[] = deleteFileStatements(facts.path);
  for (const b of facts.blocks) {
    out.push({
      sql: 'INSERT INTO blocks (bkey, block_id, path, ord, depth, parent_key, parent_id, text, marker, page) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [b.bkey, b.id, facts.path, b.ord, b.depth, b.parentKey, b.parentId, b.text, b.marker, facts.page],
    });
    for (const [k, v] of Object.entries(b.blockProps)) {
      out.push({ sql: 'INSERT INTO props (bkey, key, value) VALUES (?, ?, ?)', params: [b.bkey, k, v] });
    }
    for (const t of b.tags) {
      out.push({ sql: 'INSERT INTO tags (bkey, tag) VALUES (?, ?)', params: [b.bkey, t] });
    }
    for (const l of b.links) {
      out.push({ sql: 'INSERT INTO links (bkey, target) VALUES (?, ?)', params: [b.bkey, l] });
    }
    for (const r of b.refs) {
      out.push({ sql: 'INSERT INTO refs (bkey, target_id) VALUES (?, ?)', params: [b.bkey, r] });
    }
  }
  for (const [k, v] of Object.entries(facts.pageProps)) {
    out.push({ sql: 'INSERT INTO page_props (path, key, value) VALUES (?, ?, ?)', params: [facts.path, k, v] });
  }
  out.push({
    sql: 'INSERT OR REPLACE INTO files (path, page, mtime, size, hash, blocks) VALUES (?, ?, ?, ?, ?, ?)',
    params: [facts.path, facts.page, meta.mtime, meta.size, hash, facts.blocks.length],
  });
  return out;
}
