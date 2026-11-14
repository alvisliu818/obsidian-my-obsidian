import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIRTUAL_TREE_SETTINGS,
  isRemoteMount,
  mountDisplayName,
  mountFrom,
  mountsFrom,
  virtualTreeSettingsFrom,
} from '../src/types';

describe('mountFrom kind remote', () => {
  it('接受合法虚拟路径的 remote 挂载', () => {
    const m = mountFrom({ id: 'kb', kind: 'remote', path: 'github://o/r@main', label: '' });
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('remote');
    expect(m?.path).toBe('github://o/r@main');
    expect(isRemoteMount(m!)).toBe(true);
  });

  it('bdpan 挂载同样接受', () => {
    const m = mountFrom({ id: 'sync', kind: 'remote', path: 'bdpan://sync', label: '同步空间' });
    expect(m?.kind).toBe('remote');
    expect(m?.label).toBe('同步空间');
  });

  it('path 不是虚拟路径时丢弃', () => {
    expect(mountFrom({ id: 'x', kind: 'remote', path: 'D:\\notes' })).toBeNull();
    expect(mountFrom({ id: 'x', kind: 'remote', path: 'github://o' })).toBeNull();
    expect(mountFrom({ id: 'x', kind: 'remote', path: '' })).toBeNull();
  });

  it('kind 缺省仍是 external(旧 data.json 兼容)', () => {
    const m = mountFrom({ id: 'x', path: 'D:\\notes' });
    expect(m?.kind).toBe('external');
  });

  it('display name:git 短名 / bdpan 同步空间 / label 优先', () => {
    const label = mountFrom({ id: 'x', kind: 'remote', path: 'github://o/r@main', label: '我的仓库' });
    expect(mountDisplayName(label!)).toBe('我的仓库');
    const git = mountFrom({ id: 'x', kind: 'remote', path: 'github://o/r@main/docs', label: '' });
    expect(mountDisplayName(git!)).toBe('o/r@main / docs');
    const sync = mountFrom({ id: 'x', kind: 'remote', path: 'bdpan://sync', label: '' });
    expect(mountDisplayName(sync!)).toBe('同步空间');
  });

  it('自引用 attachTo 与环检测对 remote 挂载同样生效', () => {
    const list = mountsFrom([
      { id: 'a', kind: 'remote', path: 'github://o/r@main' },
      { id: 'b', kind: 'remote', path: 'bdpan://sync', attachTo: 'a/docs' },
      { id: 'c', kind: 'remote', path: 'bdpan://x', attachTo: 'c' },
    ]);
    expect(list.find((m) => m.id === 'a')?.attachTo).toBeUndefined();
    expect(list.find((m) => m.id === 'b')?.attachTo).toBe('a/docs');
    expect(list.find((m) => m.id === 'c')?.attachTo).toBeUndefined();
  });
});

describe('virtualTreeSettingsFrom remote 凭据', () => {
  it('缺省为空令牌 + 默认百度配置', () => {
    const s = virtualTreeSettingsFrom({});
    expect(s.gitGithubToken).toBe('');
    expect(s.gitGiteeToken).toBe('');
    expect(s.baiduPan.mode).toBe('official');
    expect(s.baiduPan.syncDir).toBe('/apps/sync');
  });

  it('trim 令牌、归一百度配置、凭据推断 mode', () => {
    const s = virtualTreeSettingsFrom({
      gitGithubToken: '  ghp_x  ',
      gitGiteeToken: 123,
      baiduPan: { accessToken: 'tok', refreshToken: 'r', tokenExpiresAt: 12345, syncDir: '/apps/my' },
    });
    expect(s.gitGithubToken).toBe('ghp_x');
    expect(s.gitGiteeToken).toBe('');
    expect(s.baiduPan.mode).toBe('official');
    expect(s.baiduPan.accessToken).toBe('tok');
    expect(s.baiduPan.syncDir).toBe('/apps/my');
  });

  it('cookie 模式字段保留;非法形状丢弃', () => {
    const s = virtualTreeSettingsFrom({
      baiduPan: { mode: 'cookie', bduss: ' abc ', stoken: 'st', appKey: 42 },
    });
    expect(s.baiduPan.mode).toBe('cookie');
    expect(s.baiduPan.bduss).toBe('abc');
    expect(s.baiduPan.stoken).toBe('st');
    expect(s.baiduPan.appKey).toBe('');
  });

  it('默认设置对象含 remote 字段', () => {
    expect(DEFAULT_VIRTUAL_TREE_SETTINGS.gitGithubToken).toBe('');
    expect(DEFAULT_VIRTUAL_TREE_SETTINGS.baiduPan.mode).toBe('official');
  });
});
