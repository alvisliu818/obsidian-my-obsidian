/**
 * HOME 页区块注册表(2026-11-22 用户:各组件支持自定义排序)。
 *
 * 渲染顺序取自 life 设置的 homeSectionOrder;这里定义全部合法 id 与中文名,
 * 设置页的排序列表与 HOME 渲染共用,保证「设置里看到的」=「HOME 渲染的」。
 * 旧配置缺项/手改出非法 id 时由 normalizeHomeSectionOrder 回落默认并补齐。
 */

export const HOME_SECTIONS = [
	{ id: 'todayChanges', name: '今日库变化' },
	{ id: 'vaultLog', name: '库记录' },
	{ id: 'gitHistory', name: 'Git 历史' },
	{ id: 'saveHistory', name: '保存历史' },
	{ id: 'calendar', name: '大日历' },
	{ id: 'diary', name: '日记' },
	{ id: 'overview', name: '今日概览' },
] as const;

export type HomeSectionId = (typeof HOME_SECTIONS)[number]['id'];

export interface HomeSectionDef {
	id: HomeSectionId;
	name: string;
}

/** 默认顺序 = 2026-11-22 之前的固定渲染顺序。 */
export const DEFAULT_HOME_SECTION_ORDER: HomeSectionId[] = HOME_SECTIONS.map((s) => s.id);

/** 清洗顺序:保留合法且不重复的 id,再按默认顺序补齐缺失项。 */
export function normalizeHomeSectionOrder(raw: unknown): HomeSectionId[] {
	const valid = new Set<string>(DEFAULT_HOME_SECTION_ORDER);
	const out: HomeSectionId[] = [];
	if (Array.isArray(raw)) {
		for (const v of raw) {
			if (typeof v === 'string' && valid.has(v) && !out.includes(v as HomeSectionId)) {
				out.push(v as HomeSectionId);
			}
		}
	}
	for (const id of DEFAULT_HOME_SECTION_ORDER) {
		if (!out.includes(id)) out.push(id);
	}
	return out;
}
