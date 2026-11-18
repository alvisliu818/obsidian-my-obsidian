/**
 * 文件级收藏(思源 start-page.ts 的 favorites 组对齐,纯函数存储):
 * 面板顶部的「收藏」区 + 树行右键「收藏/取消收藏」。
 *
 * 条目按 挂载 id + 挂载内相对路径 去重;显示名冗余存一份,挂载卸载/条目改名
 * 后仍能显示(打开时按 mountId+rel 重新解析,解析不到的条目打开时提示)。
 * 持久化在插件设置切片(favorites 字段),与 recentOpen 同一套 saveSettings。
 */

/** 收藏条目。rel 为挂载内相对路径('/' 分隔);mountId 是挂载的稳定 id。 */
export interface FavoriteEntry {
  mountId: string;
  rel: string;
  name: string;
  isDir: boolean;
  ts: number;
}

/** 每组保留的上限(思源 MAX_PER_GROUP=50,收藏区容量对齐)。 */
const MAX_FAVORITES = 50;

/** data.json → 条目数组(非法记录丢弃,超限截断,ts 缺失兜底 0)。 */
export function favoritesFrom(raw: unknown): FavoriteEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FavoriteEntry[] = [];
  for (const e of raw) {
    const o = (e ?? {}) as Record<string, unknown>;
    if (typeof o.mountId !== 'string' || !o.mountId) continue;
    if (typeof o.rel !== 'string' || !o.rel) continue;
    if (typeof o.name !== 'string' || !o.name) continue;
    out.push({
      mountId: o.mountId,
      rel: o.rel,
      name: o.name,
      isDir: o.isDir === true,
      ts: typeof o.ts === 'number' ? o.ts : 0,
    });
    if (out.length >= MAX_FAVORITES) break;
  }
  return out;
}

function keyOf(mountId: string, rel: string): string {
  return `${mountId}\u0000${rel}`;
}

export function isFavorited(list: FavoriteEntry[], mountId: string, rel: string): boolean {
  const k = keyOf(mountId, rel);
  return list.some((e) => keyOf(e.mountId, e.rel) === k);
}

/** 切换收藏;返回新数组(不改入参)与切换后是否已收藏。 */
export function toggleFavorite(
  list: FavoriteEntry[],
  entry: { mountId: string; rel: string; name: string; isDir: boolean },
): { list: FavoriteEntry[]; added: boolean } {
  const k = keyOf(entry.mountId, entry.rel);
  const exists = list.some((e) => keyOf(e.mountId, e.rel) === k);
  if (exists) {
    return { list: list.filter((e) => keyOf(e.mountId, e.rel) !== k), added: false };
  }
  // 新的排最前;超上限截掉最旧的
  const next = [{ mountId: entry.mountId, rel: entry.rel, name: entry.name, isDir: entry.isDir, ts: Date.now() }, ...list];
  if (next.length > MAX_FAVORITES) next.length = MAX_FAVORITES;
  return { list: next, added: true };
}

/** 从列表中移除;返回新数组(不改入参)。 */
export function removeFavorite(list: FavoriteEntry[], mountId: string, rel: string): FavoriteEntry[] {
  const k = keyOf(mountId, rel);
  return list.filter((e) => keyOf(e.mountId, e.rel) !== k);
}
