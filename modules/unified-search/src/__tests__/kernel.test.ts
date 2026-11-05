/**
 * KernelApi 契约 + HTTP/SSE 传输测试（R1a）。
 * 真起 127.0.0.1 随机端口服务,fetch 实测——与 renderer 客户端将来同款访问方式。
 */

import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDiscoveryIO, discoveryPath, KERNEL_PROTO, kernelSlug, makeToken, parseRegistryCommand } from '../daemon/kernelApi';
import { startKernelHttpServer, type KernelHttpServer } from '../daemon/httpServer';

describe('kernelApi', () => {
  it('slug 确定且文件系统安全,不同路径不撞名', () => {
    const a = kernelSlug('E:/Runtime/idx/logseq-index.sqlite');
    const b = kernelSlug('E:/Runtime/idx/logseq-index.sqlite');
    const c = kernelSlug('E:/Runtime/idx2/logseq-index.sqlite');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(a).toContain('logseq-index');
  });

  it('discoveryPath 与库同目录', () => {
    expect(discoveryPath('E:/Runtime/idx/logseq-index.sqlite')).toMatch(/^E:\/Runtime\/idx\/kernel-logseq-index-[0-9a-f]{8}\.json$/);
  });

  it('discovery 原子读写 roundtrip,缺/坏文件返回 null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-disc-'));
    try {
      const io = createDiscoveryIO(fs);
      const db = path.join(dir, 'db.sqlite');
      expect(io.read(db)).toBeNull();
      io.write(db, {
        proto: KERNEL_PROTO,
        pid: 123,
        port: 4567,
        token: 'tok',
        vault: 'V',
        dbPath: db,
        startedAt: 1,
      });
      const d = io.read(db);
      expect(d?.port).toBe(4567);
      expect(d?.token).toBe('tok');
      fs.writeFileSync(discoveryPath(db), '{broken', 'utf8');
      expect(io.read(db)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makeToken 注入随机源', () => {
    const t1 = makeToken((n) => crypto.randomBytes(n));
    const t2 = makeToken((n) => crypto.randomBytes(n));
    expect(t1).not.toBe(t2);
    expect(t1).toHaveLength(48);
  });

  it('parseRegistryCommand:常规带引号 command 值取首个 .exe 路径', () => {
    // reg query /ve 的实际输出形态（键名/REG_SZ 前缀 + 引号 command）
    expect(parseRegistryCommand('    (默认)    REG_SZ    "D:\\programs\\Obsidian\\Obsidian.exe" "%1"')).toBe(
      'D:\\programs\\Obsidian\\Obsidian.exe',
    );
    expect(parseRegistryCommand('"C:\\Program Files\\Obsidian\\obsidian.exe" "%1"')).toBe('C:\\Program Files\\Obsidian\\obsidian.exe');
  });

  it('parseRegistryCommand:无引号变体/垃圾值', () => {
    expect(parseRegistryCommand('REG_SZ C:\\Tools\\Obsidian.exe "%1"')).toBe('C:\\Tools\\Obsidian.exe');
    expect(parseRegistryCommand('')).toBe('');
    expect(parseRegistryCommand('no exe here')).toBe('');
    expect(parseRegistryCommand('"just text"')).toBe('');
  });
});

describe('kernel http server', () => {
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, substr: string, ms = 4000): Promise<string> {
    let buf = '';
    const dec = new TextDecoder();
    const deadline = Date.now() + ms;
    while (!buf.includes(substr)) {
      if (Date.now() > deadline) throw new Error(`sse timeout waiting for ${substr}`);
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    return buf;
  }

  it('ping/api/events/shutdown 全链路', async () => {
    const token = makeToken((n) => crypto.randomBytes(n));
    let shutdownCalled = false;
    let server: KernelHttpServer | null = null;
    try {
      server = await startKernelHttpServer({
        token,
        info: () => ({ proto: KERNEL_PROTO, pid: 4321, vault: 'V', dbPath: 'D', startedAt: 1 }),
        handle: async (msg) => {
          if (msg.op === 'boom') throw new Error('mock failure');
          return { echoed: msg };
        },
        onShutdown: async () => {
          shutdownCalled = true;
        },
      });
      const base = `http://127.0.0.1:${server.port}`;
      const auth = { 'x-kernel-token': token };

      // 无 token → 401
      const no = await fetch(`${base}/ping`);
      expect(no.status).toBe(401);

      // ping
      const pong = await fetch(`${base}/ping`, { headers: auth });
      const info = (await pong.json()) as { proto: number; pid: number; uptimeMs: number };
      expect(info.proto).toBe(KERNEL_PROTO);
      expect(info.pid).toBe(4321);
      expect(info.uptimeMs).toBeGreaterThanOrEqual(0);

      // POST /api/:op → {op, ...body} 交给 handle
      const r = await fetch(`${base}/api/upsert`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ paths: ['a.md'] }),
      });
      const echoed = (await r.json()) as { ok: boolean; data: { echoed: { op: string; paths: string[] } } };
      expect(echoed.ok).toBe(true);
      expect(echoed.data.echoed.op).toBe('upsert');
      expect(echoed.data.echoed.paths).toEqual(['a.md']);

      // handle 抛错 → ok:false（HTTP 仍 200,协议统一）
      const bad = await fetch(`${base}/api/boom`, { method: 'POST', headers: auth, body: '{}' });
      expect(((await bad.json()) as { ok: boolean }).ok).toBe(false);

      // bad json → 400
      const bj = await fetch(`${base}/api/ping`, { method: 'POST', headers: auth, body: '{nope' });
      expect(bj.status).toBe(400);

      // SSE：首帧 hello + broadcast 收到 changed
      const ctrl = new AbortController();
      const sse = await fetch(`${base}/events`, { headers: auth, signal: ctrl.signal });
      expect(sse.headers.get('content-type')).toContain('text/event-stream');
      const reader = sse.body!.getReader();
      await readUntil(reader, '"ev":"hello"');
      server.broadcast({ ev: 'changed', version: 7 });
      const frame = await readUntil(reader, '"version":7');
      expect(frame).toContain('"ev":"changed"');
      ctrl.abort();

      // shutdown：应答后回调 onShutdown
      const sd = await fetch(`${base}/shutdown`, { method: 'POST', headers: auth });
      expect(((await sd.json()) as { ok: boolean }).ok).toBe(true);
      expect(shutdownCalled).toBe(true);
    } finally {
      await server?.close();
    }
  });

  it('close 后 broadcast 静默不抛', async () => {
    const server = await startKernelHttpServer({
      token: 't',
      info: () => ({ proto: KERNEL_PROTO, pid: 1, vault: 'V', dbPath: 'D', startedAt: 1 }),
      handle: async () => null,
      onShutdown: () => undefined,
    });
    await server.close();
    expect(() => server.broadcast({ ev: 'changed', version: 1 })).not.toThrow();
    expect(server.clientCount()).toBe(0);
  });
});
