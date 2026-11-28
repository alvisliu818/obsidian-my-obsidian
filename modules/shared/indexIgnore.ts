/**
 * 索引忽略（黑白名单正则）—— 纯函数，渲染端与索引守护进程共用。
 *
 * 背景（2026-11-28 用户需求）：块索引 / 统一搜索的收录范围需要按路径忽略，
 * 且支持黑白名单正则。语义与虚拟文档树的「隐藏 / 例外名单」同一套语法
 * （见 shared/patternList.ts）：
 *   - 黑名单命中 → 不进索引（文件级反链/标签/卡片/搜索都看不到它）；
 *   - 白名单命中 → **永远收录**，优先于黑名单（给黑名单开洞）；
 *   - 黑名单为空 = 功能不启用（白名单单独存在没有意义）。
 *
 * 坐标：库内文件用**库内相对路径**（与挂载面板/隐藏名单一致）；库外挂载
 * 文件没有统一的挂载相对坐标，传**绝对路径**（反斜杠会先归一成 `/`）。
 *
 * 不 import obsidian、不碰 fs：守护进程（MyKernel.cjs）也直接复用本文件。
 */

import { compilePatternList, patternsHit, type PatternSpec } from './patternList';

/** 用户配置形态（data.json / 守护进程 setConfig 推送同一形状）。 */
export interface IndexIgnoreConfig {
	/** 忽略名单：命中即不进索引。 */
	blacklist: string[];
	/** 例外名单：命中即照常收录，优先于黑名单。 */
	whitelist: string[];
}

export const EMPTY_INDEX_IGNORE: IndexIgnoreConfig = { blacklist: [], whitelist: [] };

/** 编译后的规则（扫描热路径上只编译一次，逐文件只做 test）。 */
export interface IndexIgnoreRules {
	blacklist: PatternSpec[];
	whitelist: PatternSpec[];
	/** 没配黑名单 = 整条链路不用过滤。 */
	active: boolean;
}

/** 配置清洗：只留非空字符串，去首尾空白（data.json 是可手改的）。 */
function cleanList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((p): p is string => typeof p === 'string')
		.map((p) => p.trim())
		.filter((p) => p !== '');
}

/** 任意来源（设置/守护进程消息）→ 合法配置；undefined 安全。 */
export function normalizeIgnoreConfig(raw: unknown): IndexIgnoreConfig {
	const o = (raw ?? {}) as { blacklist?: unknown; whitelist?: unknown };
	return { blacklist: cleanList(o.blacklist), whitelist: cleanList(o.whitelist) };
}

/**
 * 旧设置 `indexExcludedFolders`（逗号分隔的目录）→ 等价正则。
 *
 * 旧语义是「库根起的路径前缀」，新名单按名字/路径段匹配（与隐藏名单一致），
 * 所以迁移结果比旧语义**略宽**：`backups` 会命中任意层级的同名目录，而不再
 * 只认库根那一层。列表里带层级的条目（`projects/notes`）仍按前缀锚定，
 * 不会误伤 `projects/notes2`。
 */
export function legacyFolderListToPatterns(raw: string): string[] {
	const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return raw
		.split(',')
		.map((s) => s.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
		.filter(Boolean)
		.map((folder) => `^${escape(folder)}(/|$)`);
}

export function compileIndexIgnore(config: IndexIgnoreConfig | undefined): IndexIgnoreRules {
	const blacklist = compilePatternList(config?.blacklist);
	return {
		blacklist,
		whitelist: compilePatternList(config?.whitelist),
		active: blacklist.length > 0,
	};
}

/** 这一项（相对路径，`/` 分隔）是否该被排除出索引。白名单优先。 */
export function isIndexIgnored(rel: string, rules: IndexIgnoreRules): boolean {
	if (!rules.active) return false;
	const name = rel.slice(rel.lastIndexOf('/') + 1);
	if (rules.whitelist.length && patternsHit(rel, name, rules.whitelist)) return false;
	return patternsHit(rel, name, rules.blacklist);
}

/** 绝对路径版本（库外挂载文件）：反斜杠归一成 `/` 后再匹配。 */
export function isIndexIgnoredPath(abs: string, rules: IndexIgnoreRules): boolean {
	return isIndexIgnored(abs.replace(/\\/g, '/'), rules);
}

/**
 * 目录扫描剪枝：命中黑名单的目录整棵不进（连 stat 都省）。
 *
 * 配了白名单就不剪——例外可能藏在被剪掉的子树里（与虚拟文档树隐藏名单
 * 的取舍一致：宁可多走一层，也不让白名单形同虚设）。白名单通常只开几个
 * 文件，代价可接受；没配白名单时 `node_modules` 这类巨树照旧整棵跳过。
 */
export function isIndexDirPruned(rel: string, rules: IndexIgnoreRules): boolean {
	if (!rules.active || rules.whitelist.length > 0) return false;
	const name = rel.slice(rel.lastIndexOf('/') + 1);
	return patternsHit(rel, name, rules.blacklist);
}
