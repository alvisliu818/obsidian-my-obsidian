/**
 * SQLite secondary index: schema + sync planning.
 *
 * Pure logic — no obsidian, no wa-sqlite — so the DDL and the "which files
 * does the database disagree with?" decision are unit-testable on their own.
 *
 * The database is a DERIVED cache. Every row comes from
 * `fileFacts.extractFile(markdown)`, so the tables can always be dropped and
 * rebuilt from the .md files; nothing here is authoritative.
 */

/** Bump when the DDL changes — a mismatch forces a full rebuild. */
export const SCHEMA_VERSION = 1;

export const META_SCHEMA_KEY = 'schema_version';
export const META_BUILT_KEY = 'built_at';

/** Default file name inside the memory VFS. */
export const DB_FILE = 'logseq-index.db';

/**
 * DDL, executed in order on every fresh database. `IF NOT EXISTS` keeps
 * re-opening an existing snapshot cheap.
 */
export const SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // One row per markdown file: what we indexed, and what we indexed it FROM
  // (mtime + size + content hash) so a sync can tell whether it is stale.
  `CREATE TABLE IF NOT EXISTS files (
     path TEXT PRIMARY KEY,
     page TEXT NOT NULL DEFAULT '',
     mtime INTEGER NOT NULL DEFAULT 0,
     size INTEGER NOT NULL DEFAULT 0,
     hash INTEGER NOT NULL DEFAULT 0,
     blocks INTEGER NOT NULL DEFAULT 0
   )`,

  // Flat, document-ordered block list. `bkey` is always unique (real uuid, or
  // `~path#ord`); `block_id` is the real `id::` and '' when there is none.
  `CREATE TABLE IF NOT EXISTS blocks (
     bkey TEXT PRIMARY KEY,
     block_id TEXT NOT NULL DEFAULT '',
     path TEXT NOT NULL,
     ord INTEGER NOT NULL,
     depth INTEGER NOT NULL DEFAULT 0,
     parent_key TEXT NOT NULL DEFAULT '',
     parent_id TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     marker TEXT,
     page TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_path ON blocks(path)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_id ON blocks(block_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_key)`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page)`,

  `CREATE TABLE IF NOT EXISTS props (
     bkey TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_props_bkey ON props(bkey)`,
  `CREATE INDEX IF NOT EXISTS idx_props_key ON props(key, value)`,

  `CREATE TABLE IF NOT EXISTS tags (
     bkey TEXT NOT NULL,
     tag TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tags_bkey ON tags(bkey)`,
  `CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)`,

  `CREATE TABLE IF NOT EXISTS links (
     bkey TEXT NOT NULL,
     target TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_links_bkey ON links(bkey)`,
  `CREATE INDEX IF NOT EXISTS idx_links_target ON links(target)`,

  `CREATE TABLE IF NOT EXISTS refs (
     bkey TEXT NOT NULL,
     target_id TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_refs_bkey ON refs(bkey)`,
  `CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_id)`,

  `CREATE TABLE IF NOT EXISTS page_props (
     path TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_page_props_path ON page_props(path)`,

  // ---- 物化表(2026-10-25 守护进程方案):块索引查询层需要的派生数据在写入时
  // 算好,查询就是纯 SQL——渲染进程不再驻留 99 万块的对象图(思源同款模式)。

  // 每块的有效反链目标(自身 links+tags,加祖先继承,加所在页)——BacklinkEntry.refs。
  `CREATE TABLE IF NOT EXISTS eff_refs (
     bkey TEXT NOT NULL,
     target TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_eff_refs_bkey ON eff_refs(bkey)`,
  `CREATE INDEX IF NOT EXISTS idx_eff_refs_target ON eff_refs(target)`,

  // 闪卡(块 tagged #card;question/answer 在写入时从块树组装)。
  `CREATE TABLE IF NOT EXISTS cards (
     bkey TEXT PRIMARY KEY,
     path TEXT NOT NULL,
     block_id TEXT NOT NULL DEFAULT '',
     question TEXT NOT NULL DEFAULT '',
     answer TEXT NOT NULL DEFAULT '',
     marker TEXT,
     props_json TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cards_path ON cards(path)`,

  // 超标签定义(标签页自身带属性 → 模板)。
  `CREATE TABLE IF NOT EXISTS supertags (
     name TEXT PRIMARY KEY,
     path TEXT NOT NULL,
     props_json TEXT NOT NULL DEFAULT '{}'
   )`,
];

export const TABLE_NAMES: readonly string[] = [
  'meta',
  'files',
  'blocks',
  'props',
  'tags',
  'links',
  'refs',
  'page_props',
  'eff_refs',
  'cards',
  'supertags',
];

export interface SqliteFileMeta {
  path: string;
  /** Modification time in milliseconds (Obsidian's `stat.mtime`). */
  mtime: number;
  size: number;
}

/** What the database currently remembers about a file. */
export interface IndexedFileRow {
  path: string;
  mtime: number;
  size: number;
  hash: number;
  blocks: number;
}

export interface SyncPlan {
  /** In the vault, not in the database. */
  added: string[];
  /** In both, but mtime or size moved — markdown changed outside our back. */
  changed: string[];
  /** In the database, no longer in the vault. */
  removed: string[];
  /** Identical signatures; nothing to do. */
  unchanged: number;
}

/** True when every file is already in sync — a no-op sync. */
export function isPlanEmpty(plan: SyncPlan): boolean {
  return plan.added.length === 0 && plan.changed.length === 0 && plan.removed.length === 0;
}

/** Total number of files to (re)read for this plan. */
export function planWork(plan: SyncPlan): number {
  return plan.added.length + plan.changed.length;
}

/**
 * Diff the vault against the database's `files` table.
 *
 * Compares mtime + size only: that is what Obsidian exposes cheaply, and it
 * catches edits made by other apps (sync clients, git, external editors).
 * Content-level drift (same mtime, different bytes) is what `verify()` is for.
 */
export function planSync(
  vault: readonly SqliteFileMeta[],
  indexed: readonly IndexedFileRow[],
): SyncPlan {
  const byPath = new Map<string, IndexedFileRow>();
  for (const row of indexed) byPath.set(row.path, row);
  const seen = new Set<string>();
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  for (const f of vault) {
    if (seen.has(f.path)) continue; // defensive: vault list must be unique
    seen.add(f.path);
    const prev = byPath.get(f.path);
    if (!prev) added.push(f.path);
    else if (prev.mtime !== f.mtime || prev.size !== f.size) changed.push(f.path);
    else unchanged++;
  }

  const removed: string[] = [];
  for (const row of indexed) if (!seen.has(row.path)) removed.push(row.path);

  return { added, changed, removed, unchanged };
}

/** FNV-1a 32-bit — a cheap content fingerprint for drift detection. */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * FTS5 全文索引(2026-10-25,用户指定「上 FTS5」):trigram 分词器支持中文子串
 * 匹配(>=3 字)。SQLite 构建未编 FTS5 时(node:sqlite/wa-sqlite 默认都没编,
 * 实测 2026-10-25)整个列表跳过,查询层回落 LIKE——不是错误路径。
 *
 * 常规 fts5 表(非 external content):DELETE/INSERT 与 blocks 同批维护。
 * trigram 索引体积 ≈ 文本 3 倍(主库 618K 块 ≈ 25MB 文本 → ~75MB 磁盘),
 * 换未连提及/块搜索从 237ms 全库 LIKE 变毫秒级。
 */
export const FTS_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
     bkey UNINDEXED,
     path UNINDEXED,
     text,
     tokenize = 'trigram'
   )`,
];
