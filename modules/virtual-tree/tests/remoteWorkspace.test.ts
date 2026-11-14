import { describe, expect, it } from 'vitest';
import { remoteVPathFromWorkRel, remoteWorkRelOf } from '../src/features/remoteWorkspace';

describe('remoteWorkRelOf / remoteVPathFromWorkRel 双向映射', () => {
  it('git 仓库根下的文件', () => {
    const vPath = 'github://octocat/Hello-World@main/README.md';
    const rel = remoteWorkRelOf(vPath);
    expect(rel).toBe('github/octocat/Hello-World/main/README.md');
    expect(remoteVPathFromWorkRel(rel!)).toBe(vPath);
  });

  it('git 子目录文件逐段编码(空格/中文)', () => {
    const vPath = 'gitee://o/r@v1.0/docs/a b/笔记.md';
    const rel = remoteWorkRelOf(vPath);
    expect(rel).toBe('gitee/o/r/v1.0/docs/a%20b/%E7%AC%94%E8%AE%B0.md');
    expect(remoteVPathFromWorkRel(rel!)).toBe(vPath);
  });

  it('含斜杠分支:ref 整体编码为一个目录段', () => {
    // ref 在虚拟路径里按 URL 编码存放(否则与仓库内路径的边界无法区分)
    const vPath = 'github://o/r@feature%2Flogin/src/x.py';
    const rel = remoteWorkRelOf(vPath);
    expect(rel).toBe('github/o/r/feature%2Flogin/src/x.py');
    expect(remoteVPathFromWorkRel(rel!)).toBe(vPath);
  });

  it('bdpan 同步空间别名', () => {
    const vPath = 'bdpan://sync/notes/a.md';
    const rel = remoteWorkRelOf(vPath);
    expect(rel).toBe('bdpan/sync/notes/a.md');
    expect(remoteVPathFromWorkRel(rel!)).toBe(vPath);
  });

  it('bdpan 绝对云端路径', () => {
    const vPath = 'bdpan:///docs/a.md';
    const rel = remoteWorkRelOf(vPath);
    expect(rel).toBe('bdpan/docs/a.md');
    expect(remoteVPathFromWorkRel(rel!)).toBe('bdpan://docs/a.md');
  });

  it('非远端路径返回 null', () => {
    expect(remoteWorkRelOf('D:\\notes\\a.md')).toBeNull();
    expect(remoteWorkRelOf('')).toBeNull();
  });

  it('形状不完整的 rel 反解为 null', () => {
    expect(remoteVPathFromWorkRel('github')).toBeNull();
    expect(remoteVPathFromWorkRel('github/o')).toBeNull();
    expect(remoteVPathFromWorkRel('bdpan')).toBeNull();
    expect(remoteVPathFromWorkRel('unknown/x/y')).toBeNull();
    // 目录段(git: provider/owner/repo/ref 四段,没有文件段)反解为 null ——
    // 工作副本树里只有文件会触发保存钩子
    expect(remoteVPathFromWorkRel('github/o/r/main')).toBeNull();
  });
});
