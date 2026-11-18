/**
 * IMAP 邮箱接入后端（思源 imap-mail.ts 对齐，Obsidian 路径形态适配）：
 * QQ 邮箱 / 网易 163 / 126，桌面端专用，只读。
 *
 *  - 凭据：邮箱地址 + IMAP 授权码（QQ 设置→账户→开启 IMAP/SMTP；163 客户端授权密码）
 *  - 连接：lazy connect + 会话内复用；QQ/163 要求客户端发送 ID 命令（imapflow
 *    构造项 clientInfo 自动处理，否则报 Unsafe Login）
 *  - 邮箱夹：client.list()（INBOX、Sent Messages、草稿箱…含中文自建夹）
 *  - 邮件：邮箱夹内按 UID 倒序取最新 200 封 envelope；正文取 text/plain，
 *    缺失取 text/html 剥标签；附件按 bodyStructure disposition=attachment
 *  - 只读源：邮件不提供编辑语义，写操作一律拒绝
 * 虚拟路径：imap://<provider>/…（features/imapPath.ts）。
 */

import type { App } from 'obsidian';
import type { MountNode } from './mountFilter';
import { imapPathParts, imapProviderOf, isImapPath } from './imapPath';

export interface ImapMailConfig {
  provider: string;
  user: string;
  pass: string;
  host?: string;
  port?: number;
}

export const IMAP_MAILBOX_LIST_RECENT = 200;
const IMAP_LIST_TTL = 60 * 1000;

interface ImapState {
  config: ImapMailConfig;
  client: any;
  connectPromise: Promise<any> | null;
  connKey: string;
  listCache: Map<string, { ts: number; items: ImapMailListItem[] }>;
}

let imapState: ImapState | null = null;

function imapStateOf(): ImapState {
  if (!imapState) {
    imapState = {
      config: { provider: 'qq', user: '', pass: '' },
      client: null,
      connectPromise: null,
      connKey: '',
      listCache: new Map(),
    };
  }
  return imapState;
}

export function imapConfig(): ImapMailConfig {
  return imapStateOf().config;
}

export function initImapMailConfig(cfg: Partial<ImapMailConfig>): void {
  Object.assign(imapStateOf().config, cfg);
}

export function isImapConfigured(): boolean {
  const cfg = imapConfig();
  return !!(cfg.user && cfg.pass && cfg.provider);
}

function connKeyOf(cfg: ImapMailConfig): string {
  const info = imapProviderOf(cfg.provider);
  return `${cfg.user}@${cfg.host || info.host}:${cfg.port || info.port}`;
}

function closeImapClient(): void {
  const st = imapStateOf();
  const c = st.client;
  st.client = null;
  st.connectPromise = null;
  st.connKey = '';
  if (c) {
    try {
      c.close();
    } catch {
      /* 已断 */
    }
  }
}

/** 配置变更：断开旧连接，下次操作重连。 */
export function resetImapConnection(): void {
  closeImapClient();
}

async function loadImapFlow(): Promise<any> {
  try {
    return await import('imapflow');
  } catch (e) {
    throw new Error('imapflow 模块加载失败：' + String((e as Error)?.message ?? e));
  }
}

async function getImapClient(): Promise<any> {
  if (!isImapConfigured()) {
    throw new Error('IMAP 邮箱未配置，请先填写邮箱地址与授权码');
  }
  const st = imapStateOf();
  const key = connKeyOf(st.config);
  if (st.client && st.connKey === key) return st.client;
  if (st.connectPromise) return st.connectPromise;
  const connectPromise = (async () => {
    const mod = await loadImapFlow();
    const ImapFlow = mod?.ImapFlow || mod?.default;
    if (typeof ImapFlow !== 'function') throw new Error('imapflow 模块加载失败（构造器缺失）');
    const cfg = imapConfig();
    const info = imapProviderOf(cfg.provider);
    const client = new ImapFlow({
      host: cfg.host || info.host,
      port: cfg.port || info.port,
      secure: (cfg.port || info.port) === 993,
      auth: { user: cfg.user, pass: cfg.pass },
      clientInfo: { name: 'Obsidian Virtual Tree', version: '1.0', vendor: 'obsidian-my-obsidian' },
      logger: false,
      emitLogs: false,
    });
    client.on('error', () => {
      // 连接级错误（断网/超时）：置空让下次操作重连
      if (imapStateOf().client === client) {
        imapStateOf().client = null;
        imapStateOf().connKey = '';
      }
    });
    await client.connect();
    imapStateOf().client = client;
    imapStateOf().connKey = key;
    return client;
  })().catch((e: any) => {
    imapStateOf().connectPromise = null;
    const msg = String(e?.message || e);
    if (/auth|login|credentials/i.test(msg)) {
      throw new Error(`IMAP 登录失败（检查邮箱地址与授权码）：${msg}`);
    }
    throw new Error(`IMAP 连接失败：${msg}`);
  });
  st.connectPromise = connectPromise;
  return connectPromise;
}

/** 在邮箱夹锁内执行操作（imapflow 要求 select/getMailboxLock）。 */
async function withMailbox<T>(mailbox: string, fn: (client: any) => Promise<T>): Promise<T> {
  const client = await getImapClient();
  const lock = await client.getMailboxLock(mailbox);
  try {
    return await fn(client);
  } finally {
    lock.release();
  }
}

export interface ImapMailListItem {
  uid: number;
  fileName: string;
  from: string;
  subject: string;
  received: string;
  hasAttachments: boolean;
}

function sanitizeFileName(s: string, max = 60): string {
  return s.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() || '(无主题)';
}

function imapMailFileName(from: string, subject: string, date: Date | string | undefined): string {
  const d = date ? new Date(date) : new Date(NaN);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = isFinite(d.getTime())
    ? `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
    : '00000000-0000';
  return `${stamp}-${sanitizeFileName(from, 24)}-${sanitizeFileName(subject, 48)}.md`;
}

function hasAttachmentWalk(node: any): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some((c: any) => hasAttachmentWalk(c));
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function streamToBuffer(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (c: any) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

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

/** 列邮箱夹下的邮件（最新 200 封，时间倒序；60s 缓存）。 */
export async function imapListMessages(vPath: string): Promise<ImapMailListItem[]> {
  const { provider, segs } = imapPathParts(vPath);
  const mailbox = decodeSeg(segs[0] || 'INBOX');
  const cacheKey = provider + '/' + mailbox;
  const cached = imapStateOf().listCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < IMAP_LIST_TTL) return cached.items;
  const items = await withMailbox(mailbox, async (client) => {
    const count = Number(client.mailbox?.exists) || 0;
    if (count === 0) return [];
    const seqFrom = Math.max(1, count - IMAP_MAILBOX_LIST_RECENT + 1);
    const out: ImapMailListItem[] = [];
    for await (const msg of client.fetch(`${seqFrom}:*`, { uid: true, envelope: true, bodyStructure: true })) {
      const env = msg.envelope || {};
      const from = String(env.from?.[0]?.name || env.from?.[0]?.address || '(未知发件人)');
      const subject = String(env.subject || '(无主题)');
      const date = env.date || new Date();
      let fn = imapMailFileName(from, subject, date);
      if (out.some((x) => x.fileName === fn)) fn = fn.replace(/(\.md)?$/, '-r.md');
      out.push({
        uid: Number(msg.uid) || 0,
        fileName: fn,
        from,
        subject,
        received: new Date(date).toISOString(),
        hasAttachments: hasAttachmentWalk(msg.bodyStructure),
      });
    }
    out.reverse();
    return out;
  });
  const stL = imapStateOf();
  if (stL.listCache.size > 60) stL.listCache.clear();
  stL.listCache.set(cacheKey, { ts: Date.now(), items });
  return items;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}


/** 邮件正文 → Markdown（元信息头 + 正文；附件清单指向 .files/ 目录）。 */
export async function imapRenderMarkdown(vPath: string): Promise<string> {
  const { provider, segs } = imapPathParts(vPath);
  const mailbox = decodeSeg(segs[0] || 'INBOX');
  const fileName = segs[1] || '';
  const mailboxVPath = `imap://${encodeURIComponent(provider)}/${encodeURIComponent(mailbox)}`;
  const items = await imapListMessages(mailboxVPath);
  const item = items.find((it) => it.fileName === fileName);
  if (!item) throw new Error(`邮件不存在或列表已过期：${fileName}`);
  const info = await withMailbox(mailbox, async (client) => {
    let text = '';
    let toAddr = '';
    const attachments: { part: string; name: string; size: number }[] = [];
    for await (const msg of client.fetch(String(item.uid), { uid: true, bodyStructure: true, envelope: true })) {
      const env = msg.envelope || {};
      toAddr = ((env.to || []) as any[]).map((a) => a.address || '').filter(Boolean).join(', ');
      const findPart = (node: any, id: string, want: 'plain' | 'html'): string | null => {
        if (!node) return null;
        if (node.type === 'text' && (want === 'plain' ? node.subtype !== 'html' : node.subtype === 'html')) return id;
        for (let i = 0; i < (node.childNodes || []).length; i++) {
          const hit = findPart(node.childNodes[i], id ? `${id}.${i + 1}` : String(i + 1), want);
          if (hit) return hit;
        }
        return null;
      };
      const isMultipart = !!(msg.bodyStructure?.childNodes?.length);
      const plainPart = findPart(msg.bodyStructure, isMultipart ? '' : '1', 'plain');
      if (plainPart) {
        const dl = await client.download(String(item.uid), plainPart, { uid: true });
        if (dl?.content) text = (await streamToBuffer(dl.content)).toString('utf8');
      } else {
        const htmlPart = findPart(msg.bodyStructure, isMultipart ? '' : '1', 'html');
        if (htmlPart) {
          const dl = await client.download(String(item.uid), htmlPart, { uid: true });
          if (dl?.content) text = htmlToText((await streamToBuffer(dl.content)).toString('utf8'));
        }
      }
      const walkAtts = (node: any, id: string): void => {
        if (!node) return;
        if (node.disposition === 'attachment') {
          attachments.push({
            part: id,
            name: String(node.dispositionParams?.filename || node.name || `attachment-${id}`),
            size: Number(node.size) || 0,
          });
        }
        (node.childNodes || []).forEach((c: any, i: number) => walkAtts(c, id ? `${id}.${i + 1}` : String(i + 1)));
      };
      walkAtts(msg.bodyStructure, '');
      void env;
    }
    return { text, attachments, toAddr };
  });
  const received = item.received ? new Date(item.received).toLocaleString() : '';
  const lines = [
    `# ${item.subject}`,
    '',
    `- 发件人：${item.from}`,
    info.toAddr ? `- 收件人：${info.toAddr}` : '',
    `- 时间：${received}`,
    info.attachments.length
      ? `- 附件：${info.attachments.map((a) => `${a.name}(${formatSize(a.size)})`).join('、')}（同目录 .files/ 下可查看）`
      : '',
    '',
    '---',
    '',
    info.text || '(无正文)',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

export interface ImapAttachment {
  part: string;
  name: string;
  size: number;
}

export async function imapDownloadAttachment(vPath: string): Promise<ArrayBuffer> {
  const { provider, segs } = imapPathParts(vPath);
  const mailbox = decodeSeg(segs[0] || 'INBOX');
  const fileName = segs[1] || '';
  const attName = decodeSeg(segs[2] || '');
  const mailboxVPath = `imap://${encodeURIComponent(provider)}/${encodeURIComponent(mailbox)}`;
  const items = await imapListMessages(mailboxVPath);
  const item = items.find((it) => it.fileName === fileName);
  if (!item) throw new Error(`邮件不存在或列表已过期：${fileName}`);
  return await withMailbox(mailbox, async (client) => {
    let attPart = '';
    for await (const msg of client.fetch(String(item.uid), { uid: true, bodyStructure: true })) {
      const walkAtts = (node: any, id: string): void => {
        if (!node) return;
        if (node.disposition === 'attachment') {
          const nm = String(node.dispositionParams?.filename || node.name || `attachment-${id}`);
          if (!attPart && (nm === attName || nm.toLowerCase() === attName.toLowerCase())) attPart = id;
        }
        (node.childNodes || []).forEach((c: any, i: number) => walkAtts(c, id ? `${id}.${i + 1}` : String(i + 1)));
      };
      walkAtts(msg.bodyStructure, '');
    }
    if (!attPart) throw new Error(`附件不存在：${attName}`);
    const dl = await client.download(String(item.uid), attPart, { uid: true });
    if (!dl?.content) throw new Error(`附件下载失败：${attName}`);
    const buf = await streamToBuffer(dl.content);
    const ab = new ArrayBuffer(buf.length);
    new Uint8Array(ab).set(buf);
    return ab;
  });
}

/** IMAP 路径 → MountNode[]：根=邮箱夹；邮箱夹=邮件 .md 列表。 */
export async function imapListDir(vPath: string, app: App): Promise<MountNode[]> {
  if (!isImapPath(vPath)) throw new Error(`不是 IMAP 邮箱路径：${vPath}`);
  const { provider, segs } = imapPathParts(vPath);
  void app;
  const mkNode = (name: string, rel: string, isDir: boolean): MountNode => {
    const base = `imap://${encodeURIComponent(provider)}`;
    const n: MountNode = { name, rel, abs: rel ? `${base}/${rel}` : base, isDir, children: [] };
    return n;
  };
  // 根：邮箱夹列表（Noselect 层级占位跳过）
  if (segs.length === 0) {
    const client = await getImapClient();
    const list = await client.list();
    const nodes: MountNode[] = [];
    for (const box of list) {
      if (box.flags?.has?.('\\Noselect')) continue;
      const mbPath = String(box.path || box.name || '');
      nodes.push(mkNode(String(box.name || box.path), encodeURIComponent(mbPath), true));
    }
    return nodes;
  }
  // 邮箱夹：邮件 .md 列表（最新 200 封倒序）
  const mailbox = decodeSeg(segs[0]);
  const mailboxVPath = `imap://${encodeURIComponent(provider)}/${encodeURIComponent(mailbox)}`;
  const items = await imapListMessages(mailboxVPath);
  return items.map((it) => {
    const rel = encodeURIComponent(mailbox) + '/' + it.fileName;
    const n: MountNode = { name: it.fileName, rel, abs: `imap://${encodeURIComponent(provider)}/${rel}`, isDir: false, children: [] };
    if (it.hasAttachments) {
      (n as any).hasFiles = true;
    }
    return n;
  });
}

/** 远端 IO 面：邮件正文 Markdown → 字节（remoteIO.readTextAny 分发用）。 */
export async function imapDownloadFile(vPath: string): Promise<Uint8Array> {
  const md = await imapRenderMarkdown(vPath);
  return new TextEncoder().encode(md);
}
