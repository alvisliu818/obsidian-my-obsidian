/**
 * 索引守护进程（档位 2 · 进程级隔离，思源同款）。
 *
 * 一个独立的 Node 进程独占 logseq-index.sqlite：全量重建/增量 upsert/全部
 * 查询都发生在这里，渲染进程只是 stdio 上的瘦客户端。收益：
 *   - 渲染进程不再驻留 ~99 万块的对象图（JS 堆 -160~190MB）
 *   - 写入/重建/慢查询永不阻塞 UI 线程（物理隔离，不是调度让步）
 *   - 渲染进程崩溃不牵连索引——DB 在磁盘上，守护进程还活着
 *
 * 协议（stdio，一行一个 JSON）：
 *   → {id, op, ...}          请求；op ∈ ping|rebuild|sync|upsert|delete|
 *                              setExclude|stats|query|close
 *   ← {id, ok, data}         应答（ok=false 时 data=error 字符串）
 *   ← {ev:'hello', proto, pid}          启动握手
 *   ← {ev:'progress', done, total}      重建/同步进度
 *   ← {ev:'changed', version}           任何变更后广播（客户端据此失效缓存）
 *
 * 复用面：fileFacts.extractFile（唯一提取器）+ SqliteIndex（写入管道）+
 * sqliteSchema（含 eff_refs/cards/supertags 物化表）——与渲染进程旧路径
 * 同源，二者对同一文件永远一致。
 *
 * CLI 一次性模式（构建/调试/基准）：
 *   node index-daemon.js --db <file> --vault <dir> [--exclude a,b] --rebuild
 *   node index-daemon.js ... --sync
 *   node index-daemon.js ... --query '{"q":"backlinksTo","args":{"page":"foo"}}'
 */

import * as fs from 'fs';
import * as path from 'path';
import { SqliteIndex, type SqliteFileSource } from '../../../logseq/src/index/sqliteIndex';
import { buildFileStatements, deleteFileStatements, type Stmt } from '../../../logseq/src/index/sqliteIndex';
import { extractFile } from '../../../logseq/src/index/fileFacts';
import { hashText } from '../../../logseq/src/index/sqliteSchema';
import { SCHEMA_SQL, FTS_STATEMENTS } from '../../../logseq/src/index/sqliteSchema';
import * as os from 'os';
import type { SqliteFileMeta } from '../../../logseq/src/index/sqliteSchema';
import type { SqliteRuntimeLike } from '../../../logseq/src/index/sqliteRuntime';

// ---------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------

interface Args {
  db: string;
  vault: string;
  exclude: string[];
  oneShot: 'rebuild' | 'sync' | 'query' | null;
  query: unknown;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { db: '', vault: '', exclude: [], oneShot: null, query: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i] ?? '';
    else if (a === '--vault') out.vault = argv[++i] ?? '';
    else if (a === '--exclude') out.exclude = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--rebuild') out.oneShot = 'rebuild';
    else if (a === '--sync') out.oneShot = 'sync';
    else if (a === '--query') { out.oneShot = 'query'; out.query = JSON.parse(argv[++i] ?? '{}'); }
  }
  return out;
}

// ---------------------------------------------------------------------
// FsSource：SqliteIndex 的文件源（vault 直读，路径用 '/' 相对分隔）
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// better-sqlite3 运行时(FTS5 预编译):守护进程优先;不可用回落 node:sqlite。
// require 在函数体内——裸 node 从插件目录 node_modules 解析(构建期 external)。
// ---------------------------------------------------------------------

type BetterSqlite3Db = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...p: unknown[]): unknown;
    all(...p: unknown[]): Record<string, unknown>[];
    get(...p: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
};

class BetterSqliteRuntime implements SqliteRuntimeLike {
  private constructor(private db: BetterSqlite3Db) {}

  static open(file: string): BetterSqliteRuntime {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as unknown as new (f: string) => BetterSqlite3Db;
    const db = new Database(file);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    return new BetterSqliteRuntime(db);
  }

  async run(sql: string, params?: unknown[]): Promise<void> {
    if (params && params.length > 0) this.db.prepare(sql).run(...params);
    else this.db.exec(sql);
  }

  async all(sql: string, params?: unknown[], limit = 1000) {
    const stmt = this.db.prepare(sql);
    const rowsIn = params && params.length > 0 ? stmt.all(...params) : stmt.all();
    const rows = rowsIn.slice(0, limit).map((row) => Object.values(row));
    return { columns: rowsIn.length > 0 ? Object.keys(rowsIn[0]) : [], rows };
  }

  async batch(queries: string[], params?: unknown[][]): Promise<number> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (let i = 0; i < queries.length; i++) {
        const pr = params?.[i];
        if (pr && pr.length > 0) this.db.prepare(queries[i]).run(...pr);
        else this.db.exec(queries[i]);
      }
      this.db.exec('COMMIT');
      return 0;
    } catch (e) {
      process.stderr.write(`[bs3-batch] ${String(e).slice(0, 200)} | first sql: ${(queries[0] ?? '').slice(0, 80)}
`);
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 已回滚 */
      }
      return -1;
    }
  }

  exportImage(): Uint8Array {
    return new Uint8Array(0);
  }

  async integrityCheck(): Promise<boolean> {
    try {
      return this.db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** 打开库:better-sqlite3(FTS5)优先,node:sqlite 兜底(无 FTS5,LIKE 回落)。 */
async function openRuntime(file: string): Promise<SqliteRuntimeLike> {
  try {
    return BetterSqliteRuntime.open(file);
  } catch (e) {
    process.stderr.write(
      `[index-daemon] better-sqlite3 unavailable (${String(e).slice(0, 90)}), fallback node:sqlite (no FTS5)\n`,
    );
    const { NodeSqliteRuntime } = (await import(
      '../../../logseq/src/index/nodeSqlite'
    )) as typeof import('../../../logseq/src/index/nodeSqlite');
    return NodeSqliteRuntime.open(file);
  }
}

const HIDDEN_DIRS = new Set(['.obsidian', '.trash', '.git', '.logseq-editor', '.versions(SH)']);

class FsSource implements SqliteFileSource {
  private excludes: string[];

  constructor(private vault: string, excludes: string[]) {
    this.excludes = excludes.map((e) => e.replace(/^\/+|\/+$/g, '').toLowerCase());
  }

  setExcludes(list: string[]): void {
    this.excludes = list.map((e) => e.replace(/^\/+|\/+$/g, '').toLowerCase());
  }

  private isExcluded(rel: string): boolean {
    const lower = rel.toLowerCase();
    return this.excludes.some((e) => lower === e || lower.startsWith(e + '/'));
  }

  listMarkdownFiles(): SqliteFileMeta[] {
    const out: SqliteFileMeta[] = [];
    const walk = (abs: string, rel: string): void => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const n of names) {
        if (n.name.startsWith('.')) continue;
        const childRel = rel ? `${rel}/${n.name}` : n.name;
        if (n.isDirectory()) {
          if (HIDDEN_DIRS.has(n.name)) continue;
          if (this.isExcluded(childRel)) continue;
          walk(path.join(abs, n.name), childRel);
        } else if (n.isFile() && n.name.toLowerCase().endsWith('.md')) {
          if (this.isExcluded(childRel)) continue;
          let st: fs.Stats;
          try {
            st = fs.statSync(path.join(abs, n.name));
          } catch {
            continue;
          }
          out.push({ path: childRel, mtime: Math.floor(st.mtimeMs), size: st.size });
        }
      }
    };
    walk(this.vault, '');
    return out;
  }

  async read(rel: string): Promise<string> {
    return fs.promises.readFile(path.join(this.vault, rel), 'utf8');
  }
}

// ---------------------------------------------------------------------
// 查询层：BlockIndex 的 API 形状，纯 SQL（物化表见 sqliteSchema）
// ---------------------------------------------------------------------

/** 与 IndexedBlock 同形（客户端零适配）。 */
export interface DaemonBlock {
  bkey: string;
  path: string;
  blockId: string;
  text: string;
  marker: string | null;
  tags: string[];
  links: string[];
  props: Record<string, string>;
  blockProps: Record<string, string>;
  parentId: string;
}

export interface DaemonBacklink {
  sourcePath: string;
  blockId: string;
  text: string;
  marker: string | null;
  refs: string[];
}

export interface DaemonCard {
  path: string;
  blockId: string;
  question: string;
  answer: string;
  marker: string | null;
  props: Record<string, string>;
}

class Queries {
  private rt: SqliteRuntimeLike;

  constructor(rt: SqliteRuntimeLike) {
    this.rt = rt;
  }

  private async rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const res = await this.rt.all(sql, params, 100000);
    return res.rows.map((r) => {
      const o: Record<string, unknown> = {};
      res.columns.forEach((c, i) => (o[c] = r[i]));
      return o;
    });
  }

  private static hydrate(
    r: Record<string, unknown>,
    tags: string | null,
    links: string | null,
    propsJson: string | null,
  ): DaemonBlock {
    let props: Record<string, string> = {};
    try {
      if (propsJson) props = JSON.parse(propsJson) as Record<string, string>;
    } catch {
      /* 容错 */
    }
    return {
      bkey: String(r.bkey ?? ''),
      path: String(r.path ?? ''),
      blockId: String(r.block_id ?? ''),
      text: String(r.text ?? ''),
      marker: r.marker == null ? null : String(r.marker),
      tags: tags ? tags.split('\u0001').filter(Boolean) : [],
      links: links ? links.split('\u0001').filter(Boolean) : [],
      props: {},
      blockProps: props,
      parentId: String(r.parent_id ?? ''),
    };
  }

  /** 块行 + tags/links/props 一次 JOIN 水化（GROUP_CONCAT 以 \u0001 分隔避免撞逗号）。 */
  private static readonly BLOCK_SQL = `
    SELECT b.bkey, b.block_id, b.path, b.ord, b.depth, b.parent_id, b.text, b.marker,
      (SELECT group_concat(t.tag, char(1)) FROM tags t WHERE t.bkey = b.bkey) AS tags,
      (SELECT group_concat(l.target, char(1)) FROM links l WHERE l.bkey = b.bkey) AS links,
      (SELECT json_group_object(p.key, p.value) FROM props p WHERE p.bkey = b.bkey) AS props_json
    FROM blocks b`;

  async getById(blockId: string): Promise<DaemonBlock | null> {
    const rs = await this.rows(`${Queries.BLOCK_SQL} WHERE b.block_id = ? LIMIT 1`, [blockId]);
    return rs[0] ? Queries.hydrate(rs[0], rs[0].tags as string, rs[0].links as string, rs[0].props_json as string) : null;
  }

  async withIds(): Promise<DaemonBlock[]> {
    const rs = await this.rows(`${Queries.BLOCK_SQL} WHERE b.block_id != ''`, []);
    return rs.map((r) => Queries.hydrate(r, r.tags as string, r.links as string, r.props_json as string));
  }

  async blocksByPath(p: string): Promise<DaemonBlock[]> {
    const rs = await this.rows(`${Queries.BLOCK_SQL} WHERE b.path = ? ORDER BY b.ord`, [p]);
    return rs.map((r) => Queries.hydrate(r, r.tags as string, r.links as string, r.props_json as string));
  }

  async allTags(): Promise<string[]> {
    const rs = await this.rows('SELECT DISTINCT tag FROM tags ORDER BY tag', []);
    return rs.map((r) => String(r.tag));
  }

  async tagsByPath(p: string): Promise<string[]> {
    const rs = await this.rows(
      'SELECT DISTINCT t.tag FROM tags t JOIN blocks b ON b.bkey = t.bkey WHERE b.path = ? ORDER BY t.tag',
      [p],
    );
    return rs.map((r) => String(r.tag));
  }

  /** 页面级反链（links 命中目标页名，排除自身文件）。 */
  async backlinksTo(page: string, selfPath: string): Promise<DaemonBacklink[]> {
    const rs = await this.rows(
      `SELECT b.path, b.block_id, b.text, b.marker,
         (SELECT group_concat(e.target, char(1)) FROM eff_refs e WHERE e.bkey = b.bkey) AS refs
       FROM links l JOIN blocks b ON b.bkey = l.bkey
       WHERE l.target = ? AND lower(b.path) != lower(?)`,
      [page, selfPath],
    );
    return rs.map((r) => ({
      sourcePath: String(r.path),
      blockId: String(r.block_id ?? ''),
      text: String(r.text ?? ''),
      marker: r.marker == null ? null : String(r.marker),
      refs: r.refs ? String(r.refs).split('\u0001').filter(Boolean) : [],
    }));
  }

  /** 块引用反链（((id)) 命中，排除自身块）。 */
  async refsToBlock(id: string): Promise<DaemonBacklink[]> {
    const rs = await this.rows(
      `SELECT b.path, b.block_id, b.text, b.marker,
         (SELECT group_concat(e.target, char(1)) FROM eff_refs e WHERE e.bkey = b.bkey) AS refs
       FROM refs r JOIN blocks b ON b.bkey = r.bkey
       WHERE r.target_id = ? AND b.block_id != ?`,
      [id, id],
    );
    return rs.map((r) => ({
      sourcePath: String(r.path),
      blockId: String(r.block_id ?? ''),
      text: String(r.text ?? ''),
      marker: r.marker == null ? null : String(r.marker),
      refs: r.refs ? String(r.refs).split('\u0001').filter(Boolean) : [],
    }));
  }

  async allCards(): Promise<DaemonCard[]> {
    const rs = await this.rows('SELECT path, block_id, question, answer, marker, props_json FROM cards', []);
    return rs.map((r) => {
      let props: Record<string, string> = {};
      try {
        if (r.props_json) props = JSON.parse(String(r.props_json)) as Record<string, string>;
      } catch {
        /* 容错 */
      }
      return {
        path: String(r.path),
        blockId: String(r.block_id ?? ''),
        question: String(r.question ?? ''),
        answer: String(r.answer ?? ''),
        marker: r.marker == null ? null : String(r.marker),
        props,
      };
    });
  }

  async supertags(): Promise<{ name: string; path: string; fields: unknown[]; parents: string[] }[]> {
    const rs = await this.rows('SELECT name, path, props_json FROM supertags', []);
    return rs.map((r) => {
      let parsed: { fields?: unknown[]; parents?: string[] } = {};
      try {
        parsed = JSON.parse(String(r.props_json ?? '{}')) as { fields?: unknown[]; parents?: string[] };
      } catch {
        /* 容错 */
      }
      return { name: String(r.name), path: String(r.path), fields: parsed.fields ?? [], parents: parsed.parents ?? [] };
    });
  }

  async supertagInstances(tag: string): Promise<DaemonBlock[]> {
    const rs = await this.rows(
      `${Queries.BLOCK_SQL} WHERE b.bkey IN (SELECT t.bkey FROM tags t WHERE t.tag = ?)`,
      [tag.toLowerCase()],
    );
    return rs.map((r) => Queries.hydrate(r, r.tags as string, r.links as string, r.props_json as string));
  }

  /**
   * 未连提及/块搜索扫描。FTS5 可用且 >=3 字符 → trigram MATCH(中文子串,
   * 毫秒级);否则 LIKE 全库扫(~237ms,可接受——老内存版 scanFor 也是全库扫)。
   */
  /**
   * 统一搜索(unified-search modal)的查询面:调用方把用户查询编译成 FTS5
   * MATCH 表达式(所有 token 已双引号包裹、内部引号转义——用户输入永不直通,
   * 见 unified-search/src/matchBuilder)。JOIN blocks 取 block_id 供 #^锚点
   * 打开;trigram tokenizer,子串命中,中文毫秒级。
   */
  async fts(match: string, excludePath: string, limit: number): Promise<{ bkey: string; path: string; blockId: string; text: string }[]> {
    const lim = Math.max(1, Math.min(limit || 50, 500));
    const rs = await this.rows(
      `SELECT s.bkey, s.path, s.text, b.block_id FROM
         (SELECT bkey, path, text FROM blocks_fts WHERE blocks_fts MATCH ? AND path != ? LIMIT ?) s
       JOIN blocks b ON b.bkey = s.bkey`,
      [match, excludePath, lim],
    );
    return rs.map((r) => ({
      bkey: String(r.bkey ?? ''),
      path: String(r.path ?? ''),
      blockId: String(r.block_id ?? ''),
      text: String(r.text ?? ''),
    }));
  }

  async scan(pattern: string, excludePath: string, limit: number, fts: boolean): Promise<{ bkey: string; path: string; text: string }[]> {
    const lim = Math.max(1, Math.min(limit || 200, 2000));
    let rs: Record<string, unknown>[];
    if (fts && pattern.length >= 3) {
      const q = '"' + pattern.replace(/"/g, '""') + '"';
      rs = await this.rows(
        'SELECT bkey, path, text FROM blocks_fts WHERE blocks_fts MATCH ? AND path != ? LIMIT ?',
        [q, excludePath, lim],
      );
    } else {
      const esc = pattern.replace(/([%_\\])/g, '\\$1');
      rs = await this.rows(
        "SELECT bkey, path, text FROM blocks WHERE text LIKE ? ESCAPE '\\' AND path != ? LIMIT ?",
        [`%${esc}%`, excludePath, lim],
      );
    }
    return rs.map((r) => ({ bkey: String(r.bkey), path: String(r.path), text: String(r.text) }));
  }
}

// ---------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.vault) {
    process.stderr.write('usage: index-daemon.js --db <file> --vault <dir> [--exclude a,b] [--rebuild|--sync|--query <json>]\n');
    process.exit(2);
  }

  const source = new FsSource(args.vault, args.exclude);
  const write = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  const idx = new SqliteIndex({
    source,
    runtimeFactory: () => openRuntime(args.db),
    onProgress: (done, total) => {
      if (!args.oneShot) write({ ev: 'progress', done, total });
    },
  });

  let version = 0;
  let queries: Queries | null = null;
  let fts = false;
  const ftsEnabled = (): boolean => fts;

  // SqliteIndex.open() 惰性（首个操作触发）——为查询层先显式 open 一次。
  const ensureOpen = async (): Promise<void> => {
    await idx.open();
    if (idx.lastError) throw new Error(String(idx.lastError));
    const rt = (idx as unknown as { rt?: SqliteRuntimeLike | null }).rt;
    if (!rt) throw new Error('runtime unavailable');
    if (!queries) queries = new Queries(rt);
    const wasFts = fts;
    fts = (idx as unknown as { ftsEnabled?: boolean }).ftsEnabled === true;
    if (!args.oneShot && fts !== wasFts) write({ ev: 'fts', enabled: fts });
  };

  const mutate = async (fn: () => Promise<unknown>): Promise<unknown> => {
    const r = await fn();
    version++;
    if (!args.oneShot) write({ ev: 'changed', version });
    return r;
  };

  /**
   * 狂暴重建:读+解析并发(纯函数,无共享状态),写入侧单线程批量事务。
   * 与 idx.rebuild() 的差别:不排队(enqueue 直接短路)、并发池吃满 CPU、
   * PRAGMA synchronous=OFF(崩溃也只是索引重建,可丢)。结果 stats 同形。
   */
  const turboRebuild = async (
    idxT: SqliteIndex,
    src: FsSource,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ files: number; blocks: number }> => {
    await idxT.open();
    if (idxT.lastError) throw new Error(String(idxT.lastError));
    const rt = (idxT as unknown as { rt?: SqliteRuntimeLike }).rt;
    if (!rt) throw new Error('runtime unavailable');
    const fts = (idxT as unknown as { ftsEnabled?: boolean }).ftsEnabled === true;
    // 狂暴 pragma:重建期间允许丢(索引可重建),换最大写入吞吐。
    await rt.run('PRAGMA synchronous=OFF').catch(() => {});
    await rt.run('PRAGMA cache_size=-262144').catch(() => {}); // 256MB 页缓存
    await (idxT as unknown as { dropAll?: (rt: SqliteRuntimeLike) => Promise<void> }).dropAll?.(rt);
    for (const sql of SCHEMA_SQL) await rt.run(sql);
    await rt.run('PRAGMA user_version = 0').catch(() => {});
    await rt.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', '3']).catch(() => {});
    if (fts) {
      for (const sql of FTS_STATEMENTS) await rt.run(sql).catch(() => {});
    }

    const files = src.listMarkdownFiles();
    let done = 0;
    let blocks = 0;
    let okFiles = 0;
    // 并发读+解析(纯 CPU,extractFile 无状态)。解析结果**流式进库**:
    // 旧实现把全库语句攒在 parsed[] 里最后统一写——主库(1.43GB)实测
    // daemon 内存涨到 GB 级。现在走写链串行 batch,读快于写时用
    // outstanding 上限做背压,内存有界。
    const concurrency = Math.max(4, Math.min(32, (os.cpus()?.length ?? 8) * 2));
    let writeChain: Promise<void> = Promise.resolve();
    let outstanding = 0;
    let writeFailed: string | null = null;
    const enqueueWrite = (stmts: Stmt[]): void => {
      outstanding++;
      writeChain = writeChain
        .then(async () => {
          await rt.batch(stmts.map((st) => st.sql), stmts.map((st) => st.params));
          okFiles++;
        })
        .catch((e) => {
          writeFailed = writeFailed ?? String(e).slice(0, 200);
        })
        .finally(() => {
          outstanding--;
        });
    };
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const i = cursor++;
        const f = files[i];
        try {
          if (f.size <= 2_000_000) {
            const content = await src.read(f.path);
            const facts = extractFile(f.path, content);
            enqueueWrite(buildFileStatements(facts, f, hashText(content), fts));
          }
        } catch {
          /* 单文件失败不挡全库(与渲染内路径同语义) */
        }
        done++;
        if (done % 25 === 0 || done === files.length) onProgress(done, files.length);
        if (outstanding > 128) await writeChain; // 背压:写入落后就等一等
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await writeChain;
    if (writeFailed) throw new Error(`turbo write failed: ${writeFailed}`);
    const counts = await rt.all('SELECT (SELECT COUNT(*) FROM blocks) b, (SELECT COUNT(*) FROM files) f', [], 4);
    blocks = Number(counts.rows[0]?.[0] ?? 0);
    const totalFiles = Number(counts.rows[0]?.[1] ?? okFiles);
    // 恢复安全 pragma + 记录完成时间。
    await rt.run('PRAGMA synchronous=NORMAL').catch(() => {});
    await rt.run('PRAGMA cache_size=-2000').catch(() => {});
    await rt.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['built_at', String(Date.now())]).catch(() => {});
    return { files: totalFiles, blocks };
  };

  /**
   * 狂暴增量(sync):files 表对 mtime/size,只重读变更文件——变更集同样走
   * 并发读+解析池。日常编辑后的补索引用这条(几百 ms 级),全量重建才用
   * turboRebuild。
   */
  const turboSync = async (
    idxS: SqliteIndex,
    src: FsSource,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ files: number; blocks: number }> => {
    await idxS.open();
    if (idxS.lastError) throw new Error(String(idxS.lastError));
    const rt = (idxS as unknown as { rt?: SqliteRuntimeLike }).rt;
    if (!rt) throw new Error('runtime unavailable');
    const fts = (idxS as unknown as { ftsEnabled?: boolean }).ftsEnabled === true;
    await rt.run('PRAGMA synchronous=OFF').catch(() => {});
    const vault = src.listMarkdownFiles();
    const idxRes = await rt.all('SELECT path, mtime, size FROM files', undefined, 500_000);
    const known = new Map<string, [number, number]>();
    for (const r of idxRes.rows) known.set(String(r[0]), [Number(r[1]), Number(r[2])]);
    const pending = vault.filter((f) => {
      const k = known.get(f.path);
      return !k || k[0] !== f.mtime || k[1] !== f.size;
    });
    // 删除:库里有而盘上没有的。
    const onDisk = new Set(vault.map((f) => f.path));
    for (const [p] of known) {
      if (!onDisk.has(p)) {
        const stmts = deleteFileStatements(p);
        await rt.batch(stmts.map((st) => st.sql), stmts.map((st) => st.params));
      }
    }
    let done = 0;
    const concurrency = Math.max(4, Math.min(32, (os.cpus()?.length ?? 8) * 2));
    // 同 turboRebuild:流式进库 + 背压,不全库攒语句。
    let writeChain: Promise<void> = Promise.resolve();
    let outstanding = 0;
    let writeFailed: string | null = null;
    const enqueueWrite = (stmts: Stmt[]): void => {
      outstanding++;
      writeChain = writeChain
        .then(async () => {
          await rt.batch(stmts.map((st) => st.sql), stmts.map((st) => st.params));
        })
        .catch((e) => {
          writeFailed = writeFailed ?? String(e).slice(0, 200);
        })
        .finally(() => {
          outstanding--;
        });
    };
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) {
        const i = cursor++;
        const f = pending[i];
        try {
          if (f.size <= 2_000_000) {
            const content = await src.read(f.path);
            const facts = extractFile(f.path, content);
            enqueueWrite(buildFileStatements(facts, f, hashText(content), fts));
          }
        } catch {
          /* 单文件失败不挡全库 */
        }
        done++;
        if (done % 10 === 0 || done === pending.length) onProgress(done, pending.length);
        if (outstanding > 128) await writeChain;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await writeChain;
    if (writeFailed) throw new Error(`turbo write failed: ${writeFailed}`);
    await rt.run('PRAGMA synchronous=NORMAL').catch(() => {});
    const counts = await rt.all('SELECT (SELECT COUNT(*) FROM blocks) b, (SELECT COUNT(*) FROM files) f', [], 4);
    return { files: Number(counts.rows[0]?.[1] ?? 0), blocks: Number(counts.rows[0]?.[0] ?? 0) };
  };

  const handle = async (msg: {
    id?: number;
    op?: string;
    paths?: string[];
    path?: string;
    folders?: string[];
    q?: string;
    args?: Record<string, unknown>;
  }): Promise<unknown> => {
    switch (msg.op) {
      case 'ping':
        return 'pong';
      case 'rebuild':
        return mutate(() => idx.rebuild());
      case 'turbo': {
        // 狂暴模式(用户指定,2026-10-25):尽可能占资源跑索引——读+解析全并发
        // (extractFile 是纯函数,Promise 池=os.cpus()*2),写入是大批量事务,
        // PRAGMA synchronous=OFF 让盘也狂。mode=sync 走增量(只补变更文件),
        // 否则全量重建。两条路径同一个并发池。
        const mode = (msg as { mode?: string }).mode ?? 'rebuild';
        return mutate(async () => {
          const t0 = Date.now();
          const r =
            mode === 'sync'
              ? await turboSync(idx, source, (done, total) => {
                  if (!args.oneShot) write({ ev: 'progress', done, total });
                })
              : await turboRebuild(idx, source, (done, total) => {
                  if (!args.oneShot) write({ ev: 'progress', done, total });
                });
          return { ...r, ms: Date.now() - t0 };
        });
      }
      case 'sync':
        return mutate(() => idx.sync());
      case 'upsert': {
        const paths = msg.paths ?? [];
        return mutate(async () => {
          for (const p of paths) await idx.syncFile(p);
          return { files: paths.length };
        });
      }
      case 'delete': {
        const paths = msg.paths ?? [];
        return mutate(async () => {
          for (const p of paths) {
            await (idx as unknown as { forgetFile?: (p: string) => Promise<void> }).forgetFile?.(p);
          }
          return { files: paths.length };
        });
      }
      case 'setExclude':
        source.setExcludes(msg.folders ?? []);
        return { ok: true };
      case 'stats': {
        await ensureOpen();
        const files = (await idx as unknown as { stats?(): Promise<unknown> }).stats?.();
        return files ?? null;
      }
      case 'close':
        await idx.close();
        return { closing: true };
      case 'query': {
        await ensureOpen();
        const q = queries as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>;
        const fn = q[msg.q ?? ''];
        if (typeof fn !== 'function') throw new Error(`unknown query: ${String(msg.q)}`);
        const a = msg.args ?? {};
        // 参数名按查询各自约定
        if (msg.q === 'getById') return fn.call(queries, String(a.blockId ?? ''));
        if (msg.q === 'blocksByPath' || msg.q === 'tagsByPath') return fn.call(queries, String(a.path ?? ''));
        if (msg.q === 'backlinksTo') return fn.call(queries, String(a.page ?? ''), String(a.selfPath ?? ''));
        if (msg.q === 'refsToBlock') return fn.call(queries, String(a.id ?? ''));
        if (msg.q === 'supertagInstances') return fn.call(queries, String(a.tag ?? ''));
        if (msg.q === 'scan')
          return fn.call(queries, String(a.pattern ?? ''), String(a.excludePath ?? ''), Number(a.limit ?? 200), ftsEnabled());
        if (msg.q === 'fts')
          return fn.call(queries, String(a.match ?? ''), String(a.excludePath ?? ''), Number(a.limit ?? 50));
        return fn.call(queries);
      }
      default:
        throw new Error(`unknown op: ${String(msg.op)}`);
    }
  };

  // ---- 一次性模式 ----
  if (args.oneShot) {
    await ensureOpen().catch((e) => {
      process.stderr.write(`open failed: ${String(e)}\n`);
      process.exit(1);
    });
    try {
      if (args.oneShot === 'rebuild') {
        const t0 = Date.now();
        const st = await idx.rebuild();
        process.stderr.write(`rebuilt: ${JSON.stringify(st)} in ${Date.now() - t0}ms\n`);
      } else if (args.oneShot === 'sync') {
        const t0 = Date.now();
        const st = await idx.sync();
        process.stderr.write(`synced: ${JSON.stringify(st)} in ${Date.now() - t0}ms\n`);
      } else if (args.oneShot === 'query') {
        const msg = args.query as { q?: string; args?: Record<string, unknown> };
        const data = await handle({ op: 'query', q: msg.q, args: msg.args });
        write(data);
      }
    } catch (e) {
      process.stderr.write(`failed: ${String(e)}\n`);
      process.exit(1);
    }
    await idx.close();
    return;
  }

  // ---- 守护模式：stdio JSON 行协议 ----
  write({ ev: 'hello', proto: 1, pid: process.pid });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number };
      try {
        msg = JSON.parse(line) as { id?: number };
      } catch {
        write({ id: null, ok: false, data: 'bad json' });
        continue;
      }
      void handle(msg as Parameters<typeof handle>[0])
        .then((data) => write({ id: msg.id, ok: true, data }))
        .catch((e) => write({ id: msg.id, ok: false, data: String(e) }))
        .then(() => {
          const op = (msg as { op?: string }).op;
          if (op === 'close') {
            setTimeout(() => process.exit(0), 50);
          }
        });
    }
  });
  process.stdin.on('close', () => {
    void idx.close().finally(() => process.exit(0));
  });
}

void main().catch((e) => {
  process.stderr.write(`daemon fatal: ${String(e)}\n`);
  process.exit(1);
});
