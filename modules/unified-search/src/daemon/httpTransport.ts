/**
 * HTTP/SSE 客户端传输（R1b，docs/kernel-separation-design.md §5/§6.1）。
 *
 * 与 daemonMain --http 模式（proto 2）配对。启动序（§6.1）：
 *   读 discovery → /ping 探活 → 活：复用（跳过 spawn）→ 开 SSE
 *                              → 死：spawn --http → 轮询至活 → 开 SSE
 * 缓存/version/重启退避不属于本层——那是 BlockIndexDaemonClient 的职责；
 * 本层只做：连接建立、RPC（op-aware 超时）、事件流、停机。
 *
 * 平台纪律：顶层不得 import node builtin（主 bundle browser platform）——
 * fs/child_process 经 eval('require') 惰性获取（daemonClient 同款先例）。
 * 本文件被主 bundle 打包，被 vitest（node）与 client 冒烟直接运行。
 */

import { createDiscoveryIO, discoveryPath, OP_TIMEOUT_MS, type DiscoveryIO, type KernelEvent } from './kernelApi';

/** spawn 产物最小面（http 模式不需要 stdout 流）。 */
export interface HttpChild {
  pid: number | undefined;
  kill(): void;
  on(ev: 'exit', cb: (code: number | null) => void): unknown;
  unref?(): void;
}

export type HttpSpawnFn = (cmd: string, args: string[]) => HttpChild;

export interface HttpTransportOptions {
  /** discovery 锚点 = dbPath（§3）。 */
  dbPath: string;
  /** MyKernel.cjs 绝对路径（spawn 用；必须绝对——2026-10-25 教训）。 */
  scriptPath: string;
  /** vault 根绝对路径（探活匹配 + --vault）。 */
  vault: string;
  /** 附加 daemon 参数（--exclude a,b 等；--http 由本层自动追加）。 */
  extraArgs?: string[];
  /** Obsidian.exe 绝对路径（托盘「打开」动作直派协议 URL 用，R2c）。 */
  obsidianExe?: string;
  findNode: () => Promise<string | null>;
  onEvent: (ev: KernelEvent) => void;
  /** SSE 流断开（= 内核退出/失联）；重启退避由上层管。 */
  onExit: () => void;
  spawnImpl?: HttpSpawnFn;
  fetchImpl?: typeof fetch;
  /** discovery IO 注入（测试用；生产 eval-require fs）。 */
  io?: DiscoveryIO;
  /** spawn 后等内核就绪的上限（测试注入短值）。 */
  probeTimeoutMs?: number;
  /**
   * R2a 常驻：detached + unref + stderr 重定向 <dbDir>/kernel-<slug>.log——
   * 内核脱离 Obsidian 生命周期，孤儿由空闲自退（--idle-exit-ms）兜底。
   */
  resident?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpTransport {
  private port = 0;
  private token = '';
  private child: HttpChild | null = null;
  private eventCtl: AbortController | null = null;
  private stopped = false;
  private readonly f: typeof fetch;
  private readonly io: DiscoveryIO;
  private readonly spawnImpl: HttpSpawnFn;
  /** probeOnce 失败原因诊断计数（≤3 条留痕,2026-11-06） */
  private probeLogs = 0;

  constructor(private readonly opts: HttpTransportOptions) {
    // fetch 必须 bind——存字段后 this.f(...) 的 this 是 transport 实例,
    // 原生 fetch 直接 Illegal invocation（2026-11-06 实锤:渲染进程每次加载
    // spawn http 内核→探活全挂→回落 stdio,孤儿内核即此根源;node 侧 fetch
    // 不挑 this 所以冒烟/vitest 从未暴露）。1.15 起是原生 fetch 必炸。
    this.f = opts.fetchImpl ?? fetch.bind(globalThis);
    this.io =
      opts.io ??
      createDiscoveryIO(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        eval('require')('fs') as Parameters<typeof createDiscoveryIO>[0],
      );
    this.spawnImpl =
      opts.spawnImpl ??
      ((): HttpSpawnFn => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cp = eval('require')('child_process') as {
          spawn: (c: string, a: string[], o?: object) => HttpChild;
        };
        if (!opts.resident) {
          return (cmd: string, args: string[]) =>
            cp.spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
        }
        // 常驻（R2a）：detached 脱离父进程组 + unref 不挡父进程退出；
        // stderr 落 <dbDir>/kernel-<slug>.log（父进程死后诊断仍在）。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fsMod = eval('require')('fs') as {
          openSync(p: string, f: string): number;
          closeSync(fd: number): void;
        };
        const logPath = discoveryPath(opts.dbPath).replace(/\.json$/, '.log');
        return (cmd: string, args: string[]) => {
          let fd: number | null = null;
          try {
            fd = fsMod.openSync(logPath, 'a');
          } catch {
            fd = null;
          }
          const stdio: ('ignore' | number)[] = ['ignore', 'ignore', fd ?? 'ignore'];
          const child = cp.spawn(cmd, args, { detached: true, stdio, windowsHide: true });
          child.unref?.();
          if (fd !== null) {
            try {
              fsMod.closeSync(fd); // spawn 已复制 fd 给子进程,父侧副本关闭
            } catch {
              /* 已关 */
            }
          }
          return child;
        };
      })();
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  async start(): Promise<void> {
    if (await this.probeOnce()) {
      this.openEvents();
      return;
    }
    const node = await this.opts.findNode();
    if (!node) throw new Error('system node not found for MyKernel');
    const args = [
      this.opts.scriptPath,
      '--db',
      this.opts.dbPath,
      '--vault',
      this.opts.vault,
      ...(this.opts.extraArgs ?? []),
      '--http',
      ...(this.opts.obsidianExe ? ['--obsidian-exe', this.opts.obsidianExe] : []),
    ];
    const child = this.spawnImpl(node, args);
    this.child = child;
    child.on('exit', () => {
      if (!this.stopped) this.opts.onExit();
    });
    // 轮询 discovery+ping：新内核要覆盖写 discovery 才可发现（旧文件陈旧也算未就绪）
    // 30s（2026-11-06）：大索引库（主库 1.56GB）冷开 node 起进程+开库 >10s,
// 10s 探活必超时 → 客户端整个 start 失败。UI 已不阻塞(defer),这里等就等。
    const deadline = Date.now() + (this.opts.probeTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('kernel transport disposed during start');
      if (await this.probeOnce()) {
        this.openEvents();
        return;
      }
      await sleep(150);
    }
    throw new Error('kernel did not come up (discovery/ping timeout)');
  }

  /** 停机：断 SSE + 优雅 /shutdown + kill 兜底（R1b 保留 kill 语义）。 */
  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.eventCtl?.abort();
    } catch {
      /* 已断 */
    }
    if (this.token) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 3_000);
        await this.f(`http://127.0.0.1:${this.port}/shutdown`, {
          method: 'POST',
          headers: { 'x-kernel-token': this.token },
          signal: ctl.signal,
        });
        clearTimeout(t);
      } catch {
        /* best effort */
      }
    }
    try {
      this.child?.kill();
    } catch {
      /* 已死 */
    }
    this.child = null;
  }

  /** 常驻模式断连（R2a）：只断 SSE，不杀进程不 shutdown——孤儿由空闲自退兜底。 */
  disconnect(): void {
    this.stopped = true;
    try {
      this.eventCtl?.abort();
    } catch {
      /* 已断 */
    }
    this.child = null;
  }

  // ------------------------------------------------------------------
  // RPC
  // ------------------------------------------------------------------

  async call<T = unknown>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    if (!this.token) throw new Error('kernel transport not started');
    const timeout = OP_TIMEOUT_MS[op] ?? 60_000;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await this.f(`http://127.0.0.1:${this.port}/api/${encodeURIComponent(op)}`, {
        method: 'POST',
        headers: { 'x-kernel-token': this.token, 'content-type': 'application/json' },
        body: JSON.stringify(extra),
        signal: ctl.signal,
      });
      const body = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
      if (!body.ok) throw new Error(String(body.error ?? `kernel ${op} failed`));
      return body.data as T;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw new Error(`kernel call timeout: ${op}`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // ------------------------------------------------------------------
  // 内部：探活 / 事件流
  // ------------------------------------------------------------------

  private normVault(p: string): string {
    return p.replace(/[\\/]+$/, '').toLowerCase();
  }

  /** 读 discovery → /ping（1.5s 超时）；成功则记住 port/token。 */
  private async probeOnce(): Promise<boolean> {
    const d = this.io.read(this.opts.dbPath);
    if (!d || d.proto !== 2 || !d.port || !d.token) {
      // 诊断留痕（2026-11-06 stdio 困局）：discovery 缺失/坏值
      if ((this.probeLogs = (this.probeLogs ?? 0) + 1) <= 3) {
        console.warn(`[http-transport] probe: discovery missing/bad (attempt ${this.probeLogs})`);
      }
      return false;
    }
    if (d.vault && this.opts.vault && this.normVault(d.vault) !== this.normVault(this.opts.vault)) {
      if ((this.probeLogs = (this.probeLogs ?? 0) + 1) <= 3) {
        console.warn(`[http-transport] probe: vault mismatch disc=${d.vault} opts=${this.opts.vault}`);
      }
      return false;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1_500);
    try {
      const res = await this.f(`http://127.0.0.1:${d.port}/ping`, {
        headers: { 'x-kernel-token': d.token },
        signal: ctl.signal,
      });
      if (!res.ok) {
        if ((this.probeLogs = (this.probeLogs ?? 0) + 1) <= 3) {
          console.warn(`[http-transport] probe: ping ${res.status} (port ${d.port})`);
        }
        return false;
      }
      const info = (await res.json()) as { proto?: number };
      if (info.proto !== 2) {
        if ((this.probeLogs = (this.probeLogs ?? 0) + 1) <= 3) {
          console.warn(`[http-transport] probe: proto mismatch ${info.proto}`);
        }
        return false;
      }
      this.probeLogs = 0;
      this.port = d.port;
      this.token = d.token;
      return true;
    } catch (e) {
      if ((this.probeLogs = (this.probeLogs ?? 0) + 1) <= 3) {
        console.warn(`[http-transport] probe: ping throw (port ${d.port}):`, String(e).slice(0, 120));
      }
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /** 开 SSE 事件流（单流；断开 → onExit 一次，重启退避在上层）。 */
  private openEvents(): void {
    void this.eventLoop();
  }

  private async eventLoop(): Promise<void> {
    const ctl = new AbortController();
    this.eventCtl = ctl;
    try {
      const res = await this.f(`http://127.0.0.1:${this.port}/events`, {
        headers: { 'x-kernel-token': this.token },
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              this.opts.onEvent(JSON.parse(payload) as KernelEvent);
            } catch {
              /* 坏帧跳过 */
            }
          }
        }
      }
    } catch {
      /* 流断（含 abort） */
    }
    if (!this.stopped) this.opts.onExit();
  }
}
