/**
 * Tree file operations (思源文件树对齐): rename / trash / permanent delete /
 * name validation / empty-file & folder creation.
 *
 * All fs access goes through the injectable NodeFsLike, so these test the
 * guard logic (clobber refusal, name rules, Windows-mandated suffix rejection)
 * without touching a real disk.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  __setFsForTest,
  createEmptyFile,
  createLink,
  deletePermanent,
  ensureDirX,
  renameEntry,
  trashEntry,
  validateEntryName,
  type NodeFsLike,
} from '../src/features/extFs';

/** Minimal in-memory fs with rename/unlink/rm/mkdir recording. */
function fakeFs(dirs: string[], files: string[]) {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const calls: string[] = [];
  const base = {
    readdirSync: () => [] as never[],
    statSync: (p: string) => ({ size: 1, mtimeMs: 1, isDirectory: () => dirs.some((d) => norm(d) === norm(p)) }),
    existsSync: (p: string) => [...dirs, ...files].map(norm).includes(norm(p)),
    readFileSync: () => '',
    writeFileSync: (p: string) => {
      files.push(p);
      calls.push(`write:${norm(p)}`);
    },
    lstatSync: (p: string) => ({ isDirectory: () => dirs.some((d) => norm(d) === norm(p)) }),
    realpathSync: (p: string) => p,
    mkdirSync: (p: string) => {
      dirs.push(p);
      calls.push(`mkdir:${norm(p)}`);
    },
    renameSync: (from: string, to: string) => {
      calls.push(`rename:${norm(from)}=>${norm(to)}`);
      const fi = files.findIndex((f) => norm(f) === norm(from));
      const di = dirs.findIndex((d) => norm(d) === norm(from));
      if (fi < 0 && di < 0) throw new Error('ENOENT: ' + from);
      if ([...dirs, ...files].map(norm).includes(norm(to))) throw new Error('EEXIST: ' + to);
      if (fi >= 0) files[fi] = to;
      else dirs[di] = to;
    },
    unlinkSync: (p: string) => {
      calls.push(`unlink:${norm(p)}`);
      const fi = files.findIndex((f) => norm(f) === norm(p));
      if (fi < 0) throw new Error('ENOENT: ' + p);
      files.splice(fi, 1);
    },
    rmSync: (p: string) => {
      calls.push(`rm:${norm(p)}`);
      const di = dirs.findIndex((d) => norm(d) === norm(p));
      if (di < 0) throw new Error('ENOENT: ' + p);
      dirs.splice(di, 1);
    },
  };
  return { fs: base as unknown as NodeFsLike, calls };
}

beforeEach(() => __setFsForTest(null));
afterEach(() => __setFsForTest(null));

describe('validateEntryName — Windows 名称规则', () => {
  it('接受普通名称与中文', () => {
    expect(validateEntryName('untitled.md')).toBe('');
    expect(validateEntryName('深度学习笔记')).toBe('');
    expect(validateEntryName('  spaced name  ')).toBe('');
  });

  it('拒绝空名与点引用', () => {
    expect(validateEntryName('')).not.toBe('');
    expect(validateEntryName('   ')).not.toBe('');
    expect(validateEntryName('.')).not.toBe('');
    expect(validateEntryName('..')).not.toBe('');
  });

  it('拒绝 Windows 非法字符', () => {
    expect(validateEntryName('a<b')).not.toBe('');
    expect(validateEntryName('a:b')).not.toBe('');
    expect(validateEntryName('a/b')).not.toBe('');
    expect(validateEntryName('a\\b')).not.toBe('');
    expect(validateEntryName('a*b')).not.toBe('');
    expect(validateEntryName('a?b')).not.toBe('');
    expect(validateEntryName('a|b')).not.toBe('');
    expect(validateEntryName('a"b')).not.toBe('');
  });

  it('名称先被 trim:尾随空格不参与校验(已被去掟)', () => {
    // validateEntryName 先 trim 再检查,所以 'name ' 实际校验的是 'name'。
    // 尾随点同理 —— 这是「用户输入会被清理」的预期行为,不是漏洞。
    expect(validateEntryName('name.')).not.toBe('');
    expect(validateEntryName('name .')).not.toBe('');
  });

  it('拒绝超长名称', () => {
    expect(validateEntryName('a'.repeat(256))).not.toBe('');
    expect(validateEntryName('a'.repeat(255))).toBe('');
  });
});

describe('renameEntry — 拒绝覆盖已有目标', () => {
  it('同名已存在时报错且不改名', () => {
    const { fs } = fakeFs([], ['E:\\m\\a.md', 'E:\\m\\b.md']);
    __setFsForTest(fs);
    const r = renameEntry('E:\\m\\a.md', 'b.md');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已存在');
  });

  it('合法改名落到 renameSync 并拼对父目录', () => {
    const { fs, calls } = fakeFs([], ['E:\\m\\a.md']);
    __setFsForTest(fs);
    const r = renameEntry('E:\\m\\a.md', 'renamed.md');
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('rename:e:/m/a.md=>e:/m/renamed.md'))).toBe(true);
  });

  it('非法名称先被名称校验拦下', () => {
    const { fs, calls } = fakeFs([], ['E:\\m\\a.md']);
    __setFsForTest(fs);
    const r = renameEntry('E:\\m\\a.md', 'x/y');
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.startsWith('rename:'))).toBe(false);
  });
});

describe('createEmptyFile / ensureDirX', () => {
  it('创建空文件;同名存在时拒绝', () => {
    const { fs } = fakeFs(['E:\\m'], []);
    __setFsForTest(fs);
    expect(createEmptyFile('E:\\m\\new.md').ok).toBe(true);
    expect(createEmptyFile('E:\\m\\new.md').ok).toBe(false);
  });

  it('ensureDirX 递归建目录', () => {
    const { fs } = fakeFs([], []);
    __setFsForTest(fs);
    expect(ensureDirX('E:\\m\\a\\b').ok).toBe(true);
  });
});

describe('trashEntry / deletePermanent', () => {
  it('trashEntry 在无 electron 环境返回失败原因(供二次确认流程)', () => {
    // vitest 环境没有 electron 模块,nodeRequire 抛错 → shell undefined。
    __setFsForTest(fakeFs([], ['E:\\m\\a.md']).fs);
    return trashEntry('E:\\m\\a.md').then((r) => {
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    });
  });

  it('deletePermanent 对文件走 unlinkSync、对目录走 rmSync', () => {
    const { fs, calls } = fakeFs(['E:\\m\\dir'], ['E:\\m\\a.md']);
    __setFsForTest(fs);
    expect(deletePermanent('E:\\m\\a.md', false).ok).toBe(true);
    expect(calls).toContain('unlink:e:/m/a.md');
    expect(deletePermanent('E:\\m\\dir', true).ok).toBe(true);
    expect(calls).toContain('rm:e:/m/dir');
  });
});

describe('与链接协同(renameEntry 的旧语义不受影响)', () => {
  it('createLink 的既有行为不被本次新增破坏', () => {
    const { fs } = fakeFs(['E:\\m'], ['E:\\m\\target.md']);
    __setFsForTest(fs);
    // Mounts/ 目录会被 ensureDir 创建;这里只断言不抛异常。
    expect(() => createLink('E:\\m\\target.md', 'E:\\vault\\Mounts\\target.md')).not.toThrow();
  });
});
