/**
 * logseq 索引 · SQLite 运行时接口。
 *
 * 两套实现共用同一异步方法面（M2-6）：
 *  - waSqlite.SqliteRuntime：WASM + 内存 VFS + 快照镜像（通用，含移动端）
 *  - nodeSqlite.NodeSqliteRuntime：node:sqlite 直连磁盘文件（仅桌面，
 *    免镜像导入导出；`exportImage()` 恒空，SqliteIndex.persist 据此短路）
 */

export interface SqliteQueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface SqliteRuntimeLike {
  /** Statements that produce no rows. */
  run(sql: string, params?: unknown[]): Promise<void>;
  /** One statement, all result rows (capped by `limit`). */
  all(sql: string, params?: unknown[], limit?: number): Promise<SqliteQueryResult>;
  /**
   * Many writes in one atomic batch. Returns 0 on success, non-zero on
   * failure (batch must have been rolled back).
   */
  batch(queries: string[], params?: unknown[][]): Promise<number>;
  /** Whole-database image; empty in direct-file mode (nothing to export). */
  exportImage(): Uint8Array;
  integrityCheck(): Promise<boolean>;
  close(): Promise<void>;
}
