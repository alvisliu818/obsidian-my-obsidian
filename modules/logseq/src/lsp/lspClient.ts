// LSP 客户端（通用）：子进程 + Content-Length 帧 JSON-RPC。
// 对齐 siyuan-virtual-tree lsp-client 的消息模型，进程管理适配 Obsidian
// 渲染进程（spawn 可用；stdin/stdout 分帧读写）。

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface LspSpawnSpec {
  command: string; // node.exe 绝对路径
  args: string[];
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

export class LspClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private readBuf = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, PendingRequest>();
  private dead = false;

  get isAlive(): boolean {
    return this.proc !== null && !this.dead;
  }

  start(spec: LspSpawnSpec): Promise<void> {
    this.dead = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.proc = spawn(spec.command, spec.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: spec.env ?? { ...process.env } as Record<string, string>,
        });
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.proc.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
        this.emit('exit');
      });
      this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
      this.proc.stderr!.on('data', (d: Buffer) => {
        this.emit('stderr', d.toString('utf8'));
      });
      this.proc.on('exit', () => {
        this.proc = null;
        this.emit('exit');
      });
      // stdin 可写即认为进程拉起成功（LSP initialize 由宿主随后发）
      settled = true;
      resolve();
    });
  }

  private onData(chunk: Buffer): void {
    this.readBuf = Buffer.concat([this.readBuf, chunk]);
    // Content-Length 帧循环
    for (;;) {
      const headerEnd = this.readBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.readBuf.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.readBuf = this.readBuf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      if (this.readBuf.length < headerEnd + 4 + len) return;
      const body = this.readBuf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.readBuf = this.readBuf.slice(headerEnd + 4 + len);
      this.handleMessage(JSON.parse(body));
    }
  }

  private handleMessage(msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (msg.id != null && (msg.method == null)) {
      // 响应
      const p = this.pending.get(Number(msg.id));
      if (p) {
        this.pending.delete(Number(msg.id));
        window.clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      // 服务端请求（如 workspace/configuration）与通知都发出去，由宿主负责 reply
      //（不能在此自动回 null —— 宿主的 configuration 映射会变成同 id 的二次响应）
      this.emit('message', msg);
    }
  }

  /** 宿主显式应答服务端请求（如 workspace/configuration） */
  reply(id: number | string, result: unknown): void {
    this.writeFrame({ jsonrpc: '2.0', id, result });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (r) => resolve(r as T), reject, timer });
      this.writeFrame({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.writeFrame({ jsonrpc: '2.0', method, params });
  }

  private writeFrame(msg: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
    try {
      this.proc.stdin.write(Buffer.concat([head, body]));
    } catch {
      // 管道断开
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.dead = true;
    for (const [, p] of this.pending) {
      window.clearTimeout(p.timer);
      p.reject(new Error('LSP client stopped'));
    }
    this.pending.clear();
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {
        // 忽略
      }
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // 忽略
        }
      }, 300);
    }
  }
}
