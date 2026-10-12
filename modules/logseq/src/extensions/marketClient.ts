// 扩展市场客户端（双来源，统一入口）
//
// Open VSX Registry（公开 REST，文档 https://open-vsx.org/swagger-ui）:
//   搜索: GET /api/-/search?query={q}&size={n}&offset={o}
//   元数据: GET /api/{namespace}/{extension}[/{version}]
//   下载: 元数据 files.download 指向的 VSIX
//
// VSCode Marketplace（非官方协议，仅供 VSCode 客户端使用，优先 Open VSX）:
//   搜索: POST /_apis/public/gallery/extensionquery（criteria.filterType 8=SearchText 5=Target 7=ExtensionName）
//   下载: GET /_apis/public/gallery/publishers/{p}/vsextensions/{e}/{v}/vspackage
//
// 网络层统一走 Obsidian 的 requestUrl（主进程请求，无 CSP/CORS 限制，
// 且支持 arrayBuffer）；不能直接 fetch（渲染进程受 CSP 约束）。

import { requestUrl } from 'obsidian';
import type { SearchEntry, SearchResult } from './types';

const OPENVSX_BASE = 'https://open-vsx.org/api';
const MARKETPLACE_BASE = 'https://marketplace.visualstudio.com/_apis/public/gallery';

/** requestUrl 的 JSON GET */
async function getJSON(url: string): Promise<unknown> {
  const resp = await requestUrl({ url, method: 'GET' });
  if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
  return resp.json;
}

/** requestUrl 的 JSON POST（Marketplace extensionquery 用） */
async function postJSON(url: string, body: unknown, accept: string): Promise<unknown> {
  const resp = await requestUrl({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: accept },
    body: JSON.stringify(body),
  });
  if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
  return resp.json;
}

/** requestUrl 下载二进制（VSIX） */
async function getBinary(url: string): Promise<ArrayBuffer> {
  const resp = await requestUrl({ url, method: 'GET' });
  if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
  return resp.arrayBuffer;
}

// ------------------------------------------------------------------
// Open VSX

export async function searchOpenVsx(query: string, size = 20, offset = 0): Promise<SearchResult> {
  const url = `${OPENVSX_BASE}/-/search?query=${encodeURIComponent(query)}&size=${size}&offset=${offset}`;
  const data = (await getJSON(url)) as Record<string, any>;
  const extensions: SearchEntry[] = (data.extensions ?? []).map((e: any) => ({
    namespace: String(e.namespace ?? ''),
    name: String(e.name ?? ''),
    version: String(e.version ?? '0.0.0'),
    displayName: e.displayName || e.name || '',
    description: e.description || '',
    downloadLink: e.files?.download || '',
    iconLink: e.files?.icon || e.files?.resource || '',
    averageRating: e.averageRating,
    reviewCount: e.reviewCount,
    timestamp: e.timestamp != null ? String(e.timestamp) : undefined,
    source: 'openvsx',
  }));
  return { extensions, offset: Number(data.offset ?? offset), totalSize: Number(data.totalSize ?? extensions.length) };
}

/** Open VSX 扩展元数据（指定 version 时返回该版本） */
export async function getOpenVsxMetadata(namespace: string, extension: string, version?: string): Promise<Record<string, any>> {
  const url = version
    ? `${OPENVSX_BASE}/${encodeURIComponent(namespace)}/${encodeURIComponent(extension)}/${encodeURIComponent(version)}`
    : `${OPENVSX_BASE}/${encodeURIComponent(namespace)}/${encodeURIComponent(extension)}`;
  return (await getJSON(url)) as Record<string, any>;
}

export async function downloadOpenVsxVsix(downloadLink: string): Promise<ArrayBuffer> {
  if (!downloadLink) throw new Error('下载链接为空');
  return getBinary(downloadLink);
}

// ------------------------------------------------------------------
// VSCode Marketplace

// flags 0x192 = IncludeVersionProperties | IncludeAssetUri | IncludeStatistics | IncludeLatestVersionOnly
const MK_FLAGS = 0x192;
const MK_ACCEPT = 'application/json;api-version=3.0-preview.1';

interface MkExtension {
  publisher?: { publisherName?: string };
  extensionName?: string;
  displayName?: string;
  shortDescription?: string;
  versions?: {
    version?: string;
    lastUpdated?: string;
    files?: { assetType: string; source?: string }[];
    properties?: { key: string; value?: string }[];
  }[];
  statistics?: { statisticName: string; value?: number }[];
}

/** 从 Marketplace 查询响应条目提取 SearchEntry（搜索与按名查询共用） */
function mkEntryFrom(ext: MkExtension): SearchEntry | null {
  const publisher = ext.publisher?.publisherName || '';
  const name = ext.extensionName || '';
  const latest = ext.versions?.[0];
  if (!publisher || !name || !latest) return null;
  const files = latest.files ?? [];
  const downloadLink = files.find((f) => f.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage')?.source;
  const iconLink = files.find((f) => f.assetType === 'Microsoft.VisualStudio.Services.Icons.Default')?.source;
  const stats = ext.statistics ?? [];
  const rating = stats.find((s) => s.statisticName === 'averagerating')?.value;
  const ratingCount = stats.find((s) => s.statisticName === 'ratingcount')?.value;
  const descProp = (latest.properties ?? []).find((p) => p.key === 'Microsoft.VisualStudio.Code.ExtensionProperties.Description');
  return {
    namespace: publisher,
    name,
    version: latest.version || '0.0.0',
    displayName: ext.displayName || name,
    description: descProp?.value || ext.shortDescription || '',
    downloadLink,
    iconLink,
    averageRating: rating,
    reviewCount: ratingCount,
    timestamp: latest.lastUpdated,
    source: 'vscode-marketplace',
  };
}

export async function searchMarketplace(query: string, size = 20, pageNumber = 1): Promise<SearchResult> {
  const body = {
    filters: [{
      pageNumber,
      pageSize: size,
      criteria: [
        { filterType: 8, value: query }, // 8 = SearchText
        { filterType: 5, value: 'Microsoft.VisualStudio.Code' }, // 5 = Target
      ],
    }],
    assetTypes: ['Microsoft.VisualStudio.Services.VSIXPackage'],
    flags: MK_FLAGS,
  };
  const data = (await postJSON(`${MARKETPLACE_BASE}/extensionquery`, body, MK_ACCEPT)) as Record<string, any>;
  const items: MkExtension[] = data.results?.[0]?.extensions ?? [];
  const extensions: SearchEntry[] = [];
  for (const ext of items) {
    const entry = mkEntryFrom(ext);
    if (entry) extensions.push(entry);
  }
  return { extensions, offset: (pageNumber - 1) * size, totalSize: extensions.length };
}

/** Marketplace 查询特定扩展的最新版本号 */
export async function getMarketplaceLatestVersion(publisher: string, extension: string): Promise<string> {
  const body = {
    filters: [{
      pageNumber: 1,
      pageSize: 1,
      criteria: [
        { filterType: 7, value: `${publisher}.${extension}` }, // 7 = ExtensionName
        { filterType: 5, value: 'Microsoft.VisualStudio.Code' },
      ],
    }],
    assetTypes: [],
    flags: MK_FLAGS,
  };
  const data = (await postJSON(`${MARKETPLACE_BASE}/extensionquery`, body, MK_ACCEPT)) as Record<string, any>;
  const version = data.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
  if (!version) throw new Error(`未找到扩展 ${publisher}.${extension}`);
  return String(version);
}

/** Marketplace 下载 VSIX。端点可能返回 gzip 压缩内容；Node 层（requestUrl）通常已自动解压，
 *  未解压时上层 parseVsix 会按 magic bytes 兜底（vscode-marketplace-gzip 分支）。 */
export async function downloadMarketplaceVsix(publisher: string, extension: string, version: string): Promise<ArrayBuffer> {
  const url = `${MARKETPLACE_BASE}/publishers/${encodeURIComponent(publisher)}/vsextensions/${encodeURIComponent(extension)}/${encodeURIComponent(version)}/vspackage`;
  return getBinary(url);
}
