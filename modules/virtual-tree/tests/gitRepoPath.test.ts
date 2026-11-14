import { describe, expect, it } from 'vitest';
import {
  buildGitRepoPath,
  gitRepoChildVPath,
  gitRepoKey,
  gitRepoRootLabel,
  gitRepoShortName,
  gitRepoWebUrl,
  isGitRepoPath,
  parseGitRepoPath,
  parseRepoInput,
} from '../src/features/gitRepoPath';
import { remoteChildVPath, remoteFamilyOf, isRemotePath } from '../src/features/remotePath';

describe('parseGitRepoPath', () => {
  it('解析仓库根', () => {
    const loc = parseGitRepoPath('github://octocat/Hello-World@main');
    expect(loc).toEqual({ provider: 'github', owner: 'octocat', repo: 'Hello-World', ref: 'main', path: '' });
  });

  it('解析仓库内路径', () => {
    const loc = parseGitRepoPath('gitee://oschina/git-osc@develop/src/main.java');
    expect(loc).toEqual({ provider: 'gitee', owner: 'oschina', repo: 'git-osc', ref: 'develop', path: 'src/main.java' });
  });

  it('repo 后缀 .git 被剥掉', () => {
    const loc = parseGitRepoPath('github://o/r.git@main');
    expect(loc?.repo).toBe('r');
  });

  it('编码过的含斜杠分支能解回原 ref', () => {
    const built = buildGitRepoPath({ provider: 'github', owner: 'o', repo: 'r', ref: 'feature/login', path: 'docs/a.md' });
    expect(built).toBe('github://o/r@feature%2Flogin/docs/a.md');
    const loc = parseGitRepoPath(built);
    expect(loc?.ref).toBe('feature/login');
    expect(loc?.path).toBe('docs/a.md');
  });

  it('缺 owner/repo/ref 的都返回 null', () => {
    expect(parseGitRepoPath('github://')).toBeNull();
    expect(parseGitRepoPath('github://o')).toBeNull();
    expect(parseGitRepoPath('github://o/r')).toBeNull();
    expect(parseGitRepoPath('github://o/@main')).toBeNull();
    expect(parseGitRepoPath('github://o/r@')).toBeNull();
  });

  it('非 git 路径返回 null', () => {
    expect(parseGitRepoPath('D:\\notes')).toBeNull();
    expect(parseGitRepoPath('bdpan://sync')).toBeNull();
    expect(parseGitRepoPath('')).toBeNull();
  });

  it('结尾斜杠被剥掉', () => {
    const loc = parseGitRepoPath('github://o/r@main/docs/');
    expect(loc?.path).toBe('docs');
  });
});

describe('buildGitRepoPath / child / key', () => {
  it('build 与 parse 往返(普通分支原样可读)', () => {
    const p = buildGitRepoPath({ provider: 'gitee', owner: 'o', repo: 'r', ref: 'v1.0', path: '' });
    expect(p).toBe('gitee://o/r@v1.0');
    expect(parseGitRepoPath(p)?.ref).toBe('v1.0');
  });

  it('childVPath 拼接并折叠基准结尾斜杠', () => {
    expect(gitRepoChildVPath('github://o/r@main', 'a.md')).toBe('github://o/r@main/a.md');
    expect(gitRepoChildVPath('github://o/r@main/', 'a.md')).toBe('github://o/r@main/a.md');
  });

  it('key 同仓库同 ref 共享', () => {
    expect(gitRepoKey(parseGitRepoPath('github://o/r@main')!)).toBe('github:o/r@main');
    expect(gitRepoKey(parseGitRepoPath('github://o/r@main/docs')!)).toBe('github:o/r@main');
  });
});

describe('gitRepoWebUrl', () => {
  it('目录走 /tree/', () => {
    expect(gitRepoWebUrl('github://o/r@main', true)).toBe('https://github.com/o/r/tree/main');
    expect(gitRepoWebUrl('github://o/r@main/docs', true)).toBe('https://github.com/o/r/tree/main/docs');
  });

  it('文件走 /blob/ 并逐段编码', () => {
    expect(gitRepoWebUrl('gitee://o/r@main/src/a b.md')).toBe('https://gitee.com/o/r/blob/main/src/a%20b.md');
  });

  it('含斜杠分支按原样拼接', () => {
    expect(gitRepoWebUrl('github://o/r@feature/x', true)).toBe('https://github.com/o/r/tree/feature/x');
  });
});

describe('parseRepoInput', () => {
  it('https 地址', () => {
    expect(parseRepoInput('https://github.com/octocat/Hello-World')).toEqual({
      provider: 'github',
      owner: 'octocat',
      repo: 'Hello-World',
      ref: undefined,
    });
  });

  it('https 地址带 .git 与 tree 分支', () => {
    expect(parseRepoInput('https://github.com/o/r.git/tree/dev')).toEqual({
      provider: 'github',
      owner: 'o',
      repo: 'r',
      ref: 'dev',
    });
  });

  it('git@ SSH 地址(gitee)', () => {
    expect(parseRepoInput('git@gitee.com:oschina/git-osc.git')).toEqual({
      provider: 'gitee',
      owner: 'oschina',
      repo: 'git-osc',
      ref: undefined,
    });
  });

  it('裸 owner/repo 用入口 provider', () => {
    expect(parseRepoInput('o/r', 'gitee')).toEqual({ provider: 'gitee', owner: 'o', repo: 'r', ref: undefined });
  });

  it('接受本插件自己的虚拟路径', () => {
    expect(parseRepoInput('github://o/r@main')).toEqual({ provider: 'github', owner: 'o', repo: 'r', ref: 'main' });
  });

  it('识别不了返回 null', () => {
    expect(parseRepoInput('')).toBeNull();
    expect(parseRepoInput('https://example.com/a/b')).toBeNull();
    expect(parseRepoInput('justaword')).toBeNull();
  });
});

describe('labels / remote 分发', () => {
  it('rootLabel 带 provider 标签', () => {
    expect(gitRepoRootLabel('github://o/r@main')).toBe('[GitHub] o/r@main');
    expect(gitRepoRootLabel('gitee://o/r@main/docs')).toBe('[Gitee] o/r@main / docs');
  });

  it('shortName 不带标签', () => {
    expect(gitRepoShortName('github://o/r@main')).toBe('o/r@main');
    expect(gitRepoShortName('gitee://o/r@main/docs')).toBe('o/r@main / docs');
  });

  it('remotePath 判定与家族', () => {
    expect(isRemotePath('github://o/r@main')).toBe(true);
    expect(isRemotePath('bdpan://sync')).toBe(true);
    expect(isRemotePath('D:\\x')).toBe(false);
    expect(remoteFamilyOf('github://o/r@main')).toBe('github');
    expect(remoteFamilyOf('bdpan:///docs')).toBe('bdpan');
    expect(remoteFamilyOf('D:\\x')).toBeNull();
  });

  it('remoteChildVPath 折叠网盘根的结尾斜杠', () => {
    // 'bdpan:///' 折叠回最小前缀再拼 → 'bdpan:///docs'(body '/docs',云端 /docs)
    expect(remoteChildVPath('bdpan:///', 'docs')).toBe('bdpan:///docs');
    expect(remoteChildVPath('bdpan://sync', 'a.md')).toBe('bdpan://sync/a.md');
    expect(remoteChildVPath('github://o/r@main', 'docs')).toBe('github://o/r@main/docs');
  });

  it('isGitRepoPath 只认 git 家族', () => {
    expect(isGitRepoPath('github://o/r@main')).toBe(true);
    expect(isGitRepoPath('gitee://o/r@main')).toBe(true);
    expect(isGitRepoPath('bdpan://sync')).toBe(false);
  });
});
