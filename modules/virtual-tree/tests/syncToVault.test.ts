/**
 * 「同步到库」：目标位置、mklink kind（含跨盘符号链接降级）、同步记录、
 * 以及「取消同步绝不删库内真笔记」。
 *
 * fs / child_process 全部注入假实现：这里验证的是选哪个 mklink 开关、参数
 * 顺序和拒绝条件，不真的在磁盘上建链接（真机由 e2e 覆盖）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import {
  __setCpForTest,
  __setFsForTest,
  createLink,
  decodeCmdError,
  syncLinkKindFor,
  type NodeFsLike,
} from '../src/features/extFs';
import {
  cancelSync,
  isVaultLink,
  linkedState,
  performSync,
  syncKey,
  syncState,
  syncTargetFor,
  unlinkBySource,
  unlinkVaultEntry,
  type SyncHost,
} from '../src/features/syncToVault';
import { docTreeSettingsFrom, normalizeVaultFolder } from '../src/types';

interface Entry {
  dir: boolean;
  sym?: boolean;
  nlink?: number;
}

function fakeFs(init: Record<string, Entry>) {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const map = new Map<string, Entry>();
  for (const [p, e] of Object.entries(init)) map.set(norm(p), e);
  const fs = {
    readdirSync: () => [],
    statSync: (p: string) => {
      const e = map.get(norm(p));
      if (!e) throw new Error('ENOENT');
      return { size: 1, mtimeMs: 1, isDirectory: () => e.dir, nlink: e.nlink ?? 1 };
    },
    existsSync: (p: string) => map.has(norm(p)),
    lstatSync: (p: string) => {
      const e = map.get(norm(p));
      if (!e) throw new Error('ENOENT');
      return {
        size: 1,
        mtimeMs: 1,
        isDirectory: () => e.dir,
        isSymbolicLink: () => e.sym === true,
      };
    },
    readFileSync: () => '',
    writeFileSync: () => undefined,
    realpathSync: (p: string) => p,
    mkdirSync: (p: string) => {
      map.set(norm(p), { dir: true });
    },
  };
  return { fs: fs as unknown as NodeFsLike, map, norm };
}

/** 记录每次 cmd.exe 的 argv；`mklink` 调用返回成功。 */
function fakeCp() {
  const calls: string[][] = [];
  const cp = {
    execFileSync: (_file: string, args: string[]) => {
      calls.push(args);
      return undefined;
    },
  };
  return { cp, calls };
}

/** cmd.exe 走 `/d /s /c "<命令>"`，最后一个参数就是命令串本身。 */
const cmdOf = (argv: string[]): string => argv[argv.length - 1] ?? '';

interface HostSpy {
  saved: number;
  refreshed: number;
  opened: string[];
}

function fakeHost(over: Partial<SyncHost> = {}): SyncHost & HostSpy {
  const spy: HostSpy = { saved: 0, refreshed: 0, opened: [] };
  const host: SyncHost & HostSpy = {
    app: {
      vault: { getRoot: () => ({ path: '/', children: [] }) },
      workspace: {
        openLinkText: async (p: string) => {
          spy.opened.push(p);
        },
      },
    } as unknown as App,
    settings: docTreeSettingsFrom({}),
    saveSettings: async () => {
      spy.saved += 1;
    },
    refreshMounts: () => {
      spy.refreshed += 1;
    },
    vaultBasePath: () => 'E:/Vault',
    waitForIndex: async () => true,
    ...over,
    ...spy,
  };
  // spread 会把 spy 的当前值固化；用 getter 让断言看到实时值。
  Object.defineProperty(host, 'saved', { get: () => spy.saved });
  Object.defineProperty(host, 'refreshed', { get: () => spy.refreshed });
  Object.defineProperty(host, 'opened', { get: () => spy.opened });
  return host;
}

afterEach(() => {
  __setFsForTest(null);
  __setCpForTest(null);
});

const BASE = 'E:/Vault';

describe('路径与合法性', () => {
  it('syncKey 忽略大小写与分隔符差异', () => {
    expect(syncKey('E:/Notes/a.md')).toBe(syncKey('e:\\notes\\a.md'));
  });

  it('syncTargetFor 支持库根与自定义目录', () => {
    expect(syncTargetFor(BASE, 'Mounts', 'note.md')).toEqual({
      abs: 'E:/Vault/Mounts/note.md',
      rel: 'Mounts/note.md',
      name: 'note.md',
    });
    expect(syncTargetFor('E:\\Vault', '', '我的 笔记').rel).toBe('我的 笔记');
    expect(syncTargetFor(BASE, 'Inbox/Sub', 'a/b.md').name).toBe('a_b.md');
  });

  it('normalizeVaultFolder 挡住绝对路径 / .. / 隐藏目录', () => {
    expect(normalizeVaultFolder('')).toBe('');
    expect(normalizeVaultFolder('/')).toBe('');
    expect(normalizeVaultFolder('/Inbox/Sub/')).toBe('Inbox/Sub');
    expect(normalizeVaultFolder('E:\\Vault\\x')).toBeNull();
    expect(normalizeVaultFolder('a/../b')).toBeNull();
    expect(normalizeVaultFolder('.obsidian')).toBeNull();
    expect(normalizeVaultFolder('a:b')).toBeNull();
  });

  it('设置合并：非法固定目录回落 Mounts，记录只留合法条目', () => {
    expect(docTreeSettingsFrom({ syncTargetMode: 'prompt' }).syncTargetMode).toBe('prompt');
    expect(docTreeSettingsFrom({ syncTargetFolder: '../x' }).syncTargetFolder).toBe('Mounts');
    expect(docTreeSettingsFrom({ syncTargetMode: 'nonsense' }).syncTargetMode).toBe('fixed');
    const s = docTreeSettingsFrom({
      syncLinks: { 'E:\\ext\\a.md': 'Mounts/a.md', bad: '../evil', nope: 3 },
    });
    expect(s.syncLinks).toEqual({ 'e:\\ext\\a.md': 'Mounts/a.md' });
  });
});

describe('syncLinkKindFor / mklink 开关', () => {
  it('目录恒用 junction，同盘文件用硬链接，跨盘文件降级符号链接', () => {
    expect(syncLinkKindFor('D:\\ext\\folder', BASE, true)).toBe('junction');
    expect(syncLinkKindFor('E:\\ext\\a.md', BASE, false)).toBe('hardlink');
    expect(syncLinkKindFor('D:\\ext\\a.md', BASE, false)).toBe('symlink');
  });

  it('显式 kind=symlink 时 mklink 不带 /H /J', () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(fakeFs({ 'D:\\ext\\a.md': { dir: false } }).fs);
    __setCpForTest(cp);
    const r = createLink('D:\\ext\\a.md', 'E:\\Vault\\Mounts\\a.md', { kind: 'symlink' });
    expect(r).toEqual({ ok: true, kind: 'symlink' });
    expect(cmdOf(calls[0])).toContain('mklink');
    // 正斜杠必须归一成反斜杠：cmd.exe 会把 E:/HOME/... 的 /HOME 当开关。
    expect(cmdOf(calls[0])).toContain('E:\\Vault\\Mounts\\a.md');
    expect(cmdOf(calls[0])).toContain('D:\\ext\\a.md');
    expect(cmdOf(calls[0])).not.toContain('/H');
    expect(cmdOf(calls[0])).not.toContain('/J');
  });

  it('显式 kind=hardlink 仍带 /H，junction 仍带 /J', () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(
      fakeFs({ 'E:\\ext\\a.md': { dir: false }, 'E:\\ext\\folder': { dir: true } }).fs,
    );
    __setCpForTest(cp);
    createLink('E:\\ext\\a.md', 'E:\\Vault\\Mounts\\a.md', { kind: 'hardlink' });
    createLink('E:\\ext\\folder', 'E:\\Vault\\Mounts\\folder', { kind: 'junction' });
    expect(cmdOf(calls[0])).toContain('/H');
    expect(cmdOf(calls[1])).toContain('/J');
  });
});

describe('performSync / syncState / cancelSync', () => {
  it('同盘文件：/H + 记录映射 + 打开库内文件', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(fakeFs({ 'E:\\ext\\note.md': { dir: false } }).fs);
    __setCpForTest(cp);
    const host = fakeHost();
    const r = await performSync(host, 'E:\\ext\\note.md', false, 'Mounts', 'note.md');
    expect(r.ok).toBe(true);
    expect(r.rel).toBe('Mounts/note.md');
    expect(r.kind).toBe('hardlink');
    expect(cmdOf(calls[0])).toContain('/H');
    expect(host.settings.syncLinks?.[syncKey('E:\\ext\\note.md')]).toBe('Mounts/note.md');
    expect(host.saved).toBe(1);
    expect(host.refreshed).toBe(1);
    expect(host.opened).toEqual(['Mounts/note.md']);
  });

  it('跨盘文件：降级符号链接，不落 /H', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(fakeFs({ 'D:\\ext\\note.md': { dir: false } }).fs);
    __setCpForTest(cp);
    const host = fakeHost();
    const r = await performSync(host, 'D:\\ext\\note.md', false, 'Inbox', 'note.md');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('symlink');
    expect(cmdOf(calls[0])).toContain('mklink');
    expect(cmdOf(calls[0])).not.toContain('/H');
    expect(host.settings.syncLinks?.[syncKey('D:/ext/note.md')]).toBe('Inbox/note.md');
  });

  it('文件夹：/J 且不自动打开', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(fakeFs({ 'D:\\ext\\folder': { dir: true } }).fs);
    __setCpForTest(cp);
    const host = fakeHost();
    const r = await performSync(host, 'D:\\ext\\folder', true, 'Mounts', 'folder');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('junction');
    expect(cmdOf(calls[0])).toContain('/J');
    expect(host.opened).toEqual([]);
  });

  it('非法目标目录 / 目标已占用时拒绝，且不跑 mklink', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(
      fakeFs({ 'E:\\ext\\note.md': { dir: false }, 'E:\\Vault\\Mounts\\note.md': { dir: false } }).fs,
    );
    __setCpForTest(cp);
    const host = fakeHost();
    expect((await performSync(host, 'E:\\ext\\note.md', false, '../escape', 'note.md')).ok).toBe(false);
    expect((await performSync(host, 'E:\\ext\\note.md', false, 'Mounts', 'note.md')).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(host.settings.syncLinks).toEqual({});
  });

  it('syncState 要求记录 + 链接形状都在', async () => {
    const { cp } = fakeCp();
    __setFsForTest(fakeFs({ 'E:\\ext\\note.md': { dir: false } }).fs);
    __setCpForTest(cp);
    const host = fakeHost();
    expect(syncState(host, 'E:\\ext\\note.md')).toBe(false);
    await performSync(host, 'E:\\ext\\note.md', false, 'Mounts', 'note.md');
    // 假 cp 只记录命令，不真的创建目录项；补一个 hardlink 形状代表磁盘结果。
    __setFsForTest(
      fakeFs({
        'E:\\ext\\note.md': { dir: false },
        'E:\\Vault\\Mounts\\note.md': { dir: false, nlink: 2 },
      }).fs,
    );
    expect(syncState(host, 'e:/ext/note.md')).toBe(true);
    expect(syncState(host, 'E:\\other\\note.md')).toBe(false);
  });

  it('记录还在但链接位置被真笔记占用时不算已同步（防止误删）', () => {
    __setFsForTest(
      fakeFs({ 'E:\\Vault\\Mounts\\note.md': { dir: false, nlink: 1 } }).fs,
    );
    const host = fakeHost();
    host.settings.syncLinks = { [syncKey('E:\\ext\\note.md')]: 'Mounts/note.md' };
    expect(syncState(host, 'E:\\ext\\note.md')).toBe(false);
  });

  it('取消同步：删链接、清记录；遇到真目录拒绝删除并保留记录', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(
      fakeFs({
        'E:\\Vault\\Mounts\\note.md': { dir: false, nlink: 2 },
        'E:\\Vault\\Mounts\\folder': { dir: true },
      }).fs,
    );
    __setCpForTest(cp);

    const host = fakeHost();
    host.settings.syncLinks = {
      [syncKey('E:\\ext\\note.md')]: 'Mounts/note.md',
      [syncKey('E:\\ext\\folder')]: 'Mounts/folder',
    };
    const ok = await cancelSync(host, 'E:\\ext\\note.md');
    expect(ok.ok).toBe(true);
    expect(cmdOf(calls[0])).toContain('del');
    expect(cmdOf(calls[0])).toContain('Mounts\\note.md');
    expect(host.settings.syncLinks?.[syncKey('E:\\ext\\note.md')]).toBeUndefined();

    const bad = await cancelSync(host, 'E:\\ext\\folder');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/不是链接/);
    expect(calls).toHaveLength(1); // 真目录一次删除命令都没发
    expect(host.settings.syncLinks?.[syncKey('E:\\ext\\folder')]).toBe('Mounts/folder');
  });

  it('junction 取消走 rmdir（只摘重解析点）', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(
      fakeFs({ 'E:\\Vault\\Mounts\\folder': { dir: true, sym: true } }).fs,
    );
    __setCpForTest(cp);
    const host = fakeHost();
    host.settings.syncLinks = { [syncKey('D:\\ext\\folder')]: 'Mounts/folder' };
    expect((await cancelSync(host, 'D:\\ext\\folder')).ok).toBe(true);
    expect(cmdOf(calls[0])).toContain('rmdir');
    expect(cmdOf(calls[0])).toContain('Mounts\\folder');
  });
});

describe('取消链接到库内（库内侧 / 库外侧）', () => {
  it('unlinkVaultEntry 删链接并清掉指向它的同步记录；真笔记拒绝删除', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(
      fakeFs({
        'E:\\Vault\\Mounts\\note.md': { dir: false, nlink: 2 },
        'E:\\Vault\\Notes\\real.md': { dir: false, nlink: 1 },
      }).fs,
    );
    __setCpForTest(cp);
    const host = fakeHost();
    host.settings.syncLinks = { [syncKey('E:\\ext\\note.md')]: 'Mounts/note.md' };
    expect((await unlinkVaultEntry(host, 'Mounts/note.md')).ok).toBe(true);
    expect(cmdOf(calls[0])).toContain('del');
    expect(cmdOf(calls[0])).toContain('Mounts\\note.md');
    expect(host.settings.syncLinks).toEqual({});

    const bad = await unlinkVaultEntry(host, 'Notes/real.md');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/不是 mklink/);
    expect(calls).toHaveLength(1); // 真笔记一个删除命令都没发
  });

  it('isVaultLink 认得 junction / symlink / 硬链接，不认真笔记', () => {
    __setFsForTest(
      fakeFs({
        'E:\\Vault\\Mounts\\junction': { dir: true, sym: true },
        'E:\\Vault\\Mounts\\sym.md': { dir: false, sym: true },
        'E:\\Vault\\Mounts\\hard.md': { dir: false, nlink: 2 },
        'E:\\Vault\\Mounts\\real.md': { dir: false, nlink: 1 },
      }).fs,
    );
    expect(isVaultLink('E:/Vault/Mounts/junction')).toBe(true);
    expect(isVaultLink('E:/Vault/Mounts/sym.md')).toBe(true);
    expect(isVaultLink('E:/Vault/Mounts/hard.md')).toBe(true);
    expect(isVaultLink('E:/Vault/Mounts/real.md')).toBe(false);
  });

  it('linkedState 只在旧链接仍在且没有同步记录时为 true（菜单不重复）', () => {
    __setFsForTest(
      fakeFs({ 'E:\\Vault\\Mounts\\note.md': { dir: false, nlink: 2 } }).fs,
    );
    const host = fakeHost();
    expect(linkedState(host, 'E:\\ext\\note.md', 'note.md')).toBe(true);
    host.settings.syncLinks = { [syncKey('E:\\ext\\note.md')]: 'Mounts/note.md' };
    expect(linkedState(host, 'E:\\ext\\note.md', 'note.md')).toBe(false);
  });

  it('unlinkBySource 一次清掉同步记录与旧的 Mounts/ 链接', async () => {
    const { cp, calls } = fakeCp();
    __setFsForTest(
      fakeFs({
        'E:\\Vault\\Inbox\\note.md': { dir: false, sym: true },
        'E:\\Vault\\Mounts\\note.md': { dir: false, nlink: 2 },
      }).fs,
    );
    __setCpForTest(cp);
    const host = fakeHost();
    host.settings.syncLinks = { [syncKey('E:\\ext\\note.md')]: 'Inbox/note.md' };
    const r = await unlinkBySource(host, 'E:\\ext\\note.md', 'note.md');
    expect(r.ok).toBe(true);
    expect(r.rel).toBe('Inbox/note.md、Mounts/note.md');
    expect(cmdOf(calls[0])).toContain('Inbox\\note.md');
    expect(cmdOf(calls[1])).toContain('Mounts\\note.md');
    expect(host.settings.syncLinks).toEqual({});
  });

  it('同步记录本身就落在 Mounts/ 时不会因重复删除而误报失败', async () => {
    const { cp } = fakeCp();
    __setFsForTest(
      fakeFs({ 'E:\\Vault\\Mounts\\note.md': { dir: false, sym: true } }).fs,
    );
    __setCpForTest(cp);
    const host = fakeHost();
    host.settings.syncLinks = { [syncKey('E:\\ext\\note.md')]: 'Mounts/note.md' };
    expect((await unlinkBySource(host, 'E:\\ext\\note.md', 'note.md')).ok).toBe(true);
  });
});

describe('decodeCmdError — cmd.exe 的中文报错不再是一串菱形', () => {
  it('GBK/CP936 字节按 GBK 解出中文', () => {
    // "参数" 的 GBK 字节；直接 String(Buffer) 会得到 U+FFFD。
    const gbk = Buffer.from([0xb2, 0xce, 0xca, 0xfd]);
    expect(decodeCmdError({ stderr: gbk })).toBe('参数');
  });

  it('纯 ASCII 错误原样返回', () => {
    expect(decodeCmdError({ stderr: Buffer.from('Access is denied.\r\n') })).toBe('Access is denied.');
  });

  it('没有 stderr 时回退到 message', () => {
    expect(decodeCmdError(new Error('boom'))).toBe('boom');
  });
});
