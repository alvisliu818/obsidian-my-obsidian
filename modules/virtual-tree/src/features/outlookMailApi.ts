/**
 * Outlook 邮箱接入(思源 outlook-mail.ts 对齐):微软 Graph Mail + 设备码授权。
 *
 * 与 OneDrive 的关系:同一个 Azure 应用(client_id 可复用 OneDrive 配置),但
 * Mail.ReadWrite 权限对应独立的令牌——配置独立存(settings.outlookMail),授权
 * 流程独立实现(设备码,scope 含 Mail.ReadWrite)。
 *
 * 邮箱挂载是只读源:
 *   outlook:///              顶层邮件文件夹(Inbox、Sent Items、Drafts…)
 *   outlook:///<folder>      该文件夹的邮件列表(文件 = YYYYMMDD-HHMM-发件人-主题.md)
 *   邮件文件                 正文转 Markdown(HTML 剥离)+ 元信息头 + 附件清单
 *   <邮件>.files/<附件名>    附件内容(Graph attachments/$value,懒下载)
 * 写操作一律拒绝——邮件不提供编辑语义。
 */

import { decodeRemoteText, remoteHttp } from './remoteHttp';
import { OUTLOOK_PREFIX, outlookPathBody } from './outlookMailPath';
import type { OneDriveSettings } from '../types';
import type { MountNode } from './mountFilter';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
/** 邮件 scope:Mail.ReadWrite(读文件夹与邮件)+ offline_access(刷新令牌) */
export const MAIL_SCOPE = 'offline_access Mail.ReadWrite User.Read';

// ==== 配置注入(复用 OneDriveSettings 形状;独立存储在 settings.outlookMail) ====

interface OutlookMailStoreHooks {
  get: () => OneDriveSettings;
  save: (next: OneDriveSettings) => Promise<void>;
}

let mailHooks: OutlookMailStoreHooks = {
  get: () => ({ clientId: '', authority: 'common', accessToken: '', refreshToken: '', tokenExpiresAt: 0, account: '' }),
  save: async () => undefined,
};

let mailConfig: OneDriveSettings = {
  clientId: '',
  authority: 'common',
  accessToken: '',
  refreshToken: '',
  tokenExpiresAt: 0,
  account: '',
};

export function initOutlookMailApi(hooks: OutlookMailStoreHooks): void {
  mailHooks = hooks;
}

export function initOutlookMailConfigFromSettings(): void {
  mailConfig = { ...mailHooks.get() };
}

export async function saveOutlookMailConfig(next: Partial<OneDriveSettings>): Promise<void> {
  mailConfig = {
    ...mailConfig,
    ...next,
    clientId: (next.clientId ?? mailConfig.clientId).trim(),
    authority: (next.authority ?? mailConfig.authority).trim() || 'common',
  };
  await mailHooks.save({ ...mailConfig });
}

export function getOutlookMailConfig(): OneDriveSettings {
  return { ...mailConfig };
}

export function isOutlookMailConfigured(): boolean {
  return !!(
    mailConfig.clientId &&
    (mailConfig.refreshToken || (mailConfig.accessToken && mailConfig.tokenExpiresAt > Date.now()))
  );
}

// ==== 设备码授权(独立于 onedriveApi:scope 与令牌存储不同)====

export interface MailDeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
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

export async function mailStartDeviceAuth(clientId: string, tenant: string): Promise<MailDeviceAuth> {
  const resp = await remoteHttp(`https://login.microsoftonline.com/${tenant || 'common'}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({ client_id: clientId, scope: MAIL_SCOPE }),
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
  };
}

// 轮询授权结果:pending/slow/done;致命错误抛出。成功时令牌写入邮箱配置。
export async function mailPollDeviceAuth(auth: MailDeviceAuth): Promise<'pending' | 'slow' | 'done'> {
  const resp = await remoteHttp(
    `https://login.microsoftonline.com/${mailConfig.authority || 'common'}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: mailConfig.clientId,
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
  await saveOutlookMailConfig({
    accessToken: String(json.access_token || ''),
    refreshToken: String(json.refresh_token || mailConfig.refreshToken),
    tokenExpiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
  return 'done';
}

async function refreshAccessToken(): Promise<void> {
  if (!mailConfig.refreshToken) throw new Error('Outlook 邮箱未授权或凭据已失效,请重新授权');
  const resp = await remoteHttp(
    `https://login.microsoftonline.com/${mailConfig.authority || 'common'}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        grant_type: 'refresh_token',
        client_id: mailConfig.clientId,
        refresh_token: mailConfig.refreshToken,
        scope: MAIL_SCOPE,
      }),
    },
  );
  const json = decodeJson(resp.bytes, '刷新令牌');
  if (json.error) throw new Error(tokenErrorText(json));
  await saveOutlookMailConfig({
    accessToken: String(json.access_token || ''),
    refreshToken: String(json.refresh_token || mailConfig.refreshToken),
    tokenExpiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
}

async function ensureAccessToken(): Promise<string> {
  if (!mailConfig.accessToken || Date.now() > mailConfig.tokenExpiresAt - 60_000) {
    await refreshAccessToken();
  }
  return mailConfig.accessToken;
}

// ==== Graph Mail 请求 ====

function graphError(json: Record<string, unknown> | null, op: string, status: number): Error {
  const err = (json?.error ?? {}) as Record<string, unknown>;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  if (status === 401) return new Error(`${op}失败:令牌无效或已过期(401),请重新授权`);
  if (status === 404) return new Error(`${op}失败:邮件或文件夹不存在(404)`);
  return new Error(`${op}失败: ${msg || code || 'HTTP ' + status}`);
}

async function mailGraph(graphPath: string): Promise<Record<string, unknown>> {
  const doReq = async (token: string) =>
    await remoteHttp(GRAPH + graphPath, {
      method: 'GET',
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
      json = decodeJson(resp.bytes, 'Graph Mail');
    } catch {
      /* ignore */
    }
    throw graphError(json, 'Graph Mail', resp.status);
  }
  return decodeJson(resp.bytes, 'Graph Mail');
}

async function mailGraphBytes(graphPath: string): Promise<Uint8Array> {
  const doReq = async (token: string) =>
    await remoteHttp(GRAPH + graphPath, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  let resp = await doReq(await ensureAccessToken());
  if (resp.status === 401) {
    await refreshAccessToken();
    resp = await doReq(await ensureAccessToken());
  }
  if (resp.status >= 400) {
    let json: Record<string, unknown> | null = null;
    try {
      json = decodeJson(resp.bytes, 'Graph Mail');
    } catch {
      /* ignore */
    }
    throw graphError(json, 'Graph Mail', resp.status);
  }
  return new Uint8Array(resp.bytes);
}

// ==== 邮件文件夹 ====

export interface MailFolder {
  id: string;
  name: string;
  total: number;
}

// 顶层邮件文件夹(收件箱排前,与 Outlook 侧栏一致)
export async function mailListFolders(): Promise<MailFolder[]> {
  const json = await mailGraph('/me/mailFolders?$top=100');
  const folders = (((json.value as Array<Record<string, unknown>>) || []) as Array<Record<string, unknown>>).map((f) => ({
    id: String(f.id || ''),
    name: String(f.displayName || ''),
    total: Number(f.totalItemCount) || 0,
  }));
  const wellKnown = ['inbox', 'drafts', 'sentitems', 'deleteditems', 'archive'];
  return folders.sort((a, b) => {
    const ia = wellKnown.findIndex((w) => a.name.toLowerCase().includes(w));
    const ib = wellKnown.findIndex((w) => b.name.toLowerCase().includes(w));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

// 内部路径 → 文件夹(顶层按名匹配;大小写不敏感,Outlook 中文名直接匹配)
const folderCache = new Map<string, MailFolder>(); // key = 内部路径段(如 "/Inbox")

async function resolveFolder(segPath: string): Promise<MailFolder> {
  const key = segPath || '/';
  const hit = folderCache.get(key);
  if (hit) return hit;
  const folders = await mailListFolders();
  for (const f of folders) {
    folderCache.set('/' + f.name, f);
  }
  const found = folderCache.get(key);
  if (!found) throw new Error(`邮件文件夹不存在: ${key.slice(1)}`);
  return found;
}

// ==== 邮件列表(文件夹 → 伪文件条目)====

export interface MailListItem {
  messageId: string;
  fileName: string; // 展示/定位用文件名(含 .md)
  from: string;
  subject: string;
  received: string; // ISO
  hasAttachments: boolean;
}

// 文件名清洗:替换文件系统/虚拟路径非法字符,截断长度
function sanitizeFileName(s: string, max = 60): string {
  return (
    s
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .trim() || '(无主题)'
  );
}

function mailFileName(from: string, subject: string, received: string): string {
  const d = new Date(received);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = isFinite(d.getTime())
    ? `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
    : '00000000-0000';
  const who = sanitizeFileName(from, 24);
  const subj = sanitizeFileName(subject, 48);
  return `${stamp}-${who}-${subj}.md`;
}

const mailListCache = new Map<string, { ts: number; items: MailListItem[] }>();
const MAIL_LIST_TTL = 60 * 1000;

// 文件夹路径段(如 "/Inbox") → 邮件条目(最新 200 封,时间倒序)
export async function mailListMessages(folderSeg: string): Promise<MailListItem[]> {
  const cached = mailListCache.get(folderSeg);
  if (cached && Date.now() - cached.ts < MAIL_LIST_TTL) return cached.items;
  const folder = await resolveFolder(folderSeg);
  const json = await mailGraph(
    `/me/mailFolders/${folder.id}/messages?$top=200&$orderby=receivedDateTime desc` +
      `&$select=id,subject,from,receivedDateTime,hasAttachments`,
  );
  const seen = new Set<string>();
  const items: MailListItem[] = [];
  for (const m of ((json.value as Array<Record<string, unknown>>) || []) as Array<Record<string, unknown>>) {
    const fromField = (m.from as Record<string, unknown>) ?? {};
    const email = (fromField.emailAddress as Record<string, unknown>) ?? {};
    const fromAddr = String(email.name || email.address || '(未知发件人)');
    const subject = String(m.subject || '(无主题)');
    let fn = mailFileName(fromAddr, subject, String(m.receivedDateTime || ''));
    while (seen.has(fn)) fn = fn.replace(/(\.md)?$/, '') + '-r.md'; // 同分钟同主题去重
    seen.add(fn);
    items.push({
      messageId: String(m.id || ''),
      fileName: fn,
      from: fromAddr,
      subject,
      received: String(m.receivedDateTime || ''),
      hasAttachments: !!m.hasAttachments,
    });
  }
  if (mailListCache.size > 60) mailListCache.clear();
  mailListCache.set(folderSeg, { ts: Date.now(), items });
  return items;
}

// 文件名 → messageId(从列表缓存反查;列表未含时再拉一次)
async function resolveMail(folderSeg: string, fileName: string): Promise<MailListItem> {
  const items = await mailListMessages(folderSeg);
  const hit = items.find((it) => it.fileName === fileName);
  if (hit) return hit;
  const fresh = await mailListMessages(folderSeg + ' ');
  const hit2 = fresh.find((it) => it.fileName === fileName);
  if (!hit2) throw new Error(`邮件不存在或已从列表过期: ${fileName}`);
  return hit2;
}

// ==== 正文与附件 ====

// HTML → 纯文本(邮件正文用;去掉 script/style,块标签转换行)
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 邮件正文 → Markdown 文本(元信息头 + 正文 + 附件清单)
export async function mailRenderMarkdown(folderSeg: string, fileName: string): Promise<string> {
  const mail = await resolveMail(folderSeg, fileName);
  const json = await mailGraph(
    `/me/messages/${mail.messageId}?$select=subject,from,toRecipients,receivedDateTime,body,hasAttachments`,
  );
  const bodyField = (json.body as Record<string, unknown>) ?? {};
  const bodyHtml = String(bodyField.content || '');
  const text = bodyField.contentType === 'html' ? htmlToText(bodyHtml) : bodyHtml;
  const fromField = ((json.from as Record<string, unknown>) ?? {}).emailAddress as Record<string, unknown> | undefined;
  const from = String(fromField?.address || mail.from);
  const to = ((json.toRecipients as Array<Record<string, unknown>>) || [])
    .map((r) => String((((r ?? {}).emailAddress as Record<string, unknown>) ?? {}).address || ''))
    .filter(Boolean)
    .join(', ');
  const received = json.receivedDateTime ? new Date(String(json.receivedDateTime)).toLocaleString() : mail.received;
  let atts: string[] = [];
  if (json.hasAttachments) {
    try {
      const attJson = await mailGraph(`/me/messages/${mail.messageId}/attachments?$select=name,size`);
      atts = (((attJson.value as Array<Record<string, unknown>>) || []) as Array<Record<string, unknown>>).map(
        (a) => `${a.name}(${formatSize(Number(a.size) || 0)})`,
      );
    } catch {
      atts = [];
    }
  }
  const lines = [
    `# ${json.subject || mail.subject}`,
    '',
    `- 发件人: ${from}`,
    to ? `- 收件人: ${to}` : '',
    `- 时间: ${received}`,
    mail.hasAttachments && atts.length ? `- 附件: ${atts.join('、')}(同目录 .files/ 下可查看)` : '',
    '',
    '---',
    '',
    text,
  ];
  return lines.filter((l) => l !== '').join('\n');
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 邮件的附件清单
export interface MailAttachment {
  id: string;
  name: string;
  size: number;
}

export async function mailListAttachments(folderSeg: string, fileName: string): Promise<MailAttachment[]> {
  const mail = await resolveMail(folderSeg, fileName);
  const json = await mailGraph(`/me/messages/${mail.messageId}/attachments?$select=id,name,size`);
  return (((json.value as Array<Record<string, unknown>>) || []) as Array<Record<string, unknown>>).map((a) => ({
    id: String(a.id || ''),
    name: String(a.name || 'attachment'),
    size: Number(a.size) || 0,
  }));
}

// 下载单个附件内容(懒加载;附件文件在文件树里以 <邮件>.files/<名> 呈现)
export async function mailDownloadAttachment(folderSeg: string, fileName: string, attachmentName: string): Promise<Uint8Array> {
  const mail = await resolveMail(folderSeg, fileName);
  const atts = await mailListAttachments(folderSeg, fileName);
  const att =
    atts.find((a) => a.name === attachmentName) || atts.find((a) => a.name.toLowerCase() === attachmentName.toLowerCase());
  if (!att) throw new Error(`附件不存在: ${attachmentName}`);
  return await mailGraphBytes(`/me/messages/${mail.messageId}/attachments/${att.id}/$value`);
}

// ==== 虚拟树目录装配(readDir 入口)====

/** 列出 outlook:// 虚拟路径下的条目(文件夹列表 / 邮件列表 / 附件目录)。 */
export async function mailListDir(vPath: string): Promise<MountNode[]> {
  if (!vPath.startsWith(OUTLOOK_PREFIX)) throw new Error(`不是 Outlook 邮箱路径: ${vPath}`);
  const seg = outlookPathBody(vPath);
  const toNode = (rel: string, isDir: boolean, size = 0): MountNode => ({
    name: rel.split('/').pop() || rel,
    rel,
    abs: OUTLOOK_PREFIX + seg + '/' + rel,
    isDir,
    size,
    children: [],
  });
  // 根:顶层文件夹
  if (!seg) {
    const folders = await mailListFolders();
    return folders.map((f) => ({ ...toNode(f.name, true, 0) }));
  }
  // ".files/" 结尾的附件目录:列出该邮件的附件
  if (seg.endsWith('.files')) {
    const parentSeg = seg.slice(0, -6); // 去掉 ".files"
    const folderSeg = '/' + parentSeg.split('/')[0];
    const fileName = parentSeg.slice(parentSeg.indexOf('/') + 1);
    const atts = await mailListAttachments(folderSeg, fileName);
    return atts.map((a) => toNode(a.name, false, a.size));
  }
  // 目录段 = 文件夹(内含邮件文件与带附件邮件的 .files 子目录)
  const folderSeg = '/' + seg.split('/')[0];
  const items = await mailListMessages(folderSeg);
  const entries: MountNode[] = [];
  for (const it of items) {
    entries.push({ ...toNode(it.fileName, false, 0) });
    if (it.hasAttachments) {
      entries.push({ ...toNode(it.fileName.replace(/\.md$/, '') + '.files', true, 0) });
    }
  }
  return entries;
}

// ==== 读取(文本或二进制;remoteIO/工作副本统一走字节原语)====

/**
 * 读 outlook:// 路径的字节内容:.md 渲染成 Markdown 文本(UTF-8),附件返回
 * 原始字节。remoteIO 的文本读与 remoteWorkspace 的工作副本下载都走这里。
 */
export async function outlookDownloadFile(vPath: string): Promise<Uint8Array> {
  if (!vPath.startsWith(OUTLOOK_PREFIX)) throw new Error(`不是 Outlook 邮箱路径: ${vPath}`);
  const seg = outlookPathBody(vPath);
  if (!seg) throw new Error('Outlook 根目录不可读');
  // 附件:"/Inbox/<邮件>.files/<附件名>"
  const filesIdx = seg.indexOf('.files/');
  if (filesIdx >= 0) {
    const parentSeg = seg.slice(0, filesIdx + 6); // "/Inbox/<邮件>.files"
    const folderSeg = '/' + parentSeg.slice(1).split('/')[0];
    const mailName = parentSeg.slice(parentSeg.indexOf('/') + 1).replace(/\.files$/, '');
    const attName = seg.slice(filesIdx + 7);
    return await mailDownloadAttachment(folderSeg, mailName, attName);
  }
  // 邮件 .md:"/Inbox/<邮件>.md"
  const folderSeg = '/' + seg.split('/')[0];
  const fileName = seg.slice(seg.indexOf('/') + 1);
  const md = await mailRenderMarkdown(folderSeg, fileName);
  return new TextEncoder().encode(md);
}
