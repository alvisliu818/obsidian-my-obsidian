/**
 * 虚拟文档树「最近打开」区的纯逻辑。
 *
 * 与 panels/recentPanel.ts（独立的「最近使用」面板）的分工：那个面板只列
 * 库内文件；本模块服务的区段长在挂载面板里，记录的是**所有**被打开过的
 * 文件——库内的（TFile）和库外挂载里的（绝对路径）——并支持按扩展名筛选。
 *
 * 这里只放不碰 DOM、不 import obsidian 的纯函数，便于单测（仓库规则：
 * 任何 under test 的代码都不能需要浏览器）。
 */

import type { RecentOpenEntry } from '../types';

export type { RecentOpenEntry };

/** 列表上限：够长又不把 data.json 撑爆。 */
export const RECENT_OPEN_LIMIT = 100;

/** 「全部」筛选值的哨兵；扩展名筛选用扩展名字符串（'' = 无扩展名）。 */
export const RECENT_FILTER_ALL = '*';

/** 从 basename 取小写扩展名，无扩展名返回 ''（Dockerfile / LICENSE 这类）。 */
export function extOfPath(path: string): string {
  const base = path.split(/[\\/]+/).pop() ?? path;
  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  return m ? m[1].toLowerCase() : '';
}

/** 路径的最后一段（文件名或文件夹名）。 */
export function baseNameOf(path: string): string {
  return path.split(/[\\/]+/).pop() ?? path;
}

/**
 * 把一条记录放到列表最前：同 (kind, path) 先去重再插入，超出上限丢尾巴。
 * 返回新数组（调用方直接赋给 settings），输入不变。
 */
export function pushRecentOpen(
  list: RecentOpenEntry[],
  path: string,
  kind: RecentOpenEntry['kind'],
  at: number,
): RecentOpenEntry[] {
  const head = list[0];
  // 重复打开同一个文件：只更新时间，不打乱顺序、不产生新数组——
  // file-open 在切标签页时会密集触发，避免无谓的 saveSettings。
  if (head && head.path === path && head.kind === kind) {
    head.at = at;
    return list;
  }
  const next: RecentOpenEntry[] = [{ path, kind, at }];
  for (const e of list) {
    if (e.path === path && e.kind === kind) continue;
    if (next.length >= RECENT_OPEN_LIMIT) break;
    next.push(e);
  }
  return next;
}

/**
 * 按扩展名筛选；`RECENT_FILTER_ALL` 原样返回。筛选值大小写不敏感
 * （chip 上显示小写，磁盘上的 .MD 也该命中）。
 */
export function filterRecentOpen(list: RecentOpenEntry[], ext: string): RecentOpenEntry[] {
  if (ext === RECENT_FILTER_ALL) return list;
  const want = ext.toLowerCase();
  return list.filter((e) => extOfPath(e.path) === want);
}

/**
 * 列表里出现过的扩展名及计数，按次数降序、同次数按名字升序——
 * chip 的顺序稳定，最常用的类型排最前，用户不用在一堆 chip 里找。
 */
export function recentExtChips(list: RecentOpenEntry[]): Array<{ ext: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of list) {
    const ext = extOfPath(e.path);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.ext.localeCompare(b.ext)));
}

/** chip 的显示名：无扩展名也要有个说法。 */
export function extChipLabel(ext: string): string {
  return ext === '' ? '无扩展名' : ext;
}

/**
 * data.json 是用户可编辑的，列表可能被手改坏——只放行形状正确的条目，
 * 并截到上限。缺字段 = 空列表，与 settings 其它字段的消毒风格一致。
 */
export function recentOpenFrom(raw: unknown): RecentOpenEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentOpenEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<RecentOpenEntry>;
    if (typeof e.path !== 'string' || !e.path.trim()) continue;
    if (e.kind !== 'vault' && e.kind !== 'ext') continue;
    const at = Number(e.at);
    out.push({
      path: e.path,
      kind: e.kind,
      at: Number.isFinite(at) && at > 0 ? at : 0,
    });
    if (out.length >= RECENT_OPEN_LIMIT) break;
  }
  return out;
}

/** 大小写不敏感、分隔符统一的路径规范化，供前后缀比较用。 */
function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/**
 * 一个绝对路径属于哪个挂载：返回挂载本身与挂载内相对路径（'/'-分隔），
 * 不在任何挂载内返回 null。用于把一条 ext 记录还原成能喂给
 * `openExternalEntry` 的 (mount, node)。
 */
export function resolveMountForAbs<T extends { path: string }>(
  mounts: T[],
  abs: string,
): { mount: T; rel: string } | null {
  const target = normPath(abs);
  for (const m of mounts) {
    const root = normPath(m.path);
    if (target === root) return { mount: m, rel: '' };
    // root 已规范化（小写、去尾分隔符），与 absSlash 逐字符对齐，可直接按长度切。
    if (target.startsWith(root + '/')) {
      const absSlash = abs.replace(/\\/g, '/');
      return { mount: m, rel: absSlash.slice(root.length).replace(/^\/+/, '') };
    }
  }
  return null;
}
