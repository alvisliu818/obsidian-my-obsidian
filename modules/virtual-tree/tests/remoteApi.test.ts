import { afterEach, describe, expect, it } from 'vitest';
import { __setRemoteTransportForTest, type RemoteHttpRequestOptions, type RemoteHttpResponse } from '../src/features/remoteHttp';
import { clearGitRepoCache, gitListDir, gitUploadFile, sameBytesIgnoreEol, initGitRepoApi } from '../src/features/gitRepoApi';
import { md5Hex } from '../src/features/baiduPanApi';
import { remoteWorkRelOf, remoteVPathFromWorkRel } from '../src/features/remoteWorkspace';

function jsonResp(body: unknown, status = 200): RemoteHttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, bytes: bytes.slice().buffer as ArrayBuffer, contentType: 'application/json' };
}

function rawResp(text: string, status = 200): RemoteHttpResponse {
  const bytes = new TextEncoder().encode(text);
  return { status, bytes: bytes.slice().buffer as ArrayBuffer, contentType: 'application/octet-stream' };
}

type Handler = (url: string, opts: RemoteHttpRequestOptions) => Promise<RemoteHttpResponse>;

afterEach(() => {
  __setRemoteTransportForTest(null);
  clearGitRepoCache();
});

describe('gitRepoApi(假传输层)', () => {
  it('gitListDir 从递归树里取直接子项', async () => {
    const calls: string[] = [];
    __setRemoteTransportForTest(async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return jsonResp({
          sha: 'root',
          tree: [
            { path: 'docs', type: 'tree', mode: '040000', sha: 'd1' },
            { path: 'docs/a.md', type: 'blob', mode: '100644', sha: 'f1', size: 3 },
            { path: 'README.md', type: 'blob', mode: '100644', sha: 'f2', size: 5 },
            { path: 'sub', type: 'commit', mode: '160000', sha: 's1' }, // 子模块跳过
          ],
        });
      }
      throw new Error('unexpected ' + url);
    });
    const nodes = await gitListDir('github://o/r@main');
    expect(calls).toHaveLength(1);
    expect(nodes.map((n) => n.name)).toEqual(['docs', 'README.md']); // 目录在前
    const docs = nodes.find((n) => n.name === 'docs')!;
    expect(docs.isDir).toBe(true);
    expect(docs.rel).toBe('docs');
    expect(docs.abs).toBe('github://o/r@main/docs');
    const readme = nodes.find((n) => n.name === 'README.md')!;
    expect(readme.size).toBe(5);
    expect(readme.abs).toBe('github://o/r@main/README.md');
  });

  it('空仓库(409)按空树处理', async () => {
    __setRemoteTransportForTest(async (url) => {
      if (url.includes('/git/trees/')) return jsonResp({ message: 'Git Repository is empty' }, 409);
      throw new Error('unexpected ' + url);
    });
    const nodes = await gitListDir('github://o/r@main');
    expect(nodes).toEqual([]);
  });

  it('gitUploadFile 内容无差异(字节相等或仅行尾差)时跳过提交', async () => {
    initGitRepoApi({ tokenOf: () => 'tok' });
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    __setRemoteTransportForTest(async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body });
      if (url.includes('/git/trees/')) {
        return jsonResp({ tree: [{ path: 'a.md', type: 'blob', mode: '100644', sha: 'f1', size: 5 }] });
      }
      if (url.includes('/contents/a.md') && opts.method === 'GET') {
        return rawResp('hello\r\nworld'); // 远端当前内容(CRLF 行尾)
      }
      throw new Error('unexpected ' + url);
    });
    // 字节完全一致 → 跳过
    expect(await gitUploadFile('github://o/r@main/a.md', new TextEncoder().encode('hello\r\nworld'))).toBe(false);
    // 仅 CRLF→LF 行尾差(编辑器序列化归一后的常态)→ 同样跳过
    expect(await gitUploadFile('github://o/r@main/a.md', new TextEncoder().encode('hello\nworld'))).toBe(false);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0); // 没有 PUT
  });

  it('gitUploadFile 内容有差异时 PUT 提交', async () => {
    initGitRepoApi({ tokenOf: () => 'tok' });
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    __setRemoteTransportForTest(async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body });
      if (url.includes('/git/trees/')) {
        return jsonResp({ tree: [{ path: 'a.md', type: 'blob', mode: '100644', sha: 'f1', size: 5 }] });
      }
      if (url.includes('/contents/a.md') && opts.method === 'GET') {
        return rawResp('hello');
      }
      if (url.includes('/contents/a.md') && opts.method === 'PUT') {
        return jsonResp({ commit: { sha: 'new' } });
      }
      throw new Error('unexpected ' + url);
    });
    const committed = await gitUploadFile('github://o/r@main/a.md', new TextEncoder().encode('world'));
    expect(committed).toBe(true);
    const put = calls.find((c) => c.method === 'PUT')!;
    // 传输层收到的 body 是已 JSON.stringify 的字符串
    const payload = JSON.parse(String(put.body)) as Record<string, unknown>;
    expect(payload.branch).toBe('main');
    expect(payload.sha).toBe('f1'); // 带上当前 blob sha
    expect(payload.content).toBe(btoa('world'));
  });

  it('sameBytesIgnoreEol 只忽略 CRLF/LF 差异(双向)', () => {
    const enc = new TextEncoder();
    expect(sameBytesIgnoreEol(enc.encode('a\r\nb'), enc.encode('a\nb'))).toBe(true);
    // 反方向同样成立(CR 全部归一):远端 LF、本地 CRLF 也不该产生提交
    expect(sameBytesIgnoreEol(enc.encode('a\nb'), enc.encode('a\r\nb'))).toBe(true);
    // 增减了行尾本身是真内容差异,不归一
    expect(sameBytesIgnoreEol(enc.encode('hello'), enc.encode('hello\r\n'))).toBe(false);
    expect(sameBytesIgnoreEol(enc.encode('a'), enc.encode('b'))).toBe(false);
    expect(sameBytesIgnoreEol(enc.encode(''), enc.encode(''))).toBe(true);
  });

  it('工作副本映射与 gitListDir 的 rel 一致(挂载单文件可反解)', () => {
    // 打开远端文件时:node.abs(虚拟)→ 工作副本 rel → 反解回虚拟路径
    const vPath = 'github://o/r@main/docs/guide.md';
    const rel = remoteWorkRelOf(vPath)!;
    expect(remoteVPathFromWorkRel(rel)).toBe(vPath);
  });
});

describe('md5Hex(百度上传校验)', () => {
  it('已知向量', () => {
    const enc = new TextEncoder();
    expect(md5Hex(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(enc.encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
});
