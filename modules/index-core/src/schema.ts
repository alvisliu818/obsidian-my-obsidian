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
  // external-content FTS 无自动同步——由触发器在同事务内维护（SQLite 官方推荐的
  // external-content 触发器模式）。应用层一律不直接写 items_fts，杜绝漏同步。
  items_fts_triggers: `CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, t_title, t_headings, t_tags, t_content)
  VALUES (new.rowid, new.t_title, new.t_headings, new.t_tags, new.t_content);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, t_title, t_headings, t_tags, t_content)
  VALUES ('delete', old.rowid, old.t_title, old.t_headings, old.t_tags, old.t_content);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, t_title, t_headings, t_tags, t_content)
  VALUES ('delete', old.rowid, old.t_title, old.t_headings, old.t_tags, old.t_content);
  INSERT INTO items_fts(rowid, t_title, t_headings, t_tags, t_content)
  VALUES (new.rowid, new.t_title, new.t_headings, new.t_tags, new.t_content);
END;`,
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
CREATE INDEX IF NOT EXISTS idx_links_tpath ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_item);`,
  items_file_index: `CREATE INDEX IF NOT EXISTS idx_items_file ON items(file_rowid);`,
  names: `CREATE TABLE IF NOT EXISTS names (
  name TEXT NOT NULL,
  original TEXT NOT NULL,
  item_rowid INTEGER NOT NULL,
  precedence INTEGER NOT NULL
);`,
  names_index: `CREATE INDEX IF NOT EXISTS idx_names ON names(name, precedence);
CREATE INDEX IF NOT EXISTS idx_names_item ON names(item_rowid);`,
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
