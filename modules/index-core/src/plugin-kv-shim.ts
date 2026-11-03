// 插件协作 KV 后端：把 FML/ERH 的 LocalDataStore 账本从 IndexedDB 迁到
// 本机 sqlite（E:\HOME\Runtime\unified-index\plugin-kv.sqlite，与 index-core
// 的索引库同目录、独立文件），账本随机器/统一运维保留。
//
// 通过 esbuild 的 lib10Shims 劫持 `@mnaoumov/obsidian-lib/data-stores/
// local-data-store`（importer 限定 FML/ERH）进入本模块。open() 按开关回退：
//   - window.__myKvBackend === true 且 node:sqlite 可用 → SqliteKvStore
//   - 否则（移动端 / 开关未开）→ 原 IDB 实现（local-data-store.idb.cjs 原样
//     保留的拷贝），行为与上游一致
// 接口面与 vendor 的 LocalDataStore 对齐：static open、get、entries、
// commit({entries, removedKeys})、delete、exclusive、clear、getOrCreate、close。
import { LocalDataStore as IdbLocalDataStore } from "./local-data-store.idb.cjs";

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS plugin_kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (ns, key)
)`;

const DB_PATH = "E:/HOME/Runtime/unified-index/plugin-kv.sqlite";

function backendAvailable(): boolean {
  try {
    if ((globalThis as { __myKvBackend?: boolean }).__myKvBackend !== true) {
      return false;
    }
    // node:sqlite 需要 Node 22.5+；渲染进程缺失时静默回退 IDB
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

/** node:sqlite 后端的 LocalDataStore 兼容实现（面 = DatabaseSync 用到的子集） */
interface KvDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
}

export class SqliteKvStore {
  private db: KvDb | null = null;
  private readonly ns: string;
  private exclusiveTail: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(ns: string) {
    this.ns = ns;
  }

  public static async open(params: {
    pluginId: string;
    storeId: string;
  }): Promise<SqliteKvStore> {
    // node:sqlite 需要 Node 22.5+（Obsidian 桌面端满足；unified-search 主
    // 线程已在用同款模块）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => KvDb;
    };
    const db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=3000");
    db.exec(TABLE_DDL);
    const store = new SqliteKvStore(`${params.pluginId}/${params.storeId}`);
    store.db = db;
    return store;
  }

  private check(): KvDb {
    if (this.closed || !this.db) {
      throw new Error("plugin-kv store is closed");
    }
    return this.db;
  }

  public async get(key: string): Promise<unknown> {
    const db = this.check();
    const row = db
      .prepare("SELECT value FROM plugin_kv WHERE ns = ? AND key = ?")
      .get(this.ns, key) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  public async entries(): Promise<Array<[string, unknown]>> {
    const db = this.check();
    const rows = db
      .prepare("SELECT key, value FROM plugin_kv WHERE ns = ?")
      .all(this.ns) as Array<{ key: string; value: string }>;
    return rows.map((row) => [row.key, JSON.parse(row.value)]);
  }

  public async commit(params: {
    entries: Array<readonly [string, unknown]>;
    removedKeys: string[];
  }): Promise<void> {
    const db = this.check();
    db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = db.prepare(
        "INSERT OR REPLACE INTO plugin_kv (ns, key, value) VALUES (?, ?, ?)"
      );
      const del = db.prepare("DELETE FROM plugin_kv WHERE ns = ? AND key = ?");
      for (const [key, value] of params.entries) {
        upsert.run(this.ns, key, JSON.stringify(value));
      }
      for (const key of params.removedKeys) {
        del.run(this.ns, key);
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  public async delete(key: string): Promise<void> {
    const db = this.check();
    db.prepare("DELETE FROM plugin_kv WHERE ns = ? AND key = ?").run(
      this.ns,
      key
    );
  }

  public async clear(): Promise<void> {
    const db = this.check();
    db.prepare("DELETE FROM plugin_kv WHERE ns = ?").run(this.ns);
  }

  /** 串行互斥（对齐 IDB 版的 exclusive 事务语义） */
  public async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveTail.then(fn, fn);
    this.exclusiveTail = run.catch(() => undefined);
    return run;
  }

  public close(): void {
    this.closed = true;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * 与 vendor LocalDataStore 同签名的入口：开关与 node:sqlite 可用走 sqlite
 * 后端；否则回退原 IDB 实现（本地拷贝，行为与上游一致）。
 */
export class LocalDataStore {
  private inner: SqliteKvStore | IdbLocalDataStore | null = null;

  public static async open(params: {
    factory?: unknown;
    pluginId: string;
    storeId: string;
    vaultId: string;
  }): Promise<LocalDataStore> {
    const store = new LocalDataStore();
    if (backendAvailable()) {
      store.inner = await SqliteKvStore.open({
        pluginId: params.pluginId,
        storeId: params.storeId,
      });
    } else {
      store.inner = await (
        IdbLocalDataStore as unknown as {
          open(p: {
            factory?: unknown;
            pluginId: string;
            storeId: string;
            vaultId: string;
          }): Promise<IdbLocalDataStore>;
        }
      ).open(params);
    }
    return store;
  }

  public async get(key: string): Promise<unknown> {
    return await (this.inner as SqliteKvStore).get(key);
  }

  public async entries(): Promise<Array<[string, unknown]>> {
    return await (this.inner as SqliteKvStore).entries();
  }

  public async commit(params: {
    entries: Array<readonly [string, unknown]>;
    removedKeys: string[];
  }): Promise<void> {
    await (this.inner as SqliteKvStore).commit(params);
  }

  public async delete(key: string): Promise<void> {
    await (this.inner as SqliteKvStore).delete(key);
  }

  public async clear(): Promise<void> {
    await (this.inner as SqliteKvStore).clear();
  }

  public async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return await (this.inner as SqliteKvStore).exclusive(fn);
  }

  public close(): void {
    (this.inner as SqliteKvStore).close();
    this.inner = null;
  }
}
