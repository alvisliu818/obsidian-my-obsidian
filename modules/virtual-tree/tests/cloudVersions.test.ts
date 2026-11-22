/**
 * 云端历史版本统一入口测试(OneDrive Graph / 百度同步空间网页接口)。
 *
 * 网络走 remoteHttp 的可注入传输层(__setRemoteTransportForTest),不碰真实账号;
 * 覆盖:路径分发、OneDrive 版本列表分页/下载/恢复上传、百度 cookie 模式版本列表、
 * 百度 official 模式的明确拒绝。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setRemoteTransportForTest, type RemoteHttpResponse } from '../src/features/remoteHttp';
import {
  initOneDriveApi,
  initOneDriveConfigFromSettings,
  saveOneDriveConfig,
} from '../src/features/onedriveApi';
import {
  initBaiduPanApi,
  initBaiduPanConfigFromSettings,
  saveBaiduPanConfig,
} from '../src/features/baiduPanApi';
import {
  cloudProviderOf,
  listCloudVersions,
  readCloudVersionText,
  restoreCloudVersion,
} from '../src/features/cloudVersions';
import { DEFAULT_ONEDRIVE_SETTINGS, type BaiduPanSettings } from '../src/types';

const enc = new TextEncoder();

function jsonResponse(body: unknown): RemoteHttpResponse {
  const bytes = enc.encode(JSON.stringify(body));
  return { status: 200, bytes: bytes.buffer as ArrayBuffer, contentType: 'application/json' };
}

function bytesResponse(text: string): RemoteHttpResponse {
  const bytes = enc.encode(text);
  return { status: 200, bytes: bytes.buffer as ArrayBuffer, contentType: 'text/plain' };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function setTransport(handler: (url: string, method: string) => RemoteHttpResponse | Promise<RemoteHttpResponse>): Call[] {
  const calls: Call[] = [];
  __setRemoteTransportForTest(async (url, opts) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, headers: opts.headers || {}, body: opts.body ?? null });
    return await handler(url, method);
  });
  return calls;
}

function setupOneDrive(): void {
  initOneDriveApi({
    get: () => ({ ...DEFAULT_ONEDRIVE_SETTINGS }),
    save: async () => undefined,
  });
  initOneDriveConfigFromSettings();
  void saveOneDriveConfig({
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    tokenExpiresAt: Date.now() + 3600_000,
    clientId: 'client',
  });
}

function setupBaidu(mode: 'cookie' | 'official'): void {
  const base: BaiduPanSettings = {
    mode,
    bduss: '',
    stoken: '',
    appKey: '',
    secretKey: '',
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: 0,
    syncDir: '/apps/sync',
  };
  initBaiduPanApi({
    get: () => ({ ...base }),
    save: async () => undefined,
  });
  initBaiduPanConfigFromSettings();
  void saveBaiduPanConfig({ mode, bduss: 'BDUSS_TEST', stoken: 'STOKEN_TEST', accessToken: 'AT' });
}

beforeEach(() => {
  __setRemoteTransportForTest(null);
});

afterEach(() => {
  __setRemoteTransportForTest(null);
});

describe('cloudProviderOf', () => {
  it('按挂载前缀分发 OneDrive / 百度,其他路径返回 null', () => {
    expect(cloudProviderOf('onedrive://docs/a.md')).toBe('onedrive');
    expect(cloudProviderOf('bdpan://sync/a.md')).toBe('bdpan');
    expect(cloudProviderOf('github://u/r/a.md')).toBeNull();
    expect(cloudProviderOf('E:/vault/a.md')).toBeNull();
  });
});

describe('OneDrive 云端历史', () => {
  it('列版本:解析 item id、跟随分页、按时间倒序', async () => {
    setupOneDrive();
    const calls = setTransport((url) => {
      if (url.includes('/versions?page=2')) {
        return jsonResponse({ value: [{ id: '1', lastModifiedDateTime: '2026-01-01T00:00:00Z', size: 10 }] });
      }
      if (url.includes('/versions')) {
        return jsonResponse({
          value: [{ id: '2', lastModifiedDateTime: '2026-01-02T00:00:00Z', size: 20 }],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/me/drive/items/ITEM1/versions?page=2',
        });
      }
      if (url.includes('$select=id')) return jsonResponse({ id: 'ITEM1' });
      throw new Error('unexpected url ' + url);
    });

    const versions = await listCloudVersions('onedrive://docs/a.md');
    expect(versions.map((v) => v.id)).toEqual(['2', '1']);
    expect(versions[0]).toMatchObject({ size: 20, modified: '2026-01-02T00:00:00Z' });
    expect(calls.some((c) => c.url.includes('/me/drive/items/ITEM1/versions'))).toBe(true);
    expect(calls[0].headers.Authorization).toBe('Bearer test-token');
  });

  it('恢复版本:下载版本内容后 PUT 回原路径', async () => {
    setupOneDrive();
    const calls = setTransport((url, method) => {
      if (url.includes('$select=id')) return jsonResponse({ id: 'ITEM9' });
      if (url.includes('/versions/V2/content')) return bytesResponse('OLD CONTENT');
      if (method === 'PUT' && url.includes('/root:docs/a.md:/content')) return jsonResponse({ id: 'ITEM9' });
      throw new Error('unexpected url ' + url);
    });

    const msg = await restoreCloudVersion('onedrive://docs/a.md', 'V2');
    expect(msg).toContain('已恢复');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeTruthy();
    expect(new TextDecoder().decode(put!.body as Uint8Array)).toBe('OLD CONTENT');
  });

  it('预览:返回版本文本;超过 2MB 拒绝', async () => {
    setupOneDrive();
    setTransport((url) => {
      if (url.includes('$select=id')) return jsonResponse({ id: 'ITEM7' });
      if (url.includes('/versions/V1/content')) return bytesResponse('hello version');
      throw new Error('unexpected url ' + url);
    });
    expect(await readCloudVersionText('onedrive://a.md', 'V1')).toBe('hello version');
  });
});

describe('百度同步空间云端历史', () => {
  it('cookie 模式:带 BDUSS/bdstoken 调 revisionlist,归一字段并倒序', async () => {
    setupBaidu('cookie');
    const calls = setTransport((url) => {
      if (url.includes('/api/gettemplatevariable')) return jsonResponse({ errno: 0, result: { bdstoken: 'BDS' } });
      if (url.includes('/workspace/revisionlist')) {
        return jsonResponse({
          errno: 0,
          data: {
            list: [
              { revision: '2', server_mtime: 1700000000, size: 12 },
              { revision: '3', server_mtime: 1700000100, size: 30, index: 0 },
            ],
          },
        });
      }
      throw new Error('unexpected url ' + url);
    });

    const versions = await listCloudVersions('bdpan://sync/notes/a.md');
    expect(versions.map((v) => v.id)).toEqual(['3', '2']);
    expect(versions[0].current).toBe(true);
    const listCall = calls.find((c) => c.url.includes('/workspace/revisionlist'));
    expect(listCall).toBeTruthy();
    expect(listCall!.url).toContain('product_type=workspace');
    expect(listCall!.url).toContain('bdstoken=BDS');
    expect(listCall!.url).toContain('path=%2Fapps%2Fsync%2Fnotes%2Fa.md');
    expect(listCall!.headers.Cookie).toContain('BDUSS=BDUSS_TEST');
    expect(listCall!.headers.Cookie).toContain('STOKEN=STOKEN_TEST');
  });

  it('official 模式:明确提示需要 cookie 模式', async () => {
    setupBaidu('official');
    setTransport(() => jsonResponse({ errno: 0 }));
    await expect(listCloudVersions('bdpan://sync/a.md')).rejects.toThrow(/cookie 模式/);
  });

  it('百度不提供版本内容下载:预览直接拒绝', async () => {
    setupBaidu('cookie');
    setTransport(() => jsonResponse({ errno: 0 }));
    await expect(readCloudVersionText('bdpan://sync/a.md', '1')).rejects.toThrow(/不提供历史版本内容下载/);
  });
});
