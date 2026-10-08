/**
 * 持久 Python 内核的宿主端 — **Legacy 后端**(syfe-kernel.py 那条自用协议)。
 * 移植自 siyuan-editor `src/utils/kernel/legacy-python.ts`,行为逐行对应,
 * 仅环境适配:
 *
 * - 插件目录:思源侧读 `window.__SIYUAN_FILE_EDITOR_DIR__`;这里从
 *   `app.vault.adapter.basePath + /.obsidian/plugins/obsidian-logseq` 推导。
 * - require:同插件其余处,懒加载(eval 兜底)。
 * - 解释器探测:复用 `../pythonInterpreter`(与代码块运行共用一份候选逻辑)。
 *
 * 原样保留的设计决定(思源侧注释的结论):
 *
 * - 为什么直接 child_process.spawn 而不绕 pty:内核只是普通管道子进程,
 *   不需要 PTY。Obsidian 渲染进程 spawn 已由 extFs/openWith/代码块运行验证。
 * - 进程模型:**持久**内核 —— 变量、import、函数定义跨次保留,与 Jupyter 一致。
 * - 中断(Windows 特有,别改):SIGINT 会直接杀 Python 主线程,没法在同进程
 *   另起线程打断 GIL 中的执行。**中断 = 杀进程 + 重建 + 重放历史代码**。
 *   历史按 execution_order 排序重放,代价是丢内存里的非代码副作用。
 */

import {
  type CompleteOutcome,
  type ExecuteOutcome,
  type HistoryEntry,
  type InspectOutcome,
  type KernelClient,
  type KernelEvent,
  type KernelInfo,
  type KernelListener,
  type KernelStatus,
  type StatusListener,
} from './types';
import { resolvePythonInterpreter } from '../pythonInterpreter';

/** 一次请求的聚合器:流式事件累积,遇终态 resolve。 */
interface Aggregate {
  acc: ExecuteOutcome;
  isTerminal: (ev: KernelEvent) => boolean;
  finish: (ev: KernelEvent, acc: ExecuteOutcome) => unknown;
}

/** 单次执行默认超时:5 分钟。跑训练/下载这类脚本合理,又不至于永远挂着。 */
const DEFAULT_EXECUTE_TIMEOUT = 300000;

type Requirer = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

export class LegacyPythonKernel implements KernelClient {
  readonly kind: 'syfe' = 'syfe';

  private proc: KernelProcess | null = null;
  private status: KernelStatus = 'stopped';
  private startPromise: Promise<boolean> | null = null;
  private seq = 0;
  /** 请求 id → 聚合器 */
  private pending = new Map<string, { agg: Aggregate; timer: number; resolve: (v: unknown) => void }>();
  private listeners = new Set<KernelListener>();
  private statusListeners = new Set<StatusListener>();
  private readyWaiters = new Set<(ok: boolean) => void>();
  /** 成功执行过的代码,中断重启后按序重放 */
  private history: HistoryEntry[] = [];
  private info: KernelInfo | null = null;
  private disposed = false;
  /** 重放历史期间:结果不该再进 history(否则会自我复制) */
  private replaying = false;
  /** 内核工作目录(缺省 = 库根) */
  workspaceCwd = '';

  // ===== 状态与监听 =====

  get currentStatus(): KernelStatus {
    return this.status;
  }

  get isReady(): boolean {
    return this.status === 'ready';
  }

  get kernelInfo(): KernelInfo | null {
    return this.info;
  }

  get executedHistory(): ReadonlyArray<HistoryEntry> {
    return this.history;
  }

  onEvent(cb: KernelListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private emit(ev: KernelEvent): void {
    this.listeners.forEach((cb) => {
      try {
        cb(ev);
      } catch (e) {
        console.warn('[obsidian-logseq] 内核事件回调失败:', e);
      }
    });
  }

  private setStatus(s: KernelStatus, detail?: string): void {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((cb) => {
      try {
        cb(s, detail);
      } catch {
        // ignore
      }
    });
  }

  // ===== 启动 =====

  async start(): Promise<boolean> {
    if (this.isReady) return true;
    if (this.disposed) return false;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<boolean> {
    const script = this.findKernelScript();
    if (!script) {
      this.setStatus('error', '找不到内核脚本 syfe-kernel.py(插件目录不完整?)');
      return false;
    }

    const python = resolvePythonInterpreter();
    if (!python) {
      // 这条错误要让用户看见 —— 静默失败会表现为「点了运行没反应」
      this.setStatus('error', '未找到 Python。请安装 Python 3 并确保 python 在 PATH 中');
      return false;
    }

    this.setStatus('starting');

    const cp = nodeRequire('child_process') as {
      spawn(cmd: string, args: string[], opts: unknown): KernelProcess;
    };
    const proc = nodeRequire('process') as { env?: Record<string, string | undefined>; platform?: string };

    let child: KernelProcess;
    try {
      child = cp.spawn(python.cmd, [...python.args, '-u', script], {
        cwd: this.workspaceCwd || undefined,
        env: {
          ...proc?.env,
          // 内核自己会把 stdout/stderr 改成 UTF-8,这里是双保险
          PYTHONIOENCODING: 'utf-8',
          // 去掉用户 site-packages 里的 .pth 影响,保证启动可预测
          PYTHONNOUSERSITE: '1',
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.setStatus('error', `启动失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }

    this.proc = child;
    // -u 已保证无缓冲;再把解码固定 UTF-8,否则 Windows 按 cp936 解码中文变乱码
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // 内核告警走 stderr,单独收集便于排查,但**不能混进 stdout** ——
    // 那会污染内核的 JSON 协议流
    let stderrTail = '';
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    let pendingLine = '';
    child.stdout.on('data', (chunk: string) => {
      pendingLine += chunk;
      let idx: number;
      while ((idx = pendingLine.indexOf('\n')) >= 0) {
        const line = pendingLine.slice(0, idx).trim();
        pendingLine = pendingLine.slice(idx + 1);
        if (!line) continue;
        try {
          this.handleEvent(JSON.parse(line) as KernelEvent);
        } catch (e) {
          console.warn('[obsidian-logseq] 内核消息解析失败:', line.slice(0, 200), e);
        }
      }
    });

    child.on('error', (e: Error) => {
      this.setStatus('error', `进程错误: ${e?.message || e}`);
    });
    child.on('exit', (code: number) => {
      this.proc = null;
      this.failAllPending('内核进程已退出');
      this.readyWaiters.forEach((fn) => fn(false));
      this.readyWaiters.clear();
      if (!this.disposed) {
        const hint = stderrTail.trim() ? `\n${stderrTail.trim().slice(-300)}` : '';
        this.setStatus('error', `内核退出(code=${code})${hint}`);
      }
    });

    const ready = await this.waitForReady(15000);
    if (!ready) {
      this.setStatus('error', '内核启动超时(15s)');
      this.killProcess();
      return false;
    }
    this.setStatus('ready');
    return true;
  }

  /** 内核脚本位置:<插件目录>/syfe-kernel.py(esbuild 打包时复制进去)。 */
  private findKernelScript(): string | null {
    const fs = nodeRequire('fs') as { existsSync(p: string): boolean };
    const path = nodeRequire('path') as { join(...p: string[]): string };
    // Obsidian 桌面端:adapter.basePath = 库根;插件在 .obsidian/plugins/<id>/。
    const adapter = (
      globalThis as { app?: { vault?: { adapter?: { basePath?: string; getBasePath?: () => string } } } }
    ).app?.vault?.adapter;
    const base = adapter?.basePath ?? adapter?.getBasePath?.() ?? '';
    if (!base) return null;
    const p = path.join(base, '.obsidian', 'plugins', 'obsidian-logseq', 'syfe-kernel.py');
    try {
      return fs.existsSync(p) ? p : null;
    } catch {
      return null;
    }
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        this.readyWaiters.delete(fn);
        resolve(false);
      }, timeoutMs);
      const fn = (ok: boolean) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        this.readyWaiters.delete(fn);
        resolve(ok);
      };
      this.readyWaiters.add(fn);
    });
  }

  // ===== 事件分发 =====

  private handleEvent(ev: KernelEvent): void {
    // 先记下 id —— switch 之后 TS 会把 ev 收窄到残余分支,直接用 ev.id 会报不存在
    const evId = (ev as { id?: string }).id;

    switch (ev.type) {
      case 'kernel_ready':
        this.info = { version: ev.version, executable: ev.executable };
        this.readyWaiters.forEach((fn) => fn(true));
        this.readyWaiters.clear();
        break;
      case 'info_result':
        this.info = { version: ev.version, executable: ev.executable };
        break;
      default:
        break;
    }

    // 把事件推给该 id 的请求(如果有)
    if (typeof evId === 'string') {
      const entry = this.pending.get(evId);
      if (entry) {
        // 流式事件先累积(终态判定交给 isTerminal)。
        // **stream 的累加只能在这里做**:它是宿主端唯一收到 stream 的地方 ——
        // stream 不是终态事件,不会进 finish()。漏了这个分支的表现是
        // 「执行成功、序号也涨了,但 print 的内容一行都不显示」。
        if (ev.type === 'stream') {
          if (ev.name === 'stdout') entry.agg.acc.stdout += ev.text || '';
          else entry.agg.acc.stderr += ev.text || '';
        } else if (ev.type === 'status' && ev.state === 'idle') {
          if (typeof ev.execution_count === 'number') {
            entry.agg.acc.executionCount = ev.execution_count;
          }
        }
        if (entry.agg.isTerminal(ev)) {
          this.pending.delete(evId);
          window.clearTimeout(entry.timer);
          let out: unknown;
          try {
            out = entry.agg.finish(ev, entry.agg.acc);
          } catch {
            out = null;
          }
          entry.resolve(out);
        }
      }
    }

    this.emit(ev);
  }

  private failAllPending(reason: string): void {
    this.pending.forEach((entry) => {
      window.clearTimeout(entry.timer);
      entry.resolve({ error: { ename: 'KernelError', evalue: reason, traceback: [] } });
    });
    this.pending.clear();
  }

  /**
   * 发一条请求,等它的终态事件。
   * 超时 resolve null(不 reject,免得调用方到处 try/catch)。
   */
  private send<T>(
    msg: Record<string, unknown>,
    isTerminal: (ev: KernelEvent) => boolean,
    finish: (ev: KernelEvent, acc: ExecuteOutcome) => T,
    timeoutMs: number,
    initial?: Partial<ExecuteOutcome>,
  ): Promise<T | null> {
    const id = `r${++this.seq}`;
    const payload = { ...msg, id };
    return new Promise<T | null>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: resolve as (v: unknown) => void,
        agg: {
          acc: { ok: false, executionCount: 0, stdout: '', stderr: '', ...(initial || {}) },
          isTerminal,
          finish,
        },
      });
      try {
        this.proc?.stdin.write(JSON.stringify(payload) + '\n');
      } catch {
        this.pending.delete(id);
        window.clearTimeout(timer);
        resolve(null);
      }
    });
  }

  // ===== 公开能力 =====

  /**
   * 执行一段代码。
   * 终态:execute_result(有返回值)/ error(抛异常)/ status-idle(什么都没有)。
   */
  async execute(
    code: string,
    opts?: { silent?: boolean; timeoutMs?: number },
  ): Promise<ExecuteOutcome | null> {
    if (!(await this.start())) return null;
    const timeout = opts?.timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT;

    const outcome = await this.send<ExecuteOutcome>(
      { type: 'execute', code, silent: !!opts?.silent },
      (ev) =>
        ev.type === 'execute_result' ||
        ev.type === 'error' ||
        (ev.type === 'status' && ev.state === 'idle'),
      (ev, acc) => {
        // 这里**只处理终态事件**;stream 的累加在 handleEvent() 里做。
        if (ev.type === 'execute_result') {
          acc.ok = true;
          acc.executionCount = ev.execution_count;
          acc.result = ev.data?.['text/plain'];
          acc.richData = ev.data;
        } else if (ev.type === 'error') {
          acc.ok = false;
          // 出错的执行同样占一个序号(Jupyter 行为:报错的格也显示 In[n])。
          // 不取的话序号会「卡住」,后面几格的 In[n] 与真实执行历史脱节。
          if (typeof ev.execution_count === 'number') {
            acc.executionCount = ev.execution_count;
          }
          acc.error = { ename: ev.ename, evalue: ev.evalue, traceback: ev.traceback || [] };
        } else if (ev.type === 'status') {
          // status 才是序号的权威来源:execute_result 只在有末表达式时才有,
          // 整格只有 print 时取不到号,会把 In[n] 写成 In[0]。
          if (typeof ev.execution_count === 'number') {
            acc.executionCount = ev.execution_count;
          }
          if (ev.state === 'idle') {
            // 本轮结束。没有 execute_result 说明没有末表达式,
            // 是正常路径,不是失败。
            acc.ok = acc.ok !== false;
          }
        }
        return acc;
      },
      timeout,
    );

    if (!outcome) {
      // 超时:返回已累积的部分输出(此刻拿不到 acc,给占位)。
      // 思源侧同款行为:用户至少能看到「超时」而不是无限等。
      return {
        ok: false,
        executionCount: 0,
        stdout: '',
        stderr: '',
        error: { ename: 'TimeoutError', evalue: `执行超过 ${timeout}ms 未完成`, traceback: [] },
      };
    }

    // 成功且有代码 → 记进历史,供中断后重放
    if (!this.replaying && outcome.ok && code.trim()) {
      this.history.push({ code, executionOrder: outcome.executionCount });
    }
    return outcome;
  }

  /** 补全。cursor 是模型内的字符偏移(不是行列)。 */
  async complete(code: string, cursor: number): Promise<CompleteOutcome | null> {
    if (!(await this.start())) return null;
    return this.send<CompleteOutcome>(
      { type: 'complete', code, cursor },
      (ev) => ev.type === 'complete_result',
      (ev) => {
        const r = ev as Extract<KernelEvent, { type: 'complete_result' }>;
        return {
          matches: r.matches || [],
          cursorStart: r.cursor_start,
          cursorEnd: r.cursor_end,
        };
      },
      2500,
    );
  }

  /** 内省(hover / signature / definition)。cursor 是字符偏移。 */
  async inspect(
    code: string,
    cursor: number,
    kind: 'hover' | 'signature' | 'definition',
  ): Promise<InspectOutcome | null> {
    if (!(await this.start())) return null;
    // inspect_result 可能既无 content 也无 signature(光标处没有可内省的东西),
    // 那时返回 null 表示「没有」。
    return this.send<InspectOutcome | null>(
      { type: 'inspect', code, cursor, kind },
      (ev) => ev.type === 'inspect_result',
      (ev) => {
        const r = ev as Extract<KernelEvent, { type: 'inspect_result' }>;
        if (!r.content && !r.signature) return null;
        return {
          content: r.content || '',
          signature: r.signature,
          name: r.name,
          start: r.start,
          end: r.end,
        };
      },
      2500,
    );
  }

  /** 重置命名空间(对应 Jupyter 的「Restart Kernel」) */
  async reset(): Promise<boolean> {
    if (!(await this.start())) return false;
    const res = await this.send<boolean>(
      { type: 'reset' },
      (ev) => ev.type === 'reset_result',
      () => true,
      8000,
    );
    if (res) this.history = [];
    return !!res;
  }

  /** 取内核信息(Python 版本 + 可执行文件路径) */
  async info2(): Promise<KernelInfo | null> {
    if (!(await this.start())) return null;
    const res = await this.send<KernelInfo>(
      { type: 'info' },
      (ev) => ev.type === 'info_result',
      (ev) => {
        const r = ev as Extract<KernelEvent, { type: 'info_result' }>;
        return { version: r.version, executable: r.executable };
      },
      5000,
    );
    if (res) this.info = res;
    return res || this.info;
  }

  /**
   * 中断当前执行。
   * 实现:杀进程 → 重建 → 按 execution_order 重放历史(Windows 上唯一可行方案)。
   */
  async interrupt(): Promise<void> {
    if (!this.proc) return;
    this.killProcess();
    const ok = await this.start();
    if (!ok || this.history.length === 0) return;

    this.replaying = true;
    try {
      const sorted = [...this.history].sort((a, b) => a.executionOrder - b.executionOrder);
      for (const h of sorted) {
        // 单格短超时:某段历史代码在新环境下出问题不能拖死整个重放
        await this.execute(h.code, { silent: true, timeoutMs: 15000 });
      }
    } finally {
      this.replaying = false;
    }
  }

  /** 关闭内核(不重放) */
  async shutdown(): Promise<void> {
    this.disposed = true;
    this.killProcess();
    this.failAllPending('内核已关闭');
    this.status = 'stopped';
  }

  private killProcess(): void {
    const child = this.proc;
    this.proc = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // ignore
    }
    // Windows 上 SIGTERM 对 python 偶尔不生效,兜底强杀。
    // 只对自己 spawn 出来的 pid 调 taskkill,不会波及无关进程。
    const proc = nodeRequire('process') as { platform?: string };
    if (proc.platform === 'win32') {
      try {
        const pid = child.pid;
        if (pid) {
          (nodeRequire('child_process') as { execFileSync(c: string, a: string[], o?: unknown): Buffer }).execFileSync(
            'taskkill',
            ['/pid', String(pid), '/T', '/F'],
            { stdio: 'ignore' },
          );
        }
      } catch {
        // 进程可能已自行退出
      }
    }
  }
}

/** 子进程最小接口(避免引 @types/node 全家桶)。 */
interface KernelProcess {
  stdout: { setEncoding(enc: string): void; on(ev: 'data', cb: (c: string) => void): void };
  stderr: { setEncoding(enc: string): void; on(ev: 'data', cb: (c: string) => void): void };
  stdin: { write(s: string): void };
  on(ev: 'error', cb: (e: Error) => void): void;
  on(ev: 'exit', cb: (code: number) => void): void;
  kill(): void;
  pid?: number;
}
