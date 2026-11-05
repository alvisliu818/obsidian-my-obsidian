/**
 * 内核 HTTP/SSE 传输（R1a，docs/kernel-separation-design.md §5）。
 *
 * node:http 原生实现，零新依赖——决策依据（§2.1）：流量模型是纯请求/应答 +
 * 单向事件广播，SSE 足够且 curl 可直接调试；客户端 fetch 手解 data 帧。
 * 安全（§2.4）：只绑 127.0.0.1 + 全端点 X-Kernel-Token；CORS 放开 * 是安全的
 * （真守门的是 token——渲染进程 origin 是 app://obsidian.md，跨源 fetch 需要
 * CORS 头才能读到响应）。
 *
 * 端点：GET /ping · GET /events(SSE) · POST /api/:op · POST /shutdown（§5 表）。
 * 本文件只服务 daemon bundle（platform:node）——不要从渲染进程侧 import。
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import type { KernelEvent, KernelInfo } from './kernelApi';

const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface KernelHttpServerOptions {
  token: string;
  info: () => KernelInfo;
  /** op 分发（daemonMain.handle 原样注入；msg = {op, ...body}）。 */
  handle: (msg: Record<string, unknown>) => Promise<unknown>;
  /** 优雅停机（/shutdown 应答完成后异步调用）。 */
  onShutdown: () => void | Promise<void>;
}

export interface KernelHttpServer {
  port: number;
  /** 事件广播（changed/progress → 全部 SSE 客户端）。 */
  broadcast(ev: KernelEvent): void;
  /** 活跃 SSE 客户端数（R2 空闲自退判据之一，先备好）。 */
  clientCount(): number;
  /** 最近一次请求时间（R2 空闲自退判据之一，先备好）。 */
  lastActivityMs(): number;
  /** 停服：清心跳、断 SSE、等 server close。 */
  close(): Promise<void>;
}

export async function startKernelHttpServer(opts: KernelHttpServerOptions): Promise<KernelHttpServer> {
  const sseClients = new Set<http.ServerResponse>();
  let lastActivity = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-kernel-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    // token 是唯一守门（§2.4）：所有业务端点先验
    if (req.headers['x-kernel-token'] !== opts.token) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const pathname = (new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/ping') {
      json(res, 200, { ...opts.info(), uptimeMs: Date.now() - opts.info().startedAt });
      return;
    }

    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // 首帧 hello（客户端已从 /ping 拿过 info，此帧冗余但语义完整）
      res.write(`data: ${JSON.stringify({ ev: 'hello', ...opts.info() })}\n\n`);
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && pathname === '/shutdown') {
      // 先应答再停机（停机会关掉 server，响应必须先行）
      json(res, 200, { ok: true, data: { closing: true } });
      void Promise.resolve()
        .then(opts.onShutdown)
        .catch((e: unknown) => {
          process.stderr.write(`[kernel] shutdown failed: ${String(e).slice(0, 200)}\n`);
          process.exit(1);
        });
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      const op = decodeURIComponent(pathname.slice('/api/'.length));
      if (!op) {
        json(res, 404, { ok: false, error: 'missing op' });
        return;
      }
      readBody(req)
        .then((raw) => {
          let body: Record<string, unknown> = {};
          if (raw.trim()) {
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              json(res, 400, { ok: false, error: 'bad json' });
              return null;
            }
          }
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            json(res, 400, { ok: false, error: 'body must be an object' });
            return null;
          }
          return opts.handle({ op, ...body })
            .then((data) => json(res, 200, { ok: true, data }))
            .catch((e: unknown) => json(res, 200, { ok: false, error: String(e) }));
        })
        .catch((e: unknown) => {
          const msg = String((e as Error)?.message ?? e);
          json(res, msg.includes('body too large') ? 413 : 500, { ok: false, error: msg });
        });
      return;
    }

    if (pathname === '/ping' || pathname === '/events' || pathname.startsWith('/api/') || pathname === '/shutdown') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  });

  // fetch 连接复用会被 node 默认 5s keepAliveTimeout 掐断（偶发 ECONNRESET,§5）
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    server.once('error', onErr);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onErr);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  // SSE 心跳：注释帧，既防中间层断链也是客户端活性信号（§5）
  heartbeat = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(': ping\n\n');
      } catch {
        sseClients.delete(res);
      }
    }
  }, HEARTBEAT_MS);

  return {
    port,
    broadcast(ev: KernelEvent): void {
      const frame = `data: ${JSON.stringify(ev)}\n\n`;
      for (const res of sseClients) {
        try {
          res.write(frame);
        } catch {
          sseClients.delete(res);
        }
      }
    },
    clientCount(): number {
      return sseClients.size;
    },
    lastActivityMs(): number {
      return lastActivity;
    },
    close(): Promise<void> {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* 已断 */
        }
      }
      sseClients.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
