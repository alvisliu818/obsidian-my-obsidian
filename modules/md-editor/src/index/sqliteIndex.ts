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
import { supertagDefFrom } from '../features/supertags';
import { destroyNodeSqliteFile, NodeSqliteRuntime } from './nodeSqlite';
import type { SqliteRuntimeLike } from './sqliteRuntime';
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
import { FTS_STATEMENTS } from './sqliteSchema';
export type { SqliteFileMeta } from './sqliteSchema';

/** Files larger than this are skipped (same guard as the in-memory index). */
export const MAX_FILE_BYTES = 2_000_000;

export interface SqliteFileSource {
  /** Every markdown file in the vault with its current signature. */
  listMarkdownFiles(): SqliteFileMeta[];
  /**
   * 单文件签名（2026-11-04）。可选：给足实现时 syncFile 用 O(1) stat 替代
   * 全库 listMarkdownFiles().find()——upsert 洪峰（同步插件/网盘批量触碰）
   * 会把上千个 syncFile 排进队列,每个都全库遍历一次,在大 vault + 网盘
   * minifilter 上就是小时级的空转（主库实测:每 walk 5-20s,daemon 单核
   * 满转数小时,查询全部被按住）。缺席时回落 listMarkdownFiles。
   */
  statFile?(path: string): SqliteFileMeta | null;
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
  /**
   * 桌面端 node:sqlite 直连（M2-6）：直接读写 `nodeDbPath` 磁盘文件，跳过
   * 快照镜像导入导出。node:sqlite 不可用（移动端/旧 Electron）时 doOpen
   * 自动降级回 wa-sqlite 路线，调用方无须预检。
   */
  useNodeSqlite?: boolean;
  /** node 直连的库文件绝对路径（通常即快照路径 sqliteDbPath） */
  nodeDbPath?: string;
  /**
   * 运行时工厂（守护进程用）：优先于 node:sqlite/wa-sqlite。返回的运行时
   * 自行打开库文件（如 better-sqlite3——带 FTS5 的预编译 SQLite）。
   */
  runtimeFactory?: () => Promise<SqliteRuntimeLike>;
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
  private rt: SqliteRuntimeLike | null = null;
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

  /** FTS5 表是否可用(构建未编 FTS5 时 false,查询层回落 LIKE)。 */
  ftsEnabled = false;

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
    // 守护进程注入的运行时工厂最优先（better-sqlite3,带 FTS5）。
    if (this.opts.runtimeFactory) {
      const rt = await this.opts.runtimeFactory();
      this.discarded = await this.ensureSchema(rt);
      this.rt = rt;
      this.lastError = '';
      return;
    }
    // 桌面直连优先（M2-6）：磁盘文件即库，免镜像导入导出；快照路径与本路径
    // 是同一个文件（wa-sqlite 写的镜像 = 合法 SQLite 文件，天然迁移）。
    // node:sqlite 缺席（移动端/旧 Electron）→ 降级 wa-sqlite 内存路线。
    if (this.opts.useNodeSqlite && this.opts.nodeDbPath) {
      try {
        const nodePath = this.opts.nodeDbPath;
        let nodeRt = await NodeSqliteRuntime.open(nodePath);
        if (!(await nodeRt.integrityCheck())) {
          await nodeRt.close().catch(() => undefined);
          destroyNodeSqliteFile(nodePath);
          nodeRt = await NodeSqliteRuntime.open(nodePath);
        }
        this.discarded = await this.ensureSchema(nodeRt);
        this.rt = nodeRt;
        this.lastError = '';
        return;
      } catch (err) {
        console.warn('[logseq] node:sqlite 直连不可用，回退 wa-sqlite:', String(err instanceof Error ? err.message : err));
      }
    }
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
  private async ensureSchema(rt: SqliteRuntimeLike): Promise<boolean> {
    const version = await this.readMeta(rt, META_SCHEMA_KEY);
    if (version === String(SCHEMA_VERSION)) {
      for (const sql of SCHEMA_SQL) await rt.run(sql);
    } else {
      await this.dropAll(rt);
      for (const sql of SCHEMA_SQL) await rt.run(sql);
      await rt.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
        META_SCHEMA_KEY,
        String(SCHEMA_VERSION),
      ]);
    }
    // FTS5 表:容错应用——构建没编 FTS5 时静默跳过(ftsEnabled=false,
    // 查询层回落 LIKE),schema 版本不因它变化。
    this.ftsEnabled = await this.applyFts(rt);
    return version !== String(SCHEMA_VERSION);
  }

  /** 建 FTS5 表;已存在但内容为空且 blocks 非空 → 回填(老库升级)。 */
  private async applyFts(rt: SqliteRuntimeLike): Promise<boolean> {
    try {
      for (const sql of FTS_STATEMENTS) await rt.run(sql);
      const n = (await rt.all('SELECT COUNT(*) c FROM blocks_fts', [], 1)).rows[0]?.[0];
      if (Number(n) === 0) {
        const b = (await rt.all('SELECT COUNT(*) c FROM blocks', [], 1)).rows[0]?.[0];
        if (Number(b) > 0) {
          await rt.run(
            "INSERT INTO blocks_fts (bkey, path, text) SELECT bkey, path, text FROM blocks",
          );
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private async dropAll(rt: SqliteRuntimeLike): Promise<void> {
    for (const t of TABLE_NAMES) await rt.run(`DROP TABLE IF EXISTS ${t}`);
    try {
      await rt.run('DROP TABLE IF EXISTS blocks_fts');
    } catch {
      /* 无 FTS5 模块时 drop 虚拟表会抛,忽略 */
    }
  }

  private async readMeta(rt: SqliteRuntimeLike, key: string): Promise<string | null> {
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

  private async persist(rt: SqliteRuntimeLike): Promise<boolean> {
    if (!this.opts.snapshot) return false;
    const image = rt.exportImage();
    if (image.byteLength === 0) return false; // node 直连模式：数据在盘上，无镜像可导
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
    // dropAll 把 FTS 表也清了,reindexAll 有自己的建库序列——这里必须重挂,
    // 否则 ftsEnabled 还是 true 而 blocks_fts 已不存在,每个文件批次全失败
    // (2026-10-25 实测:files:0 全 skipped,bs3-batch 报 no such table)。
    this.ftsEnabled = await this.applyFts(rt);

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
      // statFile（O(1) stat）优先;缺席回落全库清单——见 SqliteFileSource 注释,
      // 全库遍历在 upsert 洪峰下是小时级空转（2026-11-04 主库实测）。
      const probed = this.opts.source.statFile?.(path);
      const meta = probed !== undefined
        ? probed
        : this.opts.source.listMarkdownFiles().find((f) => f.path === path);
      if (!meta) {
        await this.forgetFile(rt, path);
        return;
      }
      // 幂等门控（2026-11-04）:mtime+size 与库里一致就跳过。Obsidian 启动
      // 时 vault 'create' 会对全库文件触发,forwardVaultEvents 把几千个
      // syncFile 排进队列——不门控的话每次启动都要无谓地读+解析+写全库
      // 一遍（10-30 分钟单核）;门控后全部秒过,真实变更才动库。
      const row = await this.indexedRow(rt, path);
      if (row && row.mtime === meta.mtime && row.size === meta.size) return;
      if (await this.indexOne(rt, meta)) this.dirty = true;
    });
  }

  /** 单文件签名行（幂等门控用）;不存在返回 null。 */
  private async indexedRow(rt: SqliteRuntimeLike, path: string): Promise<IndexedFileRow | null> {
    const res = await rt.all('SELECT path, mtime, size, hash, blocks FROM files WHERE path = ?', [path], 1);
    const r = res.rows[0];
    if (!r) return null;
    return { path: String(r[0]), mtime: Number(r[1] ?? 0), size: Number(r[2] ?? 0), hash: Number(r[3] ?? 0), blocks: Number(r[4] ?? 0) };
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
  private async indexOne(rt: SqliteRuntimeLike, meta: SqliteFileMeta): Promise<boolean> {
    const max = this.opts.maxFileBytes ?? MAX_FILE_BYTES;
    if (meta.size > max) return false;
    let content: string;
    try {
      content = await this.opts.source.read(meta.path);
    } catch {
      return false;
    }
    const facts = extractFile(meta.path, content);
    const stmts = buildFileStatements(facts, meta, hashText(content), this.ftsEnabled);
    const rc = await rt.batch(
      stmts.map((s) => s.sql),
      stmts.map((s) => s.params),
    );
    return rc === 0;
  }

  private async forgetFile(rt: SqliteRuntimeLike, path: string): Promise<void> {
    const stmts = deleteFileStatements(path);
    await rt.batch(
      stmts.map((s) => s.sql),
      stmts.map((s) => s.params),
    );
  }

  private async indexedFiles(rt: SqliteRuntimeLike): Promise<IndexedFileRow[]> {
    const res = await rt.all('SELECT path, mtime, size, hash, blocks FROM files', undefined, 500_000);
    return res.rows.map((r) => ({
      path: String(r[0] ?? ''),
      mtime: Number(r[1] ?? 0),
      size: Number(r[2] ?? 0),
      hash: Number(r[3] ?? 0),
      blocks: Number(r[4] ?? 0),
    }));
  }

  private async counts(rt: SqliteRuntimeLike): Promise<Omit<SqliteIndexStats, 'added' | 'changed' | 'removed' | 'unchanged' | 'fullRebuild' | 'skipped' | 'bytes' | 'persisted' | 'ms'>> {
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

export interface Stmt {
  sql: string;
  params: unknown[];
}

/**
 * Deletes MUST run before the `blocks` rows they select from disappear, and
 * the `files` row last so a crash mid-batch never leaves a file claiming to be
 * indexed while its blocks are gone.
 */
export function deleteFileStatements(path: string, fts = false): Stmt[] {
  const owned = 'SELECT bkey FROM blocks WHERE path = ?';
  const ftsDel: Stmt[] = fts
    ? [{ sql: `DELETE FROM blocks_fts WHERE bkey IN (${owned})`, params: [path] }]
    : [];
  return [
    ...ftsDel,
    { sql: `DELETE FROM props WHERE bkey IN (${owned})`, params: [path] },
    { sql: `DELETE FROM tags WHERE bkey IN (${owned})`, params: [path] },
    { sql: `DELETE FROM links WHERE bkey IN (${owned})`, params: [path] },
    { sql: `DELETE FROM refs WHERE bkey IN (${owned})`, params: [path] },
    { sql: `DELETE FROM eff_refs WHERE bkey IN (${owned})`, params: [path] },
    { sql: 'DELETE FROM cards WHERE path = ?', params: [path] },
    { sql: 'DELETE FROM supertags WHERE path = ?', params: [path] },
    { sql: 'DELETE FROM blocks WHERE path = ?', params: [path] },
    { sql: 'DELETE FROM page_props WHERE path = ?', params: [path] },
    { sql: 'DELETE FROM files WHERE path = ?', params: [path] },
  ];
}

/** One file's rows, as a single atomic batch: delete the old, insert the new. */
export function buildFileStatements(facts: FileFacts, meta: SqliteFileMeta, hash: number, fts = false): Stmt[] {
  const out: Stmt[] = deleteFileStatements(facts.path, fts);
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
  // ---- 物化(守护进程查询层):有效反链/闪卡/超标签在写入时算好,查询纯 SQL。
  // 折叠与 BlockIndex.indexContent 完全同式(祖先继承 + 自身 links/tags + 页名)。
  const refsByKey = new Map<string, string[]>();
  for (const b of facts.blocks) {
    const inherited = b.parentKey ? refsByKey.get(b.parentKey) ?? [] : [];
    const effective = [...new Set([...inherited, ...b.links, ...b.tags, facts.page])];
    refsByKey.set(b.bkey, effective);
    for (const target of effective) {
      out.push({ sql: 'INSERT INTO eff_refs (bkey, target) VALUES (?, ?)', params: [b.bkey, target] });
    }
    if (b.isCard) {
      out.push({
        sql: 'INSERT INTO cards (bkey, path, block_id, question, answer, marker, props_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [b.bkey, facts.path, b.id, b.text, b.answer ?? '', b.marker, JSON.stringify(b.blockProps ?? {})],
      });
    }
  }
  const def = supertagDefFrom(facts.page, facts.pageProps);
  if (def) {
    out.push({
      sql: 'INSERT OR REPLACE INTO supertags (name, path, props_json) VALUES (?, ?, ?)',
      params: [def.name, facts.path, JSON.stringify({ fields: def.fields, parents: def.parents })],
    });
  }
  if (fts) {
    for (const b of facts.blocks) {
      out.push({
        sql: 'INSERT INTO blocks_fts (bkey, path, text) VALUES (?, ?, ?)',
        params: [b.bkey, facts.path, b.text],
      });
    }
  }
  out.push({
    sql: 'INSERT OR REPLACE INTO files (path, page, mtime, size, hash, blocks) VALUES (?, ?, ?, ?, ?, ?)',
    params: [facts.path, facts.page, meta.mtime, meta.size, hash, facts.blocks.length],
  });
  return out;
}
