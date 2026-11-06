/**
 * 渲染进程侧的守护进程客户端（档位 2 的另一半）。
 *
 * 职责：
 *  - 生命周期：spawn 系统 node 跑 MyKernel.cjs（崩溃退避重启），unload 收尾
 *  - 协议：stdio JSON 行的请求/应答/事件（与 daemonMain 的协议一一对应）
 *  - BlockIndex 兼容 API：小常驻缓存保住**同步**方法（byId 池 / 标签 / 卡片 /
 *    超标签 / 当前文件的块），重查询（backlinksTo / refsToBlock / scan / blocksByPath）
 *    走异步——消费方只需把这几个调用点改成 await（清单见 WIP 文档第三节）。
 *
 * 缓存失效：daemon 每次变更广播 {ev:'changed', version} → 全部缓存作废重拉
 * （量都很小：byId 池 ~90 块、标签几 K 字符串、卡片同理；194ms 的 withIds
 * 池加载只在变更后发生，且是后台异步，不卡 UI）。
 */

import { App, TAbstractFile, TFile, EventRef, Platform } from 'obsidian';
import type { BacklinkEntry } from '../../../logseq/src/index/blockIndex';

// 复用 BlockIndex 的公开类型，消费方零改动。
export type { IndexedBlock, BacklinkEntry, CardEntry } from '../../../logseq/src/index/blockIndex';
import type { CardEntry, IndexedBlock } from '../../../logseq/src/index/blockIndex';
import type { SupertagDef } from '../../../logseq/src/features/supertags';
import type { KernelEvent } from './kernelApi';
import { HttpTransport } from './httpTransport';

interface DaemonChild {
  pid: number | undefined;
  kill(): void;
  stdout: NodeJS.ReadableStream & { setEncoding(e: string): unknown };
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream & { write(s: string): boolean };
  on(ev: 'exit', cb: (code: number | null) => void): unknown;
  once(ev: string, cb: (...a: unknown[]) => void): unknown;
  removeAllListeners(ev: string): unknown;
}

type SpawnFn = (cmd: string, args: string[]) => DaemonChild;

export interface DaemonClientOptions {
  app: App;
  /** 插件数据目录（index-daemon.cjs 与 node_modules 边车所在）。 */
  pluginDir: string;
  /** SQLite 库文件绝对路径。 */
  dbPath: string;
  /** 找系统 node.exe（terminal/ptyClient 的 findNodeExe 同源问题）。 */
  findNode: () => Promise<string | null>;
  /** 索引排除目录（indexExcludedFolders 解析结果；热改后调 setExcludes）。 */
  excludes?: () => string[];
  /** spawn 注入点（测试用）；生产用 require('child_process').spawn。 */
  spawnImpl?: SpawnFn;
  /** 传输选择（R1b 默认 http：discovery 复用 + spawn --http；失败回落 stdio）。 */
  transport?: 'http' | 'stdio';
  /** R2a 常驻内核：dispose 只断连不杀（默认开；空闲自退兜底孤儿）。 */
  kernelResident?: boolean;
  /** R2c 内核托盘：spawn 带 --tray 且关闭空闲自退（互斥）。默认关。 */
  kernelTray?: boolean;
  /** R2c 托盘「打开 Obsidian」用的 exe（渲染进程 process.execPath=Obsidian.exe）。 */
  obsidianExe?: string;
  /** 触发 BlockIndex 消费方刷新（onRebuild 监听器的同一条线）。 */
  onChange: () => void;
}

const RESTART_BACKOFF_MS = [500, 2000, 10000];

export class BlockIndexDaemonClient {
  version = 0;
  private child: DaemonChild | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = '';
  private restarts = 0;
  private restarting = false;
  private readonly spawnImpl: SpawnFn;
  private readonly opts: DaemonClientOptions;
  /** 狂暴模式进度回调(turbo 重建/增量期间的 progress 事件)。 */
  onTurboProgress: ((done: number, total: number) => void) | null = null;
  private disposed = false;
  /** HTTP 传输（R1b）；null = 当前走 stdio。 */
  private http: HttpTransport | null = null;

  // ---- 小常驻缓存（changed 时作废，懒加载） ----
  private cacheById: Map<string, IndexedBlock> | null = null;
  private cacheAllTags: string[] | null = null;
  private cacheCards: CardEntry[] | null = null;
  private cacheSupertags: Map<string, SupertagDef> | null = null;
  private cacheFileBlocks = new Map<string, IndexedBlock[]>();

  constructor(opts: DaemonClientOptions) {
    this.opts = opts;
    // spawn 惰性 require（移动端无 child_process，类根本不会被实例化——
    // 调用方保证桌面端才走这里，但仍保持防御）。
    this.spawnImpl =
      opts.spawnImpl ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cp = eval('require')('child_process') as { spawn: SpawnFn };
        return cp.spawn;
      })();
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  async start(): Promise<void> {
    if (!Platform.isDesktopApp) throw new Error('daemon client is desktop-only');
    const node = await this.opts.findNode();
    if (!node) throw new Error('system node not found for MyKernel');
    // spawn 的 cwd 是插件目录——manifest.dir 是 vault 相对路径,必须拼绝对路径
    // (实测:相对路径在异 cwd 下解析到不存在的位置,node 报 Cannot find module,
    // 客户端静默回落内存索引,2026-10-25)。
    const base = vaultBase(this.opts.app).replace(/[\\/]+$/, '');
    const rel = this.opts.pluginDir.replace(/^\/+|\/+$/g, '');
    const script = `${base}/${rel}/MyKernel.cjs`;
    const vault = vaultBase(this.opts.app);
    const ex = this.opts.excludes?.() ?? [];
    const extra: string[] = [];
    if (ex.length) extra.push('--exclude', ex.join(','));
    if (this.opts.kernelTray === true) extra.push('--tray', '--idle-exit-ms', '0');
    // --obsidian-exe 不在这里推：httpTransport 自带同款追加（opts.obsidianExe
    // 单独传了），两边都推会出现重复 flag（2026-11-06 实测,无害但脏）。

    // R1b：HTTP 传输优先（discovery 探活复用 + spawn --http）。失败回落 stdio——
    // 部署偏斜场景（盘上还是旧 daemon.cjs：parseArgs 忽略未知 flag 走 stdio
    // 模式）HTTP 等不到内核就绪超时，这里兜住（§10 R1b）。
    if (this.opts.transport !== 'stdio') {
      try {
        const http = new HttpTransport({
          dbPath: this.opts.dbPath,
          scriptPath: script,
          vault,
          extraArgs: extra,
          obsidianExe: this.opts.obsidianExe,
          findNode: this.opts.findNode,
          onEvent: (ev) => this.handleEvent(ev),
          onExit: () => void this.onDaemonExit(),
          resident: this.opts.kernelResident !== false,
        });
        await http.start();
        this.http = http;
        await this.call('ping');
        // R2d 运行时配置推送：HTTP 内核可被探活复用，也可能由旧构建/外部脚本
        // 拉起——argv 里的 --obsidian-exe 不保证在（2026-11-05 实测：旧内核缺
        // 该 flag，托盘「打开 Obsidian」回落 explorer 打开了资源管理器）。连上
        // 就补送，派发不依赖内核的出生参数。fire-and-forget：失败不碰索引主链路。
        void this.call('setConfig', { obsidianExe: this.opts.obsidianExe ?? '' }).catch(() => {});
        void this.turboSync().catch(() => {});
        return;
      } catch (e) {
        // 回落 stdio——失败原因必须留痕（2026-11-06：静默吞掉导致 stdio 困局无法诊断）
        console.warn('[daemon-client] http transport start failed, fallback to stdio:', e);
        this.http = null;
      }
    }

    this.spawnDaemon(node, [
      script,
      '--db',
      this.opts.dbPath,
      '--vault',
      vault,
      ...(ex.length ? ['--exclude', ex.join(',')] : []),
    ]);
    await this.call('ping');
    // 启动同步放后台：等它必撞 60s 超时 → daemon 明明活着却被误回落
    // 内存索引。走 turboSync（并发读池 + 流式写批,2026-11-04）：旧串行
    // idx.sync() 逐文件读+解析,单核满转可达小时级,且把事件循环按住——
    // 统一索引模式下 omnisearch 的搜索也过这条 stdio,ping 都能延迟秒级。
    // turbo 的异步读 + 每文件小批写让查询能穿插;完成后广播 changed,缓存自预热。
    void this.turboSync().catch(() => {});
  }

  private spawnDaemon(node: string, args: string[]): void {
    if (this.disposed) return;
    const child = this.spawnImpl(node, args);
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', () => {
      /* daemon 的 stderr 是诊断信息,不进 UI */
    });
    child.on('exit', () => void this.onDaemonExit());
  }

  private async onDaemonExit(): Promise<void> {
    if (this.disposed || this.restarting) return;
    this.restarting = true;
    this.rejectAllPending(new Error('MyKernel exited'));
    const wait = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)];
    this.restarts++;
    await new Promise((r) => setTimeout(r, wait));
    this.restarting = false;
    if (this.disposed) return;
    try {
      await this.start();
      this.restarts = 0;
    } catch {
      // start 失败会再触发 exit/或这里吞掉——退出事件才是重启驱动。
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAllPending(new Error('daemon client disposed'));
    if (this.http) {
      if (this.opts.kernelResident !== false) {
        // R2a 常驻：只断连不杀——内核存活等下次复用，孤儿由空闲自退兜底。
        this.http.disconnect();
      } else {
        void this.http.stop().catch(() => {});
      }
      this.http = null;
      return;
    }
    try {
      this.child?.kill();
    } catch {
      /* 已死 */
    }
    this.child = null;
  }

  /** 显式停内核（设置页「停用内核」）：无论 resident 与否都优雅停机。 */
  async stopKernel(): Promise<void> {
    this.disposed = true;
    this.rejectAllPending(new Error('kernel stopped'));
    const http = this.http;
    this.http = null;
    if (http) {
      await http.stop().catch(() => {});
      return;
    }
    try {
      this.child?.kill();
    } catch {
      /* 已死 */
    }
    this.child = null;
  }

  // ------------------------------------------------------------------
  // 协议
  // ------------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; ok?: boolean; data?: unknown; ev?: string; version?: number; done?: number; total?: number };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (msg.ev) {
        this.handleEvent(msg as unknown as KernelEvent);
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(String(msg.data ?? 'daemon error')));
      }
    }
  }

  private rejectAllPending(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  /** 事件路由（stdio JSON 行与 HTTP SSE 共用同一语义,§4 KernelEvent）。 */
  private handleEvent(ev: KernelEvent): void {
    if (ev.ev === 'changed') {
      this.version = ev.version;
      this.invalidateCaches();
      this.opts.onChange();
      return;
    }
    if (ev.ev === 'progress') {
      this.onTurboProgress?.(ev.done, ev.total);
      return;
    }
    // hello/fts 暂不消费（与旧行为一致）
  }

  private call<T = unknown>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    if (this.http) return this.http.call<T>(op, extra);
    return new Promise<T>((resolve, reject) => {
      const child = this.child;
      if (!child || this.disposed) {
        reject(new Error('daemon not running'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`daemon call timeout: ${op}`));
        }
      }, 60000);
    });
  }

  private query<T = unknown>(q: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>('query', { q, args });
  }

  private invalidateCaches(): void {
    this.cacheById = null;
    this.cacheAllTags = null;
    this.cacheCards = null;
    this.cacheSupertags = null;
    this.cacheFileBlocks.clear();
  }

  // ------------------------------------------------------------------
  // BlockIndex 兼容 API —— 同步（小缓存）
  // ------------------------------------------------------------------

  /** 有 id:: 的块（((引用)) 补全池）。同步读缓存；冷启动第一次返回空池并后台拉。 */
  withIds(): IndexedBlock[] {
    if (!this.cacheById) void this.prewarmById();
    return this.cacheById ? [...this.cacheById.values()] : [];
  }

  get(id: string): IndexedBlock | null {
    return this.cacheById?.get(id) ?? null;
  }

  allTags(): string[] {
    if (!this.cacheAllTags) void this.prewarmTags();
    return this.cacheAllTags ?? [];
  }

  allCards(): CardEntry[] {
    if (!this.cacheCards) void this.prewarmCards();
    return this.cacheCards ?? [];
  }

  supertagRegistry(): Map<string, SupertagDef> {
    if (!this.cacheSupertags) void this.prewarmSupertags();
    return this.cacheSupertags ?? new Map();
  }

  supertagDef(name: string): SupertagDef | null {
    return this.supertagRegistry().get(name.toLowerCase()) ?? null;
  }

  /** 单文件全部块（编辑器视图用）——缓存 + 异步补。 */
  blocksByPathSync(path: string): IndexedBlock[] {
    const hit = this.cacheFileBlocks.get(path);
    if (!hit) void this.fillFileBlocks(path);
    return hit ?? [];
  }

  private async fillFileBlocks(path: string): Promise<void> {
    const v0 = this.version;
    try {
      const bs = await this.query<IndexedBlock[]>('blocksByPath', { path });
      // 期间 daemon 又广播过 changed → 拿到的已过期：不写缓存、不再触发
      // onChange（否则 消费方→查询→onChange→消费方 成反馈环，daemon 频繁
      // 变更时滚雪球吃内存，2026-10-25）。
      if (this.version === v0 && bs && bs.length) {
        this.cacheFileBlocks.set(path, bs);
        this.opts.onChange();
      }
    } catch {
      /* daemon 忙/挂，下次访问再试 */
    }
  }

  // ------------------------------------------------------------------
  // 异步查询（消费方 await）
  // ------------------------------------------------------------------

  async backlinksTo(path: string): Promise<BacklinkEntry[]> {
    const page = pageNameOf(path);
    return this.query<BacklinkEntry[]>('backlinksTo', { page, selfPath: path });
  }

  async refsToBlock(id: string): Promise<BacklinkEntry[]> {
    return this.query<BacklinkEntry[]>('refsToBlock', { id });
  }

  async blocksByPath(path: string): Promise<IndexedBlock[]> {
    return this.query<IndexedBlock[]>('blocksByPath', { path });
  }

  async tagsByPath(path: string): Promise<string[]> {
    return this.query<string[]>('tagsByPath', { path });
  }

  async supertagInstances(tag: string): Promise<IndexedBlock[]> {
    return this.query<IndexedBlock[]>('supertagInstances', { tag });
  }

  /** 未连提及/块搜索的文本扫描（FTS5 trigram,中文子串毫秒级）。 */
  async scan(pattern: string, excludePath: string, limit = 200, onlyPath = ''): Promise<{ bkey: string; path: string; text: string }[]> {
    return this.query<{ bkey: string; path: string; text: string }[]>('scan', { pattern, excludePath, limit, onlyPath });
  }

  /**
   * 统一搜索查询面:调用方编译好的 FTS5 MATCH 表达式(token 已安全引用,
   * 见 unified-search/src/matchBuilder),返回带 block_id 的块命中(供 #^锚点)。
   */
  async ftsSearch(match: string, excludePath = '', limit = 50, onlyPath = ''): Promise<{ bkey: string; path: string; blockId: string; text: string }[]> {
    return this.query<{ bkey: string; path: string; blockId: string; text: string }[]>('fts', { match, excludePath, limit, onlyPath });
  }

  /**
   * 文件名/标签域搜索（omnisearch 统一索引模式,2026-11-04）:
   * tokens = 路径子串(全命中),tags = '#tag' 去前缀,返回文件路径 + 首块摘要。
   */
  async nameSearch(tokens: string[], tags: string[] = [], limit = 30): Promise<{ path: string; text: string }[]> {
    return this.query<{ path: string; text: string }[]>('nameSearch', { tokens, tags, limit });
  }

  // ------------------------------------------------------------------
  // 变更通道（main.ts 的 vault 事件转发进来）
  // ------------------------------------------------------------------

  /** 文件修改/新建（防抖由调用方做,与旧 sqlitePending 同语义）。 */
  async upsertFiles(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.call('upsert', { paths });
  }

  async deleteFiles(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.call('delete', { paths });
  }

  async rebuild(): Promise<void> {
    await this.call('rebuild');
  }

  /** 增量同步（daemon 侧只处理变更文件,已同步则秒回）。 */
  async sync(): Promise<void> {
    await this.call('sync');
  }

  /** 挂载库外文件候选清单(ext 域):daemon 落 meta 后自行 stat 门控增量索引。 */
  async setExtFiles(files: { path: string; mtime: number }[]): Promise<{ files: number; updated: number; removed: number }> {
    return this.call('setExt', { files });
  }

  /** ext 域查询:token 逐个 MATCH/LIKE 后按 bkey 交集,排除项服务端过滤。 */
  async extSearch(tokens: string[], not: string[] = [], limit = 30): Promise<{ path: string; text: string }[]> {
    return this.call<{ path: string; text: string }[]>('extSearch', { tokens, not, limit });
  }

  /** 狂暴全量重建:并发池=os.cpus()*2,PRAGMA synchronous=OFF。 */
  async turboRebuild(onProgress?: (done: number, total: number) => void): Promise<{ files: number; blocks: number; ms: number }> {
    this.onTurboProgress = onProgress ?? null;
    try {
      return await this.call<{ files: number; blocks: number; ms: number }>('turbo', { mode: 'rebuild' });
    } finally {
      this.onTurboProgress = null;
    }
  }

  /** 狂暴增量:只补变更文件,同一并发池(日常编辑后的补索引)。 */
  async turboSync(onProgress?: (done: number, total: number) => void): Promise<{ files: number; blocks: number; ms: number }> {
    this.onTurboProgress = onProgress ?? null;
    try {
      return await this.call<{ files: number; blocks: number; ms: number }>('turbo', { mode: 'sync' });
    } finally {
      this.onTurboProgress = null;
    }
  }

  /** 设置热改排除目录后调用。 */
  async setExcludes(folders: string[]): Promise<void> {
    await this.call('setExclude', { folders });
    await this.call('sync');
  }

  // ------------------------------------------------------------------
  // 预热（后台,失败静默——缓存保持 null,下次访问再试）
  // ------------------------------------------------------------------

  private async prewarmById(): Promise<void> {
    try {
      const blocks = await this.query<IndexedBlock[]>('withIds');
      const m = new Map<string, IndexedBlock>();
      for (const b of blocks ?? []) if (b.blockId) m.set(b.blockId, b);
      this.cacheById = m;
    } catch {
      /* daemon 忙/挂,下次访问重试 */
    }
  }

  private async prewarmTags(): Promise<void> {
    try {
      this.cacheAllTags = (await this.query<string[]>('allTags')) ?? [];
    } catch {
      /* 同上 */
    }
  }

  private async prewarmCards(): Promise<void> {
    try {
      this.cacheCards = (await this.query<CardEntry[]>('allCards')) ?? [];
    } catch {
      /* 同上 */
    }
  }

  private async prewarmSupertags(): Promise<void> {
    try {
      const rows = (await this.query<{ name: string; path: string; fields: SupertagDef['fields']; parents: string[] }[]>('supertags')) ?? [];
      const m = new Map<string, SupertagDef>();
      for (const r of rows) m.set(r.name, { name: r.name, fields: r.fields, parents: r.parents });
      this.cacheSupertags = m;
    } catch {
      /* 同上 */
    }
  }
}

// ----------------------------------------------------------------------
// 纯工具
// ----------------------------------------------------------------------

/** 库根绝对路径（vaultBase）。 */
function vaultBase(app: App): string {
  const adapter = app.vault.adapter as unknown as { basePath?: string; getBasePath?: () => string };
  return (typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : adapter.basePath) ?? '';
}

/** vault 路径 → 规范页名（basename 小写,去 .md）——与 fileFacts 的 page 同式。 */
function pageNameOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.md$/i, '').toLowerCase();
}

/**
 * 兼容层：daemon 模式下把 vault 事件翻译成 daemon 调用。
 * 返回 unregister（main.ts registerEvent 语义）。
 */
export function forwardVaultEvents(
  plugin: { app: App; registerEvent(ref: EventRef): void },
  client: BlockIndexDaemonClient,
): void {
  const pending = new Set<string>();
  let timer = 0;
  const flush = (): void => {
    window.clearTimeout(timer);
    timer = 0;
    const paths = [...pending];
    pending.clear();
    void client.upsertFiles(paths).catch(() => {});
  };
  const watch = (file: TAbstractFile): void => {
    if (!(file instanceof TFile)) return;
    if (!file.path.toLowerCase().endsWith('.md')) return;
    pending.add(file.path);
    if (!timer) timer = window.setTimeout(flush, 2000);
  };
  plugin.registerEvent(plugin.app.vault.on('modify', watch));
  plugin.registerEvent(plugin.app.vault.on('create', watch));
  plugin.registerEvent(
    plugin.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      void client.deleteFiles([oldPath]).catch(() => {});
      watch(file);
    }),
  );
  plugin.registerEvent(
    plugin.app.vault.on('delete', (file) => {
      if (!(file instanceof TFile)) return;
      void client.deleteFiles([file.path]).catch(() => {});
    }),
  );
}
