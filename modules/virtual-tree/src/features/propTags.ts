/**
 * 属性标签（tags）在虚拟文档树里的读取侧。
 *
 * 2026-11-24 用户定调：**标签就是一种属性** —— 属性名 `tags`，值用户自己填
 * （逗号分隔多个），权威数据在索引守护进程的 file_props 表（file-props 模块）。
 * 本文件只做两件事：
 *   1. 把「树节点 → 属性路径主键」的换算收敛到一处（库内挂载用库内相对路径，
 *      库外/远端用节点 abs，与 file-props 的「文件属性…」完全同键）；
 *   2. 一次性把全库 tags 属性拉成 Map（渲染是同步的，异步查询结果先落缓存）。
 *
 * 旧的 TagDef / settings.fileTags（tagStore.ts）保留为**读侧兜底 + 配色表**：
 * 打过旧标签的文件照样显示、照样能筛；一旦用户在树上改标签，写入走 tags 属性，
 * 该路径的旧映射被清掉（属性成为唯一权威）。
 */
import type { App } from 'obsidian';
import { filePropsOf } from '../../../file-props/src/main';
import { parseTagValue, TAGS_PROP_KEY } from '../../../file-props/src/tags';
import { vaultJoinPath } from './vaultFs';
import { isVaultMount, type ExternalMount } from '../types';
import type { MountNode } from './mountFilter';

/** 属性路径主键（写侧原样，读侧归一）。 */
export function propPathKey(mount: ExternalMount, node: MountNode): string {
	if (isVaultMount(mount)) return vaultJoinPath(mount, node.rel);
	return node.abs || node.rel;
}

/** 键归一：Windows 盘符路径与 POSIX 路径互相比较时只看分隔符差异。 */
export function normPropKey(path: string): string {
	return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 拉全库 `tags` 属性：Map<归一化路径, 标签名[]>。daemon 不在时返回空表。 */
export async function loadPropTags(app: App): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	const daemon = filePropsOf(app)?.getDaemon();
	if (!daemon) return out;
	try {
		const res = await daemon.propsQuery({ key: TAGS_PROP_KEY, limit: 5000 });
		for (const row of res.rows) {
			const names = parseTagValue(row.value);
			if (names.length) out.set(normPropKey(row.path), names);
		}
	} catch {
		/* daemon 抖动：保留空表，树照常渲染（只是暂时没有属性标签） */
	}
	return out;
}

export { TAGS_PROP_KEY };
