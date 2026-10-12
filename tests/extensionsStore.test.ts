import { describe, it, expect, beforeEach } from 'vitest';
import type { InstalledExtension } from '../src/extensions/types';

// extensionStore 依赖 obsidian 的 normalizePath 与 ../main 的类型；vitest 下
// obsidian 由 stub 顶替（normalizePath 为恒等）。这里构造一个内存 adapter 的
// 假 plugin 来驱动存储层。
import {
  loadInstalledExtensions,
  addInstalledExtension,
  removeInstalledExtension,
  toggleExtensionEnabled,
  isExtensionInstalled,
  getInstalledExtension,
} from '../src/extensions/extensionStore';

interface FakePlugin {
  manifest: { id: string };
  // deno-lint-ignore no-explicit-any
  app: { vault: { adapter: Record<string, (...args: any[]) => Promise<unknown>> } };
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
}

function makeFakePlugin(): { plugin: FakePlugin; files: Map<string, string>; data: Record<string, unknown> } {
  const files = new Map<string, string>();
  const data: Record<string, unknown> = {};
  const plugin: FakePlugin = {
    manifest: { id: 'obsidian-logseq' },
    app: {
      vault: {
        adapter: {
          mkdir: async () => undefined,
          write: async (p: string, c: string) => {
            files.set(p, c);
          },
          read: async (p: string) => {
            if (!files.has(p)) throw new Error('ENOENT');
            return files.get(p)!;
          },
          remove: async (p: string) => {
            if (!files.has(p)) throw new Error('ENOENT');
            files.delete(p);
          },
          exists: async (p: string) => files.has(p),
        },
      },
    },
    loadData: async () => JSON.parse(JSON.stringify(data)),
    saveData: async (d: unknown) => {
      Object.keys(data).forEach((k) => delete data[k]);
      Object.assign(data, JSON.parse(JSON.stringify(d)));
    },
  };
  return { plugin, files, data };
}

function fakeExt(id: string, enabled = true): InstalledExtension {
  return {
    id,
    namespace: 'ns',
    name: id,
    version: '1.0.0',
    displayName: id,
    description: '',
    enabled,
    installedAt: 0,
    files: { 'package.json': '{}' },
    contributes: {},
  };
}

const DIR = '.obsidian/plugins/obsidian-logseq/ext-store'; // normalizePath stub 为恒等

describe('extensionStore', () => {
  let env: ReturnType<typeof makeFakePlugin>;
  beforeEach(() => {
    env = makeFakePlugin();
  });

  it('add + load round-trips through ext-store files and data.json index', async () => {
    await addInstalledExtension(env.plugin as never, fakeExt('a.b'));
    expect(env.files.get(`${DIR}/a.b.json`)).toBeDefined();
    const list = await loadInstalledExtensions(env.plugin as never);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('a.b');
    const idx = (env.data as Record<string, unknown>)['ext-index'] as { ids?: string[] } | undefined;
    expect(idx?.ids).toEqual(['a.b']);
  });

  it('same id replaces (update path)', async () => {
    await addInstalledExtension(env.plugin as never, fakeExt('a.b'));
    const v2 = { ...fakeExt('a.b'), version: '2.0.0' };
    await addInstalledExtension(env.plugin as never, v2);
    const list = await loadInstalledExtensions(env.plugin as never);
    expect(list).toHaveLength(1);
    expect(list[0].version).toBe('2.0.0');
  });

  it('remove deletes file and index entry', async () => {
    await addInstalledExtension(env.plugin as never, fakeExt('a.b'));
    await addInstalledExtension(env.plugin as never, fakeExt('c.d'));
    await removeInstalledExtension(env.plugin as never, 'a.b');
    expect(env.files.has(`${DIR}/a.b.json`)).toBe(false);
    const list = await loadInstalledExtensions(env.plugin as never);
    expect(list.map((e) => e.id)).toEqual(['c.d']);
  });

  it('toggle flips enabled in the stored file', async () => {
    await addInstalledExtension(env.plugin as never, fakeExt('a.b', true));
    await toggleExtensionEnabled(env.plugin as never, 'a.b');
    const one = await getInstalledExtension(env.plugin as never, 'a.b');
    expect(one?.enabled).toBe(false);
    await toggleExtensionEnabled(env.plugin as never, 'a.b');
    expect((await getInstalledExtension(env.plugin as never, 'a.b'))?.enabled).toBe(true);
  });

  it('missing data file is dropped from the index on load', async () => {
    await addInstalledExtension(env.plugin as never, fakeExt('a.b'));
    await addInstalledExtension(env.plugin as never, fakeExt('c.d'));
    env.files.delete(`${DIR}/a.b.json`); // 模拟数据文件丢失
    const list = await loadInstalledExtensions(env.plugin as never);
    expect(list.map((e) => e.id)).toEqual(['c.d']);
    expect(await isExtensionInstalled(env.plugin as never, 'a.b')).toBe(false);
  });

  it('getInstalledExtension returns null for unknown id', async () => {
    expect(await getInstalledExtension(env.plugin as never, 'nope.nope')).toBeNull();
  });
});
