/**
 * videoOpenMode 的解析规则(用户 2026-10-30 决策:库内视频默认本插件播放器)。
 * types.ts 无 obsidian/DOM 依赖(经 openWith 的 obsidian stub),纯 Node 可测。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIRTUAL_TREE_SETTINGS, virtualTreeSettingsFrom } from '../src/types';

describe('virtualTreeSettingsFrom: videoOpenMode', () => {
  it('缺省即视频播放器(2026-10-30 决策,不迁移旧布尔)', () => {
    expect(virtualTreeSettingsFrom({}).videoOpenMode).toBe('player');
    expect(DEFAULT_VIRTUAL_TREE_SETTINGS.videoOpenMode).toBe('player');
  });

  it('显式 native 才走 Obsidian 原生预览', () => {
    expect(virtualTreeSettingsFrom({ videoOpenMode: 'native' }).videoOpenMode).toBe('native');
    expect(virtualTreeSettingsFrom({ videoOpenMode: 'player' }).videoOpenMode).toBe('player');
  });

  it('旧键 videoPlayerTakeOver 一并废弃:任何值都落回默认', () => {
    expect(virtualTreeSettingsFrom({ videoPlayerTakeOver: true }).videoOpenMode).toBe('player');
    expect(virtualTreeSettingsFrom({ videoPlayerTakeOver: false }).videoOpenMode).toBe('player');
  });

  it('垃圾值(data.json 用户可编辑)回落默认', () => {
    expect(virtualTreeSettingsFrom({ videoOpenMode: 'vlc' }).videoOpenMode).toBe('player');
    expect(virtualTreeSettingsFrom({ videoOpenMode: 42 }).videoOpenMode).toBe('player');
  });
});
