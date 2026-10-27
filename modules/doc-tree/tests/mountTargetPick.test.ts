/**
 * 「挂载到…」的禁区判定（纯函数）。
 *
 * 唯一禁区：目标位置的磁盘绝对路径落在源条目内部（含相等）——那会让新挂载
 * 的子树里再渲染出它自己的挂载点，flatten 无限递归。反方向（把祖先挂到
 * 孙子里）不成环，必须允许；两种分隔符、大小写、尾部斜杠都要归一。
 */

import { describe, expect, it } from 'vitest';
import { mountTargetForbidden } from '../src/panels/mountModals';

describe('mountTargetForbidden — 目标在源内部（含相等）禁选', () => {
  const src = 'D:\\tree\\tools';

  it('目标就是源本身', () => {
    expect(mountTargetForbidden(src, 'D:\\tree', 'tools')).toBe(true);
  });

  it('目标是源的子目录（反斜杠 rel）', () => {
    expect(mountTargetForbidden(src, 'D:\\tree', 'tools\\bin')).toBe(true);
  });

  it('目标是源的子目录（joinAbs 归一混合分隔符）', () => {
    expect(mountTargetForbidden(src, 'D:\\tree', 'tools/bin')).toBe(true);
  });

  it('前缀相同但不是同一目录不算内部（tools2 ≠ tools）', () => {
    expect(mountTargetForbidden(src, 'D:\\tree', 'tools2')).toBe(false);
  });

  it('父目录与兄弟目录允许（把祖先挂到子孙里不成环）', () => {
    expect(mountTargetForbidden(src, 'D:\\tree', '')).toBe(false);
    expect(mountTargetForbidden(src, 'D:\\tree', 'apps')).toBe(false);
  });

  it('大小写与尾部斜杠归一', () => {
    expect(mountTargetForbidden('d:\\Tree\\Tools\\', 'D:\\tree', 'TOOLS')).toBe(true);
  });

  it('完全不相关的盘/路径允许', () => {
    expect(mountTargetForbidden(src, 'E:\\elsewhere', '')).toBe(false);
  });
});
