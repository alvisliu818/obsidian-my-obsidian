/**
 * logseq 索引 · node:sqlite 直连运行时（M2-6，仅桌面端）。
 *
 * wa-sqlite 路线是「内存 VFS + 快照镜像导入导出」——移动端兼容性好，但桌面
 * 每次启动要反序列化整个镜像、每次持久化要导出全量字节。桌面端有 node:sqlite
 * （Electron ≥ Node 22.5），直接打开磁盘上的同一个快照文件：
 *  - 启动零导入（文件即库，wa-sqlite 写的镜像就是合法 SQLite 文件，天然迁移）
 *  - 持久化零导出（`exportImage()` 恒空 → SqliteIndex.persist 短路，数据本就在盘上）
 *  - WAL 模式崩溃安全，正常 close 自动 checkpoint 归并回单文件
 *    （即使崩溃残留 -wal，移动端读主文件最多缺最后的事务——索引可重建，无害）
 *
 * node:sqlite 必须**运行时惰性加载**（函数体内 require，同 lspHost 惯例）：
 * esbuild 把 node:* external 成 cjs require，静态 import 会被提升到模块顶部
 * ——移动端没有 nodeIntegration，整个 bundle 会启动即炸。放函数体内，
 * 移动端永不触达。
 */

import type { SqliteQueryResult, SqliteRuntimeLike } from './sqliteRuntime';

type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync;
type DatabaseSyncInst = InstanceType<DatabaseSyncCtor>;

export class NodeSqliteRuntime implements SqliteRuntimeLike {
  private constructor(private db: DatabaseSyncInst) {}

  /**
   * Open (creating if needed) the database file. `seed` is accepted for
   * interface parity but ignored: the file IS the database on this path.
   */
  static async open(file: string, _seed?: Uint8Array | null): Promise<NodeSqliteRuntime> {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=NORMAL');
    } catch {
      // PRAGMA 失败不致命（只读盘等场景），让后续操作自然报错
    }
    return new NodeSqliteRuntime(db);
  }

  async run(sql: string, params?: unknown[]): Promise<void> {
    if (params && params.length > 0) {
      this.db.prepare(sql).run(...(params as never[]));
    } else {
      this.db.exec(sql);
    }
  }

  async all(sql: string, params?: unknown[], limit = 1000): Promise<SqliteQueryResult> {
    const stmt = this.db.prepare(sql);
    const rowsIn = (params && params.length > 0 ? stmt.all(...(params as never[])) : stmt.all()) as Record<
      string,
      unknown
    >[];
    // node:sqlite 返回对象数组；按列序拆成位置数组（V8 对象键序 = 插入序 = 列序）
    const rows = rowsIn.slice(0, limit).map((row) => Object.values(row));
    const columns = rowsIn.length > 0 ? Object.keys(rowsIn[0]) : [];
    return { columns, rows };
  }

  async batch(queries: string[], params?: unknown[][]): Promise<number> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (let i = 0; i < queries.length; i++) {
        const p = params?.[i];
        if (p && p.length > 0) this.db.prepare(queries[i]).run(...(p as never[]));
        else this.db.exec(queries[i]);
      }
      this.db.exec('COMMIT');
      return 0;
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 已自动回滚
      }
      return -1;
    }
  }

  /** Direct-file mode: nothing to export — persist() short-circuits on empty. */
  exportImage(): Uint8Array {
    return new Uint8Array(0);
  }

  async integrityCheck(): Promise<boolean> {
    try {
      const row = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      return row?.quick_check === 'ok';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // WAL 在正常 close 时自动 checkpoint 进主文件并移除 -wal（快照回到单文件，
    // 移动端 wa-sqlite 仍可读）
    this.db.close();
  }
}

/** 删除库文件及其 WAL 伴生文件（integrity 门判废重建用；不存在则静默） */
export function destroyNodeSqliteFile(file: string): void {
  const { unlinkSync } = require('fs') as typeof import('fs');
  for (const p of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      unlinkSync(p);
    } catch {
      // 文件不存在等，忽略
    }
  }
}
