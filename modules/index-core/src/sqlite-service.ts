// 统一索引 · SQLite 服务（node:sqlite，Electron renderer 内同步 API）
// 设计纪律见 docs/unified-index-design.md：
//   懒打开 / 每库独立文件 / 坏库即删重建 / 指纹不符全量重建 / prepared 缓存 / WAL+NORMAL

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { META_TABLE_DDL, MIGRATIONS, SCHEMA_VERSION } from "./schema";

/** SQLite 报库损坏的错误码（lazy 触发，open 本身不校验全库） */
const CORRUPT_CODES = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);

export interface SqliteServiceOptions {
  /** 索引文件目录（对应设置 sqliteDbDir，默认 E:\HOME\Runtime\unified-index） */
  dbDir: string;
  /** vault 身份（sanitize 后进文件名，多库互不踩） */
  vaultSlug: string;
  /** 配置指纹（分词器可用性等）。与库内记录不符 → 全量重建 */
  fingerprint: string;
  /** 关键事件回调（插件层打日志/通知用） */
  onEvent?: (event: SqliteEvent) => void;
}

export type SqliteEvent =
  | { type: "opened"; path: string }
  | { type: "rebuild"; reason: string; path: string };

export class SqliteService {
  private db: DatabaseSync | null = null;
  private readonly stmts = new Map<string, StatementSync>();
  private readonly opts: SqliteServiceOptions;
  private dbPath = "";

  constructor(opts: SqliteServiceOptions) {
    this.opts = opts;
  }

  get filePath(): string {
    return this.dbPath;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** 懒打开入口：首次索引/搜索操作才触库，避开启动内存峰 */
  ensureOpen(): void {
    if (this.db) return;
    mkdirSync(this.opts.dbDir, { recursive: true });
    this.dbPath = path.join(this.opts.dbDir, `${this.opts.vaultSlug}.db`);
    try {
      this.openAndMigrate();
    } catch (e) {
      // Windows 下句柄未关时 unlink 会 EBUSY——先关掉失败的连接
      // （断言绕开 TS 对字段的过时收窄：openAndMigrate 内部可能已赋值）
      const failed = this.db as DatabaseSync | null;
      this.db = null;
      this.stmts.clear();
      if (failed) {
        try {
          failed.close();
        } catch {
          // 已损坏的库可能关不掉，忽略
        }
      }
      if (isCorruption(e)) {
        // 坏库即删重建：索引是可重建投影，绝不带病运行（logseq #7467 先例）
        this.destroyFile();
        this.openAndMigrate();
        this.opts.onEvent?.({ type: "rebuild", reason: String(errMsg(e)), path: this.dbPath });
        return;
      }
      throw e;
    }
    this.opts.onEvent?.({ type: "opened", path: this.dbPath });
  }

  close(): void {
    if (!this.db) return;
    try {
      // 收尾：WAL checkpoint 回主库 + 增量清理，文件不留胖尾巴
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("PRAGMA incremental_vacuum");
    } catch {
      // 收尾失败不影响关闭
    }
    this.db.close();
    this.db = null;
    this.stmts.clear();
  }

  /** 连接级 prepared statement 缓存（logseq 每调用 re-prepare 是反例） */
  prepare(sql: string): StatementSync {
    this.ensureOpen();
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db!.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  /** 单文件原子事务：BEGIN IMMEDIATE / COMMIT / ROLLBACK。不支持嵌套（调用方保证） */
  transaction<T>(fn: () => T): T {
    this.ensureOpen();
    this.db!.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db!.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db!.exec("ROLLBACK");
      } catch {
        // 已自动回滚
      }
      throw e;
    }
  }

  metaGet(key: string): string | null {
    const row = this.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  metaSet(key: string, value: string): void {
    this.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /** 指纹不符或版本跳级时的全量重建：关 → 删 → 重开 */
  rebuild(reason: string): void {
    this.close();
    this.destroyFile();
    this.openAndMigrate();
    this.opts.onEvent?.({ type: "rebuild", reason, path: this.dbPath });
  }

  /** 疾速首建模式：调用方在批量灌库前切换，完成后 commitBulk() 切回安全档 */
  beginBulk(): void {
    this.ensureOpen();
    // 首建可弃：崩溃大不了重建，换取 2-5× 灌库速度
    this.db!.exec("PRAGMA journal_mode=MEMORY");
    this.db!.exec("PRAGMA synchronous=OFF");
  }

  commitBulk(): void {
    if (!this.db) return;
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("ANALYZE");
  }

  // ------------------------------------------------------------------

  private openAndMigrate(): void {
    const db = new DatabaseSync(this.dbPath);
    this.db = db;
    this.stmts.clear();
    this.applyPragmas(db);
    this.migrate(db);
  }

  private applyPragmas(db: DatabaseSync): void {
    db.exec("PRAGMA foreign_keys=ON"); // 级联生效前提（不显式开=静默孤儿行）
    // 默认 busy_timeout=0：任何锁竞争立即 SQLITE_BUSY。插件重载期间新旧连接
    // 可能短暂并存，给 3 秒重试窗口比直接报错稳妥。
    db.exec("PRAGMA busy_timeout=3000");
    db.exec("PRAGMA temp_store=MEMORY");
    try {
      db.exec("PRAGMA journal_mode=WAL"); // 网络盘等场景可能拒绝，降级默认 journal
    } catch {
      // ignore
    }
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA cache_size=-8000"); // 8MB 页缓存上限
    try {
      db.exec("PRAGMA mmap_size=268435456"); // 读路径走 OS 页缓存
    } catch {
      // ignore
    }
  }

  private migrate(db: DatabaseSync): void {
    db.exec(META_TABLE_DDL);
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    const storedVersion = row ? Number(row.value) : 0;
    const storedFingerprint = (
      db.prepare("SELECT value FROM meta WHERE key='fingerprint'").get() as
        | { value: string }
        | undefined
    )?.value;

    // 配置指纹不符（分词器可用性等变更）→ 全量重建（思源规则）
    if (storedVersion > 0 && storedFingerprint !== null && storedFingerprint !== this.opts.fingerprint) {
      this.rebuildInPlace(db, `fingerprint ${storedFingerprint} -> ${this.opts.fingerprint}`);
      return;
    }
    // 库版本比代码新（插件被降级）→ 重建为当前代码认识的形态
    if (storedVersion > SCHEMA_VERSION) {
      this.rebuildInPlace(db, `schema downgrade ${storedVersion} -> ${SCHEMA_VERSION}`);
      return;
    }

    db.exec("PRAGMA auto_vacuum=INCREMENTAL"); // 空库时生效；已有库保持原状
    for (const m of MIGRATIONS) {
      if (m.toVersion > storedVersion) {
        for (const stmt of m.statements) db.exec(stmt);
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
          String(m.toVersion),
        );
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fingerprint', ?)").run(
      this.opts.fingerprint,
    );
  }

  /** 不删文件的重建：drop 全部对象后重走迁移（fingerprint/降级路径用） */
  private rebuildInPlace(db: DatabaseSync, reason: string): void {
    const objects = db
      .prepare(
        "SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'meta'",
      )
      .all() as { name: string; type: string; sql: string }[];
    // FTS5 影子表（<fts>_config/_data/...）禁止直接 drop——只 drop 虚表本体，影子随级联消失
    const ftsVirtuals = objects
      .filter((o) => o.type === "table" && /^CREATE VIRTUAL TABLE/i.test(o.sql ?? ""))
      .map((o) => o.name);
    const isFtsShadow = (name: string) =>
      ftsVirtuals.some((v) => name.startsWith(v + "_"));
    db.exec("PRAGMA foreign_keys=OFF");
    for (const o of objects) {
      if ((o.type === "trigger" || o.type === "view") && !isFtsShadow(o.name)) {
        db.exec(`DROP ${o.type} IF EXISTS "${o.name}"`);
      }
    }
    // 倒序 drop
    for (const o of [...objects].reverse()) {
      if (o.type === "table" && !isFtsShadow(o.name)) {
        db.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      }
    }
    db.exec("PRAGMA foreign_keys=ON");
    this.opts.onEvent?.({ type: "rebuild", reason, path: this.dbPath });
    // 清掉旧指纹，重走 migrate 才不会立刻再次判重建（死循环防线）
    db.prepare("DELETE FROM meta WHERE key='fingerprint'").run();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '0')").run();
    this.migrate(db);
  }

  private destroyFile(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = this.dbPath + suffix;
      if (existsSync(f)) rmSync(f);
    }
  }
}

function isCorruption(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? "";
  if (CORRUPT_CODES.has(code)) return true;
  const msg = errMsg(e);
  return msg.includes("malformed") || msg.includes("not a database") || msg.includes("corrupt");
}

function errMsg(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

/** vault 路径 → 安全文件名（logseq sanitize-db-name 同思路 + 尾部短 hash 防碰撞） */
export function vaultSlugOf(vaultPath: string): string {
  const slug = vaultPath.replace(/[/\\:*?"<>|.]/g, "_").slice(0, 64) || "vault";
  let h = 0x811c9dc5;
  for (let i = 0; i < vaultPath.length; i++) {
    h ^= vaultPath.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${slug}-${h.toString(16).slice(0, 6)}`;
}
