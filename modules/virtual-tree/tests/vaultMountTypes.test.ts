/**
 * 库内挂载（kind: 'vault'）的类型层测试：kind 解析与向后兼容、vault 路径
 * 归一、挂载目标列表（listMountTargets，文件管理器右键子菜单的数据源）。
 * 全部纯函数，obsidian-stub 下即可跑。
 */

import { describe, expect, it } from 'vitest';
import {
  isVaultMount,
  listMountTargets,
  mountFrom,
  mountsFrom,
  vaultRelPath,
  type ExternalMount,
} from '../src/types';

describe('mountFrom — kind 解析与向后兼容', () => {
  it('缺 kind = external（旧 data.json 无 kind 字段照常读入）', () => {
    const m = mountFrom({ id: 'inbox', path: 'D:\\notes\\inbox' });
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('external');
    expect(isVaultMount(m!)).toBe(false);
  });

  it("kind: 'vault' 保留；path 归一为 `/` 分隔、去首尾斜杠", () => {
    const m = mountFrom({ id: 'proj', kind: 'vault', path: '/Projects\\my-proj/' });
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('vault');
    expect(isVaultMount(m!)).toBe(true);
    expect(m!.path).toBe('Projects/my-proj');
  });

  it("kind: 'vault' 且 path 归一后为空（'/' 或 '  '）→ 丢弃", () => {
    expect(mountFrom({ id: 'a', kind: 'vault', path: '/' })).toBeNull();
    expect(mountFrom({ id: 'a', kind: 'vault', path: '   ' })).toBeNull();
  });

  it('external 挂载 path 不做分隔符改写（尾部斜杠由下游容错）', () => {
    // 既有语义：mountFrom 只 trim 空白；尾部分隔符与反斜杠原样保留
    // （addMount 落盘前才 trim 尾部）。改这里会动存量 data.json 的可见行为。
    const m = mountFrom({ id: 'x', path: 'D:\\notes\\' });
    expect(m!.path).toBe('D:\\notes\\');
    expect(mountFrom({ id: 'y', path: 'D:\\notes' })!.path).toBe('D:\\notes');
  });

  it('settings 往返：docTreeSettingsFrom 保留 vault 挂载', async () => {
    const { docTreeSettingsFrom } = await import('../src/types');
    const s = docTreeSettingsFrom({
      externalMounts: [{ id: 'v1', kind: 'vault', path: 'notes', label: '笔记' }],
    });
    expect(s.externalMounts).toHaveLength(1);
    expect(s.externalMounts[0].kind).toBe('vault');
    expect(s.externalMounts[0].path).toBe('notes');
  });
});

describe('vaultRelPath — 库内相对路径归一', () => {
  it('反斜杠转正斜杠、去首尾斜杠与空白', () => {
    expect(vaultRelPath('  a\\b\\c ')).toBe('a/b/c');
    expect(vaultRelPath('/a/b/')).toBe('a/b');
    expect(vaultRelPath('\\\\a\\b')).toBe('a/b');
  });
});

describe('listMountTargets — 顶层 + 嵌套面包屑', () => {
  const base = { label: '', include: '', exclude: '', refreshSeconds: 0, pinned: false };
  const m = (over: Partial<ExternalMount>): ExternalMount =>
    mountFrom({ ...base, ...over }) as ExternalMount;

  it('无挂载 = 只有顶层', () => {
    expect(listMountTargets([])).toEqual([{ label: '顶层' }]);
  });

  it('顶层挂载各占一项；嵌套挂载带面包屑', () => {
    const mounts = mountsFrom([
      { ...base, id: 'ext', path: 'D:\\tree', enabled: true },
      { ...base, id: 'sub', path: 'D:\\other', enabled: true, attachTo: 'ext/tools' },
      { ...base, id: 'deep', path: 'E:\\x', enabled: true, attachTo: 'sub' },
    ]);
    const targets = listMountTargets(mounts);
    expect(targets[0]).toEqual({ label: '顶层' });
    // 顶层项：ext（宿主）与 other（宿主失效回落顶层——ext 存在且启用，所以
    // sub 不在顶层；deep 的宿主 sub 嵌在 ext 内，也不在顶层）。
    const labels = targets.map((t) => t.label);
    expect(labels).toContain('顶层');
    // 每个启用挂载头都是一个目标；面包屑 = 宿主链 + 宿主内子路径，与
    // 面板渲染位置一致（sub 挂在 ext 的 tools 下，deep 挂在 sub 下）。
    expect(labels).toContain('tree');
    expect(labels).toContain('tree / tools / other');
    expect(labels).toContain('tree / tools / other / x');
    // attachTo 形态：目标是挂载头自己的 id（挂到它根部）。
    const subTarget = targets.find((t) => t.label === 'tree / tools / other');
    expect(subTarget?.attachTo).toBe('sub');
    const deepTarget = targets.find((t) => t.label === 'tree / tools / other / x');
    expect(deepTarget?.attachTo).toBe('deep');
    const extTarget = targets.find((t) => t.label === 'tree');
    expect(extTarget?.attachTo).toBe('ext');
  });

  it('停用的挂载不产生目标项；宿主停用时嵌套挂载回落顶层', () => {
    const mounts = mountsFrom([
      { ...base, id: 'ext', path: 'D:\\tree', enabled: false },
      { ...base, id: 'sub', path: 'D:\\other', enabled: true, attachTo: 'ext/tools' },
    ]);
    // 停用的 ext 不产生目标项；sub 的面包屑仍能解析出宿主名（用全量表）。
    const labels = listMountTargets(mounts).map((t) => t.label);
    expect(labels).toEqual(['顶层', 'tree / tools / other']);
  });

  it('手改 data.json 造出的环不炸列表', () => {
    const mounts = mountsFrom([
      { ...base, id: 'a', path: 'D:\\a', enabled: true, attachTo: 'b' },
      { ...base, id: 'b', path: 'D:\\b', enabled: true, attachTo: 'a' },
    ]);
    // mountsFrom 清掉 a 的 attachTo（环节点在处理序里先被剪）；b 挂在 a
    // 下不再成环，保留。列表如实反映净化后的树。
    const labels = listMountTargets(mounts).map((t) => t.label);
    expect(labels).toEqual(['顶层', 'a', 'a / b']);
  });
});
