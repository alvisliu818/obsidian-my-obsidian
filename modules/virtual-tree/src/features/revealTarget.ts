/**
 * 「定位当前文件」多挂载候选的纯选择逻辑（2026-11-24 用户）。
 *
 * 同一文件可能同时出现在多个挂载里：主库实测 260817/.../STEP1.md 既在内置
 * 库根（相对路径 260817/...）下，也在库外挂载 E:/.../260817（相对路径
 * 17-.../STEP1.md）下。旧逻辑「先命中库内挂载就 return」会跳到没展开的那
 * 一份，用户观感就是「定位不到」。
 *
 * 规则可在设置里切：默认 **已展开/加载了文件路径的那一份优先**，也可固定
 * 优先库内挂载或库外挂载。其余按候选顺序（更具体的挂载根在前）兜底。
 * 纯函数，便于单测。
 */

export type RevealPreference = 'expanded' | 'vault' | 'external';

export interface RevealCandidate {
  mountId: string;
  /** 相对路径（'' = 挂载根本身） */
  rel: string;
  /** 库内挂载（含内置库根）/ 库外挂载 */
  kind: 'vault' | 'external';
}

export interface RevealMountState {
  /** 已加载子层的目录 rel（文件本身不在里面，看它的父目录） */
  loaded: ReadonlySet<string>;
  /** 已展开的目录 rel */
  open: ReadonlySet<string>;
}

function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function score(c: RevealCandidate, st: RevealMountState | undefined): number {
  if (!st) return 0;
  let s = 0;
  const parent = parentRel(c.rel);
  if (parent) {
    // 父目录已加载 = 文件行已在（或曾在）树上；已展开 = 用户当前看得见
    if (st.loaded.has(parent)) s += 1000;
    if (st.open.has(parent)) s += 500;
  } else if (st.loaded.has('')) {
    s += 1000; // 挂载根本身（rel=''）已加载
  }
  // 更深层的祖先也展开过，说明用户一路点进来的就是这棵子树
  const parts = c.rel.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts.slice(0, i + 1).join('/');
    if (st.loaded.has(p)) s += 20;
    if (st.open.has(p)) s += 10;
  }
  return s;
}

/**
 * 从候选里挑定位目标。候选顺序保留调用方的优先级（更具体的挂载根在前），
 * JS sort 稳定，因此同分时仍按原顺序。
 */
export function pickRevealTarget<T extends RevealCandidate>(
  candidates: readonly T[],
  stateOf: (mountId: string) => RevealMountState | undefined,
  prefer: RevealPreference = 'expanded',
): T | undefined {
  if (!candidates.length) return undefined;
  if (prefer === 'vault') return candidates.find((c) => c.kind === 'vault') ?? candidates[0];
  if (prefer === 'external') return candidates.find((c) => c.kind === 'external') ?? candidates[0];
  return candidates
    .slice()
    .sort((a, b) => score(b, stateOf(b.mountId)) - score(a, stateOf(a.mountId)))[0];
}
