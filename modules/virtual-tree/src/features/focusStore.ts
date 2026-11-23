/**
 * 虚拟文档树「聚集」功能（2026-11-23 用户需求）：
 * 在树行上右键「聚集到此」后，面板只保留该节点、它的子树、它的兄弟、
 * 兄弟的子树，以及到达该节点的祖先链；其余一切隐藏（包括其他挂载）。
 * 可同时聚集多个目标；状态是会话运行态（重启清空，不落盘）。
 *
 * 关键点：一切关系按「树里的实际祖先链」判定，而非 rel 路径前缀——parent
 * 挂载产生的虚拟子行 rel 是库内路径（/notes/x.md），父子两行 rel 前缀相同、
 * 路径上是同级，用前缀判定会把父子误算成兄弟、把子树判成无关。故渲染层
 * walkLevel 逐层下潜时携带 ancestors（从根到直接父的 rel 链），聚集目标
 * 也记录自己的 ancestors。
 *
 * 展示方式由设置 focusMode 决定（2026-11-23）：
 *   - 'context'（默认）：保留祖先链与兄弟组，目标在原位可见；
 *   - 'subtree'：只留目标与它的子树，目标的父级/兄弟都不展示。
 */

import type { FocusMode } from '../types';

export interface FocusTarget {
  /** 目标所属挂载 id */
  mountId: string;
  /** 目标在挂载内的 rel */
  rel: string;
  /** 目标在树里的祖先 rel 链（从根到直接父，不含自身） */
  ancestors: string[];
  /** 目标是否文件夹 */
  isDir: boolean;
}

/**
 * 节点在聚集状态下是否可见。
 *
 * @param nodeRel 当前节点 rel
 * @param ancestors 当前节点的树祖先链（从根到直接父，不含自身）
 * @param mode 聚焦方式（'context' = 保留祖先/兄弟；'subtree' = 仅目标与子树）
 *
 * 'context' 模式对目标 T：
 * - 目标自身：nodeRel === T.rel
 * - 目标子树：T.rel ∈ ancestors
 * - 目标祖先：nodeRel ∈ T.ancestors
 * - 兄弟：当前直接父 === 目标直接父（两条 ancestors 末位相等）
 * - 兄弟子树：目标直接父 ∈ ancestors，且当前节点不是目标自身/子树
 *
 * 'subtree' 模式只命中前两条：目标自身与目标子树。目标的父级（祖先链）
 * 和兄弟都不上屏。
 */
export function nodeVisibleUnderFocus(
  focusTargets: FocusTarget[],
  mountId: string,
  nodeRel: string,
  ancestors: string[],
  mode: FocusMode = 'context',
): boolean {
  const targets = focusTargets.filter((t) => t.mountId === mountId);
  // 无目标 → 不过滤（跨挂载隐藏由渲染层 mountsToRender 处理：聚集时只渲染含
  // 目标的挂载；无目标时渲染全部挂载、flattenHost 不该隐藏任何节点）。
  if (!targets.length) return true;
  if (mode === 'subtree') {
    return targets.some((t) => nodeRel === t.rel || ancestors.includes(t.rel));
  }
  const nodeParent = ancestors.length ? ancestors[ancestors.length - 1] : '';
  return targets.some((t) => {
    if (nodeRel === t.rel) return true; // 目标自身
    if (ancestors.includes(t.rel)) return true; // 目标子树
    if (t.ancestors.includes(nodeRel)) return true; // 目标祖先（保可达）
    const targetParent = t.ancestors.length ? t.ancestors[t.ancestors.length - 1] : '';
    if (nodeParent === targetParent) return true; // 兄弟（同直接父）
    if (targetParent && ancestors.includes(targetParent)) return true; // 兄弟的子树
    return false;
  });
}

/**
 * nodeRel 是否是某个聚集目标在树里的祖先。
 *
 * 'subtree' 模式下祖先行本身不展示，但渲染层仍需下潜穿过它们才能把目标
 * 画出来（否则目标被整棵剪掉）；'context' 模式祖先行本来就可见。
 */
export function focusTargetBelow(
  focusTargets: FocusTarget[],
  mountId: string,
  nodeRel: string,
): boolean {
  return focusTargets.some((t) => t.mountId === mountId && t.ancestors.includes(nodeRel));
}
