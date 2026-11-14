import { describe, expect, it } from 'vitest';
import {
  BDPAN_PREFIX,
  BDPAN_SYNC_ROOT,
  baiduChildVPath,
  baiduPathBody,
  baiduRootLabel,
  baiduShortName,
  isBaiduPath,
  isBaiduSyncPath,
} from '../src/features/baiduPath';

describe('baiduPath 语法层', () => {
  it('前缀判定', () => {
    expect(isBaiduPath('bdpan://sync')).toBe(true);
    expect(isBaiduPath('bdpan:///apps/sync')).toBe(true);
    expect(isBaiduPath('bdpan://')).toBe(true);
    expect(isBaiduPath('github://o/r@main')).toBe(false);
    expect(isBaiduPath('D:\\x')).toBe(false);
  });

  it('body 去前缀并剥结尾斜杠', () => {
    expect(baiduPathBody('bdpan://sync/')).toBe('sync');
    expect(baiduPathBody('bdpan:///docs')).toBe('/docs');
    expect(baiduPathBody(BDPAN_PREFIX)).toBe('');
  });

  it('同步空间别名判定', () => {
    expect(isBaiduSyncPath(BDPAN_SYNC_ROOT)).toBe(true);
    expect(isBaiduSyncPath('bdpan://sync/sub')).toBe(true);
    expect(isBaiduSyncPath('bdpan:///apps/sync')).toBe(false);
  });

  it('显示名', () => {
    expect(baiduRootLabel('bdpan://sync')).toBe('[同步空间] 百度网盘');
    expect(baiduRootLabel('bdpan:///docs')).toBe('[百度网盘] /docs');
    expect(baiduShortName('bdpan://sync')).toBe('同步空间');
    expect(baiduShortName('bdpan://')).toBe('百度网盘');
  });

  it('childVPath 拼接', () => {
    expect(baiduChildVPath('bdpan://sync', 'a.md')).toBe('bdpan://sync/a.md');
  });
});
