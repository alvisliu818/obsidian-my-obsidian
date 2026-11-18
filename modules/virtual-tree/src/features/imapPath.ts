/**
 * IMAP 邮箱虚拟路径语法（思源 imap-path.ts 对齐）。
 *
 * 路径形态：
 *   imap://<provider>                          根（邮箱夹列表）
 *   imap://<provider>/<encMailbox>             邮箱夹（邮件列表）
 *   imap://<provider>/<encMailbox>/<mail>.md   邮件（只读 Markdown）
 *   imap://<provider>/<encMailbox>/<mail>.md.files/<att>   附件
 * 所有段 encodeURIComponent；provider ∈ qq | 163 | 126。
 */

export const IMAP_PREFIX = 'imap://';

export interface ImapPathParts {
  provider: string;
  segs: string[];
}

export function isImapPath(p: string): boolean {
  return String(p || '').startsWith(IMAP_PREFIX);
}

export function imapPathParts(p: string): ImapPathParts {
  const body = String(p || '').slice(IMAP_PREFIX.length).replace(/^\/+/, '');
  const segs = body.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { provider: segs[0] ?? '', segs };
}

export const IMAP_PROVIDERS: { key: string; label: string; host: string; port: number }[] = [
  { key: 'qq', label: 'QQ 邮箱', host: 'imap.qq.com', port: 993 },
  { key: '163', label: '网易 163', host: 'imap.163.com', port: 993 },
  { key: '126', label: '网易 126', host: 'imap.126.com', port: 993 },
];

export function imapProviderOf(provider: string): { key: string; label: string; host: string; port: number } {
  return IMAP_PROVIDERS.find((p) => p.key === provider) ?? IMAP_PROVIDERS[0];
}

/** 邮箱家族的挂载根显示名。 */
export function imapRootLabel(vPath: string): string {
  const { provider } = imapPathParts(vPath);
  const info = imapProviderOf(provider);
  return '[IMAP] ' + (provider === info.key ? info.label : provider);
}

/** 邮箱家族短名（选择器/面板用）。 */
export function imapShortName(vPath: string): string {
  const { provider, segs } = imapPathParts(vPath);
  const info = imapProviderOf(provider);
  if (segs.length >= 2) return segs[segs.length - 1];
  return '[IMAP] ' + info.label;
}
