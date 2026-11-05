/** HttpTransport 测试（R1b）：复用 / spawn 轮询 / 超时 / 事件 / 停机。 */

import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDiscoveryIO, KERNEL_PROTO, makeToken, type DiscoveryIO, type KernelEvent } from '../daemon/kernelApi';
import { startKernelHttpServer, type KernelHttpServer } from '../daemon/httpServer';
import { HttpTransport } from '../daemon/httpTransport';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface MockKernel {
  server: KernelHttpServer;
  dbPath: string;
  io: DiscoveryIO;
  shutdownCalled: () => boolean;
}

/** 在测试进程里真起一个内核（mock handle）并把 discovery 落盘。 */
async function startMockKernel(dir: string): Promise<MockKernel> {
  const dbPath = path.join(dir, 'db.sqlite');
  const token = makeToken((n) => crypto.randomBytes(n));
  let shutdown = false;
  const server = await startKernelHttpServer({
    token,
    info: () => ({ proto: KERNEL_PROTO, pid: 999, vault: 'V', dbPath, startedAt: Date.now() }),
    handle: async (msg) => ({ echoed: msg }),
    onShutdown: async () => {
      shutdown = true;
    },
  });
  const io = createDiscoveryIO(fs);
  io.write(dbPath, { proto: KERNEL_PROTO, pid: 999, port: server.port, token, vault: 'V', dbPath, startedAt: Date.now() });
  return { server, dbPath, io, shutdownCalled: () => shutdown };
}

describe('http transport', () => {
  it('discovery 复用:不 spawn,RPC/事件/停机全链路', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-t1-'));
    try {
      const mk = await startMockKernel(dir);
      const events: KernelEvent[] = [];
      let exits = 0;
      const t = new HttpTransport({
        dbPath: mk.dbPath,
        scriptPath: 'unused',
        vault: 'V',
        findNode: async () => {
          throw new Error('should not spawn when discovery is alive');
        },
        onEvent: (ev) => events.push(ev),
        onExit: () => {
          exits++;
        },
        io: mk.io,
      });
      await t.start();
      await sleep(200); // SSE 异步建立,hello 帧非 start() 完成契约
      expect(events.some((e) => e.ev === 'hello')).toBe(true);

      const r = (await t.call('upsert', { paths: ['a.md'] })) as { echoed: { op: string } };
      expect(r.echoed.op).toBe('upsert');

      mk.server.broadcast({ ev: 'changed', version: 3 });
      await sleep(150);
      expect(events.some((e) => e.ev === 'changed' && e.version === 3)).toBe(true);

      await t.stop();
      expect(mk.shutdownCalled()).toBe(true);
      expect(exits).toBe(0); // 主动停机不算 exit
      await mk.server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disconnect 后内核仍存活（常驻语义）,新 transport 可复用', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-t4-'));
    try {
      const mk = await startMockKernel(dir);
      const t = new HttpTransport({
        dbPath: mk.dbPath,
        scriptPath: 'unused',
        vault: 'V',
        findNode: async () => 'unused',
        onEvent: () => undefined,
        onExit: () => undefined,
        io: mk.io,
      });
      await t.start();
      await sleep(150);
      t.disconnect();
      expect(mk.shutdownCalled()).toBe(false);
      // 内核未被杀：新 transport 走复用路径（findNode 禁止触发 spawn）
      const t2 = new HttpTransport({
        dbPath: mk.dbPath,
        scriptPath: 'unused',
        vault: 'V',
        findNode: async () => {
          throw new Error('should reuse, not spawn');
        },
        onEvent: () => undefined,
        onExit: () => undefined,
        io: mk.io,
      });
      await t2.start();
      const r = (await t2.call('upsert', { paths: [] })) as { echoed: { op: string } };
      expect(r.echoed.op).toBe('upsert');
      await t2.stop();
      expect(mk.shutdownCalled()).toBe(true);
      await mk.server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spawn 路径:无 discovery → spawnImpl 拉起(--http) → 轮询到就绪', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-t2-'));
    try {
      const dbPath = path.join(dir, 'db.sqlite');
      const token = makeToken((n) => crypto.randomBytes(n));
      let server: KernelHttpServer | null = null;
      const io = createDiscoveryIO(fs);
      let spawnedArgs: string[] | null = null;
      const t = new HttpTransport({
        dbPath,
        scriptPath: 'unused',
        vault: 'V',
        findNode: async () => 'fake-node',
        spawnImpl: (_cmd, args) => {
          spawnedArgs = args;
          void (async () => {
            server = await startKernelHttpServer({
              token,
              info: () => ({ proto: KERNEL_PROTO, pid: 555, vault: 'V', dbPath, startedAt: Date.now() }),
              handle: async () => ({ ok2: true }),
              onShutdown: () => undefined,
            });
            io.write(dbPath, { proto: KERNEL_PROTO, pid: 555, port: server.port, token, vault: 'V', dbPath, startedAt: Date.now() });
          })();
          return { pid: 111, kill: () => undefined, on: () => undefined };
        },
        onEvent: () => undefined,
        onExit: () => undefined,
        io,
        probeTimeoutMs: 5000,
      });
      await t.start();
      expect(spawnedArgs).toContain('--http');
      const r = (await t.call('ping')) as { ok2: boolean };
      expect(r.ok2).toBe(true);
      await t.stop();
      await (server as KernelHttpServer | null)?.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('内核起不来 → probeTimeout 后 start 拒绝', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-t3-'));
    try {
      const dbPath = path.join(dir, 'db.sqlite');
      const t = new HttpTransport({
        dbPath,
        scriptPath: 'unused',
        vault: 'V',
        findNode: async () => 'fake-node',
        spawnImpl: () => ({ pid: 1, kill: () => undefined, on: () => undefined }),
        onEvent: () => undefined,
        onExit: () => undefined,
        io: createDiscoveryIO(fs),
        probeTimeoutMs: 600,
      });
      await expect(t.start()).rejects.toThrow(/did not come up/);
      await t.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
