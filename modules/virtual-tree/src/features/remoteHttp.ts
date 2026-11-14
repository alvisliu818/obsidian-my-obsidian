/**
 * 远端 HTTP 传输层（Git 仓库 / 百度网盘等云端后端共用）。
 *
 * Obsidian 桌面端的 `requestUrl` 走 Electron net（Chromium 网络栈）：自动跟随
 * 30x 跳转、自动解压 gzip、允许自定义任意请求头（Cookie / User-Agent /
 * Authorization —— 凭据不会出现在 URL 里）、支持二进制请求体（百度分片上传）。
 * 这些是 fetch 在渲染进程里做不到的（禁设头 + CORS），所以远端请求一律走它。
 *
 * 传输函数可注入（`__setRemoteTransportForTest`），单测用假传输层断言请求形状。
 */

import { requestUrl } from 'obsidian';

export interface RemoteHttpResponse {
  status: number;
  bytes: ArrayBuffer;
  contentType: string;
}

export interface RemoteHttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
}

export type RemoteTransport = (
  url: string,
  opts: RemoteHttpRequestOptions,
) => Promise<RemoteHttpResponse>;

const hooks: { transport?: RemoteTransport } = {};

/** Inject a fake transport for unit tests. */
export function __setRemoteTransportForTest(t: RemoteTransport | null): void {
  hooks.transport = t ?? undefined;
}

async function requestUrlTransport(url: string, opts: RemoteHttpRequestOptions): Promise<RemoteHttpResponse> {
  const body =
    opts.body === undefined || opts.body === null
      ? undefined
      : typeof opts.body === 'string'
        ? opts.body
        : opts.body;
  const resp = await requestUrl({
    url,
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: body as never,
    throw: false,
  });
  return {
    status: resp.status,
    bytes: await resp.arrayBuffer,
    contentType: String(resp.headers?.['content-type'] ?? ''),
  };
}

/** 统一请求入口。body 支持 Uint8Array（multipart 分片上传用）。 */
export async function remoteHttp(url: string, opts: RemoteHttpRequestOptions = {}): Promise<RemoteHttpResponse> {
  if (hooks.transport) return hooks.transport(url, opts);
  return requestUrlTransport(url, opts);
}

/** 把响应体按 UTF-8 解成文本（TextDecoder 忽略 BOM；非法字节替换为 U+FFFD）。 */
export function decodeRemoteText(bytes: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}
