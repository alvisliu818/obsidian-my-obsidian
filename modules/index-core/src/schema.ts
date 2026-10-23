// 统一索引 · schema 定义与迁移
// 设计见 docs/unified-index-design.md（external-content 列必须与 items 分词列同名同内容）

/** 当前 schema 版本。每次破坏性变更 +1 并在 MIGRATIONS 追加迁移。 */
export const SCHEMA_VERSION = 1;

/** v1 全量建表。exec 支持多语句，按对象分组便于将来迁移逐个 drop/create。 */
export const SCHEMA_OBJECTS: Record<string, string> = {
  files: `CREATE TABLE IF NOT EXISTS files (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  mtime INTEGER,
  size INTEGER,
  ext TEXT,
  title TEXT
);`,
  items: `CREATE TABLE IF NOT EXISTS items (
  rowid INTEGER PRIMARY KEY,
  file_rowid INTEGER NOT NULL REFERENCES files(rowid) ON DELETE CASCADE,
  block_id TEXT UNIQUE,
  parent_rowid INTEGER,
  ord INTEGER,
  content TEXT NOT NULL,
  t_title TEXT,
  t_headings TEXT,
  t_tags TEXT,
  t_content TEXT,
  format TEXT NOT NULL,
  content_hash TEXT,
  mtime INTEGER
);`,
  items_fts: `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  t_title, t_headings, t_tags, t_content,
  content='items', content_rowid='rowid',
  tokenize='unicode61', prefix='2,3', detail=full
);`,
  links: `CREATE TABLE IF NOT EXISTS links (
  rowid INTEGER PRIMARY KEY,
  src_item INTEGER NOT NULL REFERENCES items(rowid) ON DELETE CASCADE,
  raw TEXT NOT NULL,
  target_path TEXT,
  target_item INTEGER,
  target_root INTEGER,
  anchor TEXT,
  kind TEXT NOT NULL,
  resolved INTEGER NOT NULL
);`,
  links_indexes: `CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_item);
CREATE INDEX IF NOT EXISTS idx_links_tpath ON links(target_path);`,
  names: `CREATE TABLE IF NOT EXISTS names (
  name TEXT NOT NULL,
  original TEXT NOT NULL,
  item_rowid INTEGER NOT NULL,
  precedence INTEGER NOT NULL
);`,
  names_index: `CREATE INDEX IF NOT EXISTS idx_names ON names(name, precedence);`,
  sync_state: `CREATE TABLE IF NOT EXISTS sync_state (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER
);`,
};

/** 迁移表：index = 目标版本 - 1。v1 即全量建表。 */
export const MIGRATIONS: { toVersion: number; statements: string[] }[] = [
  {
    toVersion: 1,
    statements: [...Object.values(SCHEMA_OBJECTS)],
  },
];

/** 建 meta 表（迁移系统自身依赖，先于一切） */
export const META_TABLE_DDL = `CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);`;
