/**
 * 链接挂载家族（思源 link-mount 对齐）：weblink:// 与 bmarks://。
 *
 * 两者都是叶子/单层目录形态的"虚拟挂载"：
 *   weblink://<encodeURIComponent(url)>        叶子——点击经 Browser 模块打开
 *   bmarks://                                  根 = 标签目录 + 未分组书签叶子
 *   bmarks://<encodeURIComponent(tag)>         标签目录
 *   bmarks://<encTag>/<encodeURIComponent(url)> 书签叶子
 *
 * 叶子挂载用 kind:'remote' + 虚拟 path（思源同款：虚拟 kind 不单设类型，路径
 * 即身份）。数据来源：Browser 模块（跨模块防御式访问，iconTheme.ts 同款）。
 */

import type { App } from 'obsidian';
import type { MountNode } from './mountFilter';

export const WEBLINK_PREFIX = 'weblink://';
export const BMARKS_PREFIX = 'bmarks://';

export function makeWeblinkVPath(url: string): string {
  return WEBLINK_PREFIX + encodeURIComponent(url);
}

export function isWeblinkPath(p: string): boolean {
  return String(p || '').startsWith(WEBLINK_PREFIX);
}

export function weblinkUrlOf(p: string): string {
  try {
    return decodeURIComponent(String(p).slice(WEBLINK_PREFIX.length));
  } catch {
    return String(p).slice(WEBLINK_PREFIX.length);
  }
}

export function makeBmarksVPath(tag: string, url?: string): string {
  const seg = encodeURIComponent(tag);
  return url ? `${BMARKS_PREFIX}/${seg}/${encodeURIComponent(url)}` : `${BMARKS_PREFIX}/${seg}`;
}

export function isBmarksPath(p: string): boolean {
  return String(p || '').startsWith(BMARKS_PREFIX);
}

/** 书签叶子 → URL（最后一段 decode）；根/标签目录返回 null */
export function bmarksUrlOf(p: string): string | null {
  const body = String(p || '').slice(BMARKS_PREFIX.length).replace(/^\/+/, '');
  if (!body) return null;
  const segs = body.split('/');
  const last = segs[segs.length - 1];
  if (segs.length < 2) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function bmarksTagOf(p: string): string {
  const body = String(p || '').slice(BMARKS_PREFIX.length).replace(/^\/+/, '');
  const seg = body.split('/')[0] ?? '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// ---------------- Browser 模块跨模块访问（iconTheme.ts 同款防御式） ----------------

interface BrowserBookmarksApi {
  bookmarksAll?: () => { title: string; url: string; tags: string[] }[];
  openExternalInBrowser?: (url: string, newTab?: boolean) => void;
}

/** Browser 模块实例（宿主 moduleInstance 防御式访问；独立装时直接查插件表）。 */
export function browserModuleOf(app: App): BrowserBookmarksApi | null {
  try {
    const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
    const direct = plugins?.plugins?.['obsidian-my-obsidian'];
    const host = direct as { moduleInstance?: (id: string) => unknown } | undefined;
    const mod = host?.moduleInstance?.('browser') as BrowserBookmarksApi | undefined;
    if (mod && typeof mod.bookmarksAll === 'function') return mod;
    const standalone = plugins?.plugins?.['obsidian-browser'] as BrowserBookmarksApi | undefined;
    if (standalone && typeof standalone.bookmarksAll === 'function') return standalone;
    return null;
  } catch {
    return null;
  }
}

/** 打开网页：Browser 模块内打开（不可达时兜底 window.open）。 */
export function openExternalUrl(app: App, url: string): void {
  const mod = browserModuleOf(app);
  if (mod && typeof mod.openExternalInBrowser === 'function') {
    mod.openExternalInBrowser(url, false);
    return;
  }
  try {
    window.open(url, '_blank');
  } catch {
    /* ignore */
  }
}

// ---------------- bmarks 目录树（MountNode 形态，供 loadLayerRemote） ----------------

function mkNode(name: string, abs: string, isDir: boolean): MountNode {
  return { name, rel: name, abs, isDir, children: [] };
}

export function bmarksListDir(vPath: string, app: App): MountNode[] {
  const mod = browserModuleOf(app);
  const marks = mod?.bookmarksAll?.() ?? [];
  const isRoot = String(vPath).replace(/\/+$/, '') === BMARKS_PREFIX;
  const tag = bmarksTagOf(vPath);
  if (isRoot) {
    // 根：标签目录（多标签书签出现在多个分组）+ 未分组叶子
    const tags = new Map<string, { title: string; url: string }[]>();
    const untagged: { title: string; url: string }[] = [];
    for (const b of marks) {
      const ts = (b.tags ?? []).filter(Boolean);
      if (!ts.length) untagged.push(b);
      for (const t of ts) {
        if (!tags.has(t)) tags.set(t, []);
        tags.get(t)!.push(b);
      }
    }
    const nodes: MountNode[] = [];
    for (const [t] of tags) nodes.push(mkNode(t, `${BMARKS_PREFIX}/${encodeURIComponent(t)}`, true));
    for (const b of untagged) nodes.push(mkNode((b.title || b.url) + '.url', makeBmarksVPath('', b.url), false));
    return nodes;
  }
  // 标签目录：该标签下的书签叶子
  const items = marks.filter((b) => (b.tags ?? []).includes(tag));
  return items.map((b) => mkNode((b.title || b.url) + '.url', makeBmarksVPath(tag, b.url), false));
}

/** 书签/链接叶子的"内容"（leaf text，思源同款 = URL + 换行） */
export function weblinkText(url: string): string {
  return url + '\n';
}
