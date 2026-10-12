/**
 * wa-sqlite runtime: load the WASM, register an in-memory VFS, expose a
 * small promise-based API, and import/export the database image.
 *
 * Running over a memory VFS is deliberate:
 *   - no OPFS / IndexedDB / origin quirks, so the same code path works on
 *     desktop and mobile and under vitest;
 *   - the database is a CACHE, so it is loaded from (and written back to) a
 *     plain binary file — and if that file is missing or corrupt we simply
 *     rebuild from markdown.
 *
 * The WASM is compiled from `node_modules/wa-sqlite/dist/wa-sqlite.wasm` and
 * embedded into main.js as base64 by esbuild (see esbuild.mjs), which is why
 * this module never has to fetch anything at runtime.
 */

import ModuleFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import { Factory, SQLITE_ROW } from 'wa-sqlite';
import { MemoryVFS } from 'wa-sqlite/src/examples/MemoryVFS.js';

/** `SQLiteAPI` is not exported by wa-sqlite's .d.ts — derive it instead. */
export type Sqlite3Api = ReturnType<typeof Factory>;

/**
 * wa-sqlite ships two slightly different VFS shapes (`VFS.Base` declares
 * `{size, value}` wrappers over the raw buffer). The runtime only ever passes
 * a Uint8Array, so the example VFS is registered through a cast.
 */
type VfsArg = Parameters<Sqlite3Api['vfs_register']>[0];

/** Where the wasm bytes come from; overridable so tests can read from disk. */
export type WasmProvider = () => Uint8Array | Promise<Uint8Array>;

/**
 * Injected by esbuild (`define`). Declared as possibly-undefined so this
 * module also loads outside a bundled build (vitest), where a provider is
 * supplied explicitly instead.
 */
declare const __WA_SQLITE_WASM_B64__: string | undefined;

let injectedProvider: WasmProvider | null = null;

/** Override the wasm source (tests read the file from node_modules). */
export function setWasmProvider(p: WasmProvider | null): void {
  injectedProvider = p;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function defaultWasm(): Promise<Uint8Array> {
  const b64 = typeof __WA_SQLITE_WASM_B64__ === 'string' ? __WA_SQLITE_WASM_B64__ : '';
  if (!b64) throw new Error('wa-sqlite wasm is not embedded in this build');
  return base64ToBytes(b64);
}

export interface SqliteQueryResult {
  columns: string[];
  rows: unknown[][];
}

/** Flags: SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE. */
const OPEN_FLAGS = 0x4 | 0x2;

/**
 * A live SQLite database over a memory VFS. Exposes only what the index needs.
 */
export class SqliteRuntime {
  readonly sqlite3: Sqlite3Api;
  readonly db: number;
  private vfs: MemoryVFS;
  private file: string;

  private constructor(sqlite3: Sqlite3Api, db: number, vfs: MemoryVFS, file: string) {
    this.sqlite3 = sqlite3;
    this.db = db;
    this.vfs = vfs;
    this.file = file;
  }

  /**
   * Boot wa-sqlite and open `file` inside a fresh memory VFS.
   * `seed` is a previously exported database image (may be empty).
   */
  static async open(
    file: string,
    seed?: Uint8Array | null,
    wasm?: WasmProvider | null,
  ): Promise<SqliteRuntime> {
    const bytes = await (wasm ?? injectedProvider ?? defaultWasm)();
    // `wasmBinary` short-circuits Emscripten's fetch, which has no resolvable
    // URL inside an Obsidian plugin bundle. `locateFile` keeps the
    // `new URL('wa-sqlite.wasm', import.meta.url)` branch from ever running
    // (import.meta is empty in the CJS output).
    const module = await ModuleFactory({
      wasmBinary: bytes,
      locateFile: () => 'wa-sqlite.wasm',
    });
    const sqlite3 = Factory(module);
    const vfs = new MemoryVFS();
    sqlite3.vfs_register(vfs as unknown as VfsArg, true);
    if (seed && seed.byteLength > 0) {
      const copy = new Uint8Array(seed);
      vfs.mapNameToFile.set(file, {
        name: file,
        flags: 0,
        size: copy.byteLength,
        data: copy.buffer,
      });
    }
    const db = await sqlite3.open_v2(file, OPEN_FLAGS, vfs.name);
    return new SqliteRuntime(sqlite3, db, vfs, file);
  }

  /** Statements that produce no rows. */
  async run(sql: string, params?: unknown[]): Promise<void> {
    if (params && params.length > 0) await this.sqlite3.run(this.db, sql, params as never);
    else await this.sqlite3.exec(this.db, sql);
  }

  /** One statement, all result rows (capped by `limit`). */
  async all(sql: string, params?: unknown[], limit = 1000): Promise<SqliteQueryResult> {
    const str = this.sqlite3.str_new(this.db, sql);
    try {
      const prepared = await this.sqlite3.prepare_v2(this.db, this.sqlite3.str_value(str));
      if (!prepared) return { columns: [], rows: [] };
      const stmt = prepared.stmt;
      try {
        if (params && params.length > 0) this.sqlite3.bind_collection(stmt, params as never);
        const columns = this.sqlite3.column_names(stmt);
        const rows: unknown[][] = [];
        while ((await this.sqlite3.step(stmt)) === SQLITE_ROW) {
          if (rows.length >= limit) break;
          rows.push(this.sqlite3.row(stmt) as unknown[]);
        }
        return { columns, rows };
      } finally {
        await this.sqlite3.finalize(stmt);
      }
    } finally {
      this.sqlite3.str_finish(str);
    }
  }

  /**
   * Many writes in one atomic batch (wa-sqlite wraps them in a transaction).
   * Returns SQLite's result code — `undefined` means the batch was rolled
   * back, which the caller MUST treat as failure (wa-sqlite swallows the
   * underlying error).
   */
  async batch(queries: string[], params?: unknown[][]): Promise<number> {
    const rc = await this.sqlite3.executeBatch(this.db, queries, (params ?? []) as never);
    return typeof rc === 'number' ? rc : -1;
  }

  /**
   * Serialize the whole database to bytes. Safe to call while open: the index
   * only commits complete per-file transactions, so the file image is a
   * consistent database — and a bad image is recoverable by rebuilding.
   */
  exportImage(): Uint8Array {
    const entry = this.vfs.mapNameToFile.get(this.file) as { size: number; data: ArrayBuffer } | undefined;
    if (!entry) return new Uint8Array(0);
    return new Uint8Array(entry.data.slice(0, entry.size));
  }

  async integrityCheck(): Promise<boolean> {
    try {
      const res = await this.all('PRAGMA quick_check', undefined, 1);
      return res.rows[0]?.[0] === 'ok';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.sqlite3.close(this.db);
  }
}
