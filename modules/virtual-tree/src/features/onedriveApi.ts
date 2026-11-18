/**
 * OneDrive 网盘接入(思源 onedrive.ts 对齐):微软 Graph API + 设备码授权。
 *
 * 架构对齐 baiduPanApi.ts:
 *   - 配置与令牌存插件设置切片(settings.oneDrive),令牌自动刷新(expiresAt 前
 *     60s / 401 兜底刷新重试一次);
 *   - 授权:OAuth2 设备码流(无需回调地址;用户在任意设备打开
 *     microsoft.com/devicelogin 输码)。需要用户自己的 Azure 应用(Entra 管理中心
 *     注册,类型选"个人",重定向 URI 留空,API 权限勾 Files.ReadWrite.All +
 *     User.Read + offline_access,并把「允许公共客户端流」设为是)—— 插件无法
 *     替用户注册应用,client_id 由用户填入;
 *   - API:Graph v1.0 /me/drive(个人与企业版 OneDrive 通用);
 *   - 传输:remoteHttp(requestUrl 走 Electron net,任意头 + 二进制体 + 跟随 30x,
 *     Graph 允许 CORS 也无所谓——我们不走 fetch);
 *   - 路径:onedrive:///<云端路径> 虚拟路径(见 onedrivePath.ts)。
 */

import { decodeRemoteText, remoteHttp } from './remoteHttp';
import { OD_PREFIX, oneDrivePathBody } from './onedrivePath';
import type { OneDriveSettings } from '../types';
import type { MountNode } from './mountFilter';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
/** 设备码授权默认 scope:offline_access(拿 refresh_token)+ 文件读写 + 基本信息 */
export const OD_SCOPE = 'offline_access files.readwrite.all user.read';

// ==== 配置注入(main.ts onload 时接上 settings;保存回调换 saveSettings) ====

interface OneDriveStoreHooks {
  get: () => OneDriveSettings;
  save: (next: OneDriveSettings) => Promise<void>;
}

let odHooks: OneDriveStoreHooks = {
  get: () => ({ ...DEFAULT_OD_CONFIG }),
  save: async () => undefined,
};

const DEFAULT_OD_CONFIG: OneDriveSettings = {
  clientId: '',
  authority: 'common',
  accessToken: '',
  refreshToken: '',
  tokenExpiresAt: 0,
  account: '',
};

export function initOneDriveApi(hooks: OneDriveStoreHooks): void {
  odHooks = hooks;
}

/** 内存中的当前配置:启动时从 settings 初始化,令牌轮换即时回写 */
let odConfig: OneDriveSettings = { ...DEFAULT_OD_CONFIG };

export function initOneDriveConfigFromSettings(): void {
  odConfig = { ...odHooks.get() };
}

/** 保存配置(令牌轮换/手动改 clientId) */
export async function saveOneDriveConfig(next: Partial<OneDriveSettings>): Promise<void> {
  odConfig = {
    ...odConfig,
    ...next,
    clientId: (next.clientId ?? odConfig.clientId).trim(),
    authority: (next.authority ?? odConfig.authority).trim() || 'common',
    account: next.account ?? odConfig.account,
  };
  clearOneDriveListCache();
  await odHooks.save({ ...odConfig });
}

export function getOneDriveConfig(): OneDriveSettings {
  return { ...odConfig };
}

/** 是否具备可用凭据(有 refresh token 或未过期的 access token) */
export function isOneDriveConfigured(): boolean {
  return !!(
    odConfig.clientId &&
    (odConfig.refreshToken || (odConfig.accessToken && odConfig.tokenExpiresAt > Date.now()))
  );
}

// ==== 设备码授权(OAuth2 device flow)====

export interface OdDeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: number;
}

function formEncode(fields: Record<string, string>): string {
  const parts: string[] = [];
  for (const k of Object.keys(fields)) {
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]));
  }
  return parts.join('&');
}

function decodeJson(bytes: ArrayBuffer, op: string): Record<string, unknown> {
  const text = decodeRemoteText(bytes);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${op}失败:响应不是 JSON`);
  }
}

function tokenErrorText(json: Record<string, unknown>): string {
  const code = String(json.error || '');
  if (code === 'authorization_expired') return '授权码已过期,请重新发起授权';
  if (code === 'access_denied') return '你在微软页面拒绝了授权';
  if (code === 'invalid_client') return '应用(client) ID 无效,请检查设置';
  return String(json.error_description || code || '授权失败');
}

/** 发起设备码授权。tenant 为登录端点租户段(common/consumers/organizations/租户 ID) */
export async function odStartDeviceAuth(clientId: string, tenant: string): Promise<OdDeviceAuth> {
  const resp = await remoteHttp(`https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({ client_id: clientId, scope: OD_SCOPE }),
  });
  const json = decodeJson(resp.bytes, '发起设备码授权');
  if (!json.device_code || !json.user_code) {
    throw new Error(`发起设备码授权失败: ${json.error_description || json.error || '响应缺少 device_code'}`);
  }
  return {
    deviceCode: String(json.device_code),
    userCode: String(json.user_code),
    verificationUrl: String(json.verification_uri || 'https://microsoft.com/devicelogin'),
    interval: Number(json.interval) || 5,
    expiresAt: Date.now() + (Number(json.expires_in) || 900) * 1000,
  };
}

// 轮询授权结果:pending=继续等;slow=请求过快;done=拿到令牌(已写配置)。
// 致命错误(authorization_expired/access_denied 等)直接抛出。
export async function odPollDeviceAuth(auth: OdDeviceAuth): Promise<'pending' | 'slow' | 'done'> {
  const resp = await remoteHttp(
    `https://login.microsoftonline.com/${odConfig.authority || 'common'}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: odConfig.clientId,
        device_code: auth.deviceCode,
      }),
    },
  );
  const json = decodeJson(resp.bytes, '令牌请求');
  if (json.error) {
    if (json.error === 'authorization_pending') return 'pending';
    if (json.error === 'slow_down') return 'slow';
    throw new Error(tokenErrorText(json));
  }
  await saveOneDriveConfig({
    accessToken: String(json.access_token || ''),
    refreshToken: String(json.refresh_token || odConfig.refreshToken),
    tokenExpiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
  // 授权成功顺带取账号名(展示用;失败不影响授权结果)
  void odGraph('GET', '/me?$select=userPrincipalName')
    .then((r) => {
      const upn = String((r.json as Record<string, unknown>)?.userPrincipalName || '');
      if (upn) void saveOneDriveConfig({ account: upn });
    })
    .catch(() => undefined);
  return 'done';
}

// 用 refresh token 换新 access token;失败抛错(调用方降级为未登录提示)
async function refreshAccessToken(): Promise<void> {
  if (!odConfig.refreshToken) throw new Error('OneDrive 未授权或凭据已失效,请重新授权');
  const resp = await remoteHttp(
    `https://login.microsoftonline.com/${odConfig.authority || 'common'}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        grant_type: 'refresh_token',
        client_id: odConfig.clientId,
        refresh_token: odConfig.refreshToken,
        scope: OD_SCOPE,
      }),
    },
  );
  const json = decodeJson(resp.bytes, '令牌请求');
  if (json.error) throw new Error(tokenErrorText(json));
  await saveOneDriveConfig({
    accessToken: String(json.access_token || ''),
    refreshToken: String(json.refresh_token || odConfig.refreshToken),
    tokenExpiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
}

// 确保访问令牌可用(过期前 60s 自动刷新)
async function ensureAccessToken(): Promise<string> {
  if (!odConfig.accessToken || Date.now() > odConfig.tokenExpiresAt - 60_000) {
    await refreshAccessToken();
  }
  return odConfig.accessToken;
}

// ==== Graph API 封装 ====

// Graph 错误转可读信息
function graphError(json: Record<string, unknown> | null, op: string, status: number): Error {
  const err = (json?.error ?? {}) as Record<string, unknown>;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  if (status === 401) return new Error(`${op}失败:令牌无效或已过期(401)`);
  if (status === 404) return new Error(`${op}失败:文件或目录不存在(404)`);
  if (code === 'nameAlreadyExists') return new Error(`${op}失败:同名文件或目录已存在`);
  if (code === 'invalidAuthenticationToken') return new Error(`${op}失败:令牌无效,请重新授权`);
  return new Error(`${op}失败: ${msg || code || 'HTTP ' + status}`);
}

interface GraphResp {
  status: number;
  json: Record<string, unknown> | null;
  bytes: ArrayBuffer;
}

// Graph 请求(JSON 响应);401 时刷新令牌重试一次
async function odGraph(method: string, graphPath: string, body?: string | Uint8Array, contentType?: string): Promise<GraphResp> {
  const doReq = async (token: string) =>
    await remoteHttp(GRAPH + graphPath, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined && contentType ? { 'Content-Type': contentType } : {}),
      },
      body: body ?? null,
    });
  let resp = await doReq(await ensureAccessToken());
  if (resp.status === 401) {
    await refreshAccessToken();
    resp = await doReq(await ensureAccessToken());
  }
  if (resp.status >= 400) {
    let json: Record<string, unknown> | null = null;
    try {
      json = decodeJson(resp.bytes, 'Graph 请求');
    } catch {
      /* 响应体不是 JSON(如网关错误页) */
    }
    throw graphError(json, 'Graph 请求', resp.status);
  }
  const json = decodeJson(resp.bytes, 'Graph 请求');
  return { status: resp.status, json, bytes: resp.bytes };
}

// Graph 请求(二进制响应,如文件下载)
async function odGraphBytes(method: string, graphPath: string): Promise<ArrayBuffer> {
  const doReq = async (token: string) =>
    await remoteHttp(GRAPH + graphPath, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  let resp = await doReq(await ensureAccessToken());
  if (resp.status === 401) {
    await refreshAccessToken();
    resp = await doReq(await ensureAccessToken());
  }
  if (resp.status >= 400) {
    let json: Record<string, unknown> | null = null;
    try {
      json = decodeJson(resp.bytes, 'Graph 请求');
    } catch {
      /* ignore */
    }
    throw graphError(json, 'Graph 请求', resp.status);
  }
  return resp.bytes;
}

// ==== 路径与条目 ====

// 云端绝对路径 → Graph 路径段:根返回 "/root",其他 "/root:/path"
function graphItemPath(cloud: string): string {
  const p = cloud.replace(/\/+$/, '');
  if (!p || p === '/') return '/root';
  return '/root:' + encodeGraphPath(p);
}

// Graph 的 path: 段里 "/" 合法但 ":" 等保留字符需编码;只编码冒号/百分号,保留 "/"
function encodeGraphPath(p: string): string {
  return p.replace(/%/g, '%25').replace(/:/g, '%3A');
}

// 云端路径 → driveItem id(缓存:列目录与按路径查询都回填)
const idCache = new Map<string, string>();

// 列目录缓存(cloudDir → entries),TTL 与百度一致
const listCache = new Map<string, { ts: number; entries: MountNode[] }>();
const LIST_TTL = 30 * 1000;

function cloudDirOf(vPath: string): string {
  return oneDrivePathBody(vPath) || '/';
}

export function clearOneDriveListCache(dir?: string): void {
  if (dir) {
    const cloud = cloudDirOf(dir);
    for (const k of Array.from(listCache.keys())) {
      if (k === cloud || k.startsWith(cloud === '/' ? '/' : cloud + '/')) listCache.delete(k);
    }
    // 子树内的 id 缓存一并失效(删除/改名后可能陈旧)
    for (const k of Array.from(idCache.keys())) {
      if (k === cloud || k.startsWith(cloud === '/' ? '/' : cloud + '/')) idCache.delete(k);
    }
  } else {
    listCache.clear();
    idCache.clear();
  }
}

/** 列目录(onedrive:// 虚拟路径;分页拉全,条目 abs 为子虚拟路径)。 */
export async function odListDir(vPath: string): Promise<MountNode[]> {
  if (!vPath.startsWith(OD_PREFIX)) throw new Error(`不是 OneDrive 路径: ${vPath}`);
  const cloud = cloudDirOf(vPath);
  const cached = listCache.get(cloud);
  if (cached && Date.now() - cached.ts < LIST_TTL) return cached.entries;

  const vBase = OD_PREFIX + (cloud === '/' ? '' : cloud);
  const entries: MountNode[] = [];
  let next: string | null = graphItemPath(cloud) + '/children?$top=200';
  let guard = 0;
  while (next && guard++ < 50) {
    const page = await odGraph('GET', next.startsWith(GRAPH) ? next.slice(GRAPH.length) : next);
    const json = (page.json ?? {}) as { value?: Array<Record<string, unknown>>; '@odata.nextLink'?: string };
    for (const it of json.value || []) {
      const name = String(it.name || '');
      if (!name) continue;
      const isDir = !!it.folder;
      const childCloud = (cloud === '/' ? '' : cloud) + '/' + name;
      if (it.id) idCache.set(childCloud, String(it.id));
      entries.push({
        name,
        rel: name,
        abs: vBase + '/' + name,
        isDir,
        size: Number(it.size) || 0,
        children: [],
      });
    }
    next = json['@odata.nextLink'] || null;
  }
  if (listCache.size > 300) listCache.clear();
  listCache.set(cloud, { ts: Date.now(), entries });
  return entries;
}

// ==== 配额(验证凭据用)====

export async function odQuota(): Promise<{ quota: number; used: number }> {
  const { json } = await odGraph('GET', '/me/drive?$select=quota');
  const q = ((json?.quota ?? {}) as Record<string, unknown>) || {};
  return { quota: Number(q.total) || 0, used: Number(q.used) || 0 };
}

// ==== 下载 ====

export async function odDownloadFile(vPath: string): Promise<Uint8Array> {
  const cloud = cloudDirOf(vPath);
  if (!cloud || cloud === '/') throw new Error('OneDrive 根目录不是文件');
  return new Uint8Array(await odGraphBytes('GET', graphItemPath(cloud) + ':/content'));
}

// ==== 上传(简单 PUT;Graph 单请求上限 250MB)====

export async function odUploadFile(vPath: string, data: Uint8Array): Promise<void> {
  const cloud = cloudDirOf(vPath);
  if (!cloud || cloud === '/') throw new Error('OneDrive 根目录不可作为文件写入');
  if (data.length > 250 * 1024 * 1024) {
    throw new Error('OneDrive 简单上传上限 250MB,更大的文件请使用官方客户端或上传会话接口');
  }
  await odGraph('PUT', graphItemPath(cloud) + ':/content', data, 'application/octet-stream');
  clearOneDriveListCache(oneDrivePathBody(vPath).split('/').slice(0, -1).join('/') || '/');
}

// ==== 新建目录 ====

export async function odCreateDir(vPath: string): Promise<void> {
  const cloud = cloudDirOf(vPath);
  if (!cloud || cloud === '/') throw new Error('OneDrive 根目录无需创建');
  const slash = cloud.lastIndexOf('/');
  const parent = slash > 0 ? cloud.slice(0, slash) : '/';
  const name = slash > 0 ? cloud.slice(slash + 1) : cloud;
  await odGraph('POST', graphItemPath(parent) + '/children', JSON.stringify({ name, folder: {} }), 'application/json');
  clearOneDriveListCache(parent);
}

// ==== 删除 / 改名(经 driveItem id)====

async function resolveItemId(cloud: string): Promise<string> {
  const hit = idCache.get(cloud);
  if (hit) return hit;
  const { json } = await odGraph('GET', graphItemPath(cloud) + '?$select=id');
  const id = String(json?.id || '');
  if (!id) throw new Error('无法解析 OneDrive 条目 ID');
  idCache.set(cloud, id);
  return id;
}

export async function odRemove(vPath: string): Promise<void> {
  const cloud = cloudDirOf(vPath);
  if (!cloud || cloud === '/') throw new Error('OneDrive 根目录不可删除');
  const id = await resolveItemId(cloud);
  await odGraph('DELETE', `/me/drive/items/${id}`);
  const parent = cloud.split('/').slice(0, -1).join('/') || '/';
  clearOneDriveListCache(parent);
}

export async function odRename(vPath: string, newVPath: string): Promise<void> {
  const cloud = cloudDirOf(vPath);
  const newCloud = oneDrivePathBody(newVPath);
  if (!cloud || cloud === '/') throw new Error('OneDrive 根目录不可改名');
  // 仅支持同目录改名(Graph 跨目录是 move = PATCH parentReference;与百度一致先不做)
  const slash = cloud.lastIndexOf('/');
  const parent = slash > 0 ? cloud.slice(0, slash) : '/';
  const newSlash = newCloud.lastIndexOf('/');
  const newParent = newSlash > 0 ? newCloud.slice(0, newSlash) : '/';
  if (newParent !== parent) {
    throw new Error('OneDrive 暂不支持跨目录改名/移动,请使用官方客户端');
  }
  const id = await resolveItemId(cloud);
  await odGraph('PATCH', `/me/drive/items/${id}`, JSON.stringify({ name: newCloud.slice(newSlash + 1) }), 'application/json');
  clearOneDriveListCache(parent);
}
