/**
 * 滚动位置持久化的纯逻辑（批次 22）。
 *
 * 思源 scroll/saveScroll.ts 的对应：思源按 rootID 存 localStorage
 * （LOCAL_FILEPOSITION：首尾可见块锚 + scrollTop + 光标焦点 + 缩放），
 * 打开文档时从锚点块拉取渲染。我们走 Obsidian leaf state（workspace.json
 * 序列化，切 tab / 重开 tab / 重启 app 自动生效），渐进窗口恢复用既有
 * scrollCap 机制——恢复 = 把 cap 拉到锚块所在窗口，等渲染高度就绪再设 scrollTop。
 */

export interface PersistedScroll {
  /** 离开时滚动容器的 scrollTop。 */
  top: number;
  /** 离开时首个可见块在可见扁平序列中的索引（渐进窗口恢复锚）。 */
  idx: number;
}

/** 恢复时高度就绪判定的容差（末块半高也认，防"差一行"死等）。 */
export const SCROLL_READY_TOLERANCE = 40;

/** 高度就绪重试上限（每次 bump 渲染下一窗口；超限=目标内容已不存在，放弃）。 */
export const SCROLL_READY_MAX_TRIES = 10;

/** 解析 leaf state 里的 scroll 字段——形状不对/负值/非有限数一律 null。 */
export function planScrollRestore(raw: unknown): PersistedScroll | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { top?: unknown; idx?: unknown };
  if (typeof r.top !== 'number' || !Number.isFinite(r.top) || r.top < 0) return null;
  if (typeof r.idx !== 'number' || !Number.isFinite(r.idx) || r.idx < 0) return null;
  return { top: r.top, idx: Math.floor(r.idx) };
}

/** 覆盖索引 idx 所在块的渲染窗口下限（与 ensureCapFor 的 `idx + chunk` 同口径）。 */
export function capForIndex(idx: number, chunk: number): number {
  return idx + chunk;
}

/**
 * 目标 scrollTop 是否已可应用：文档可滚动高度（scrollHeight - clientHeight）
 * 覆盖到目标值 - 容差。
 */
export function scrollHeightReady(scrollHeight: number, clientHeight: number, top: number): boolean {
  return scrollHeight - clientHeight >= top - SCROLL_READY_TOLERANCE;
}
