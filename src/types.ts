import type { HeadingCache } from "obsidian";

/** 标题树节点：一个标题及其子标题 */
export interface HeadingNode {
	/** 稳定标识，取标题起始偏移量 */
	key: string;
	level: number;
	heading: HeadingCache;
	parent: HeadingNode | null;
	children: HeadingNode[];
}

export interface HeadingTree {
	/** 最浅一级标题（顶层） */
	roots: HeadingNode[];
	byKey: Map<string, HeadingNode>;
	/** 文档顺序（先序遍历即文档顺序） */
	flat: HeadingNode[];
}

/** 悬浮菜单条目 */
export interface MenuEntry {
	key: string;
	text: string;
	/** 右侧灰色小字（如命中的标签） */
	suffix?: string;
	active?: boolean;
	/** 是否还有下一级（决定要不要画 ▸） */
	hasChildren?: boolean;
	/** 点击文本 */
	onSelect: () => void;
	/** 点击 ▸（继续下钻） */
	onDrill?: () => void;
	/** 下一级条目（懒加载：悬浮 ▸ 时才构建，避免递归展开整棵树） */
	children?: () => MenuEntry[];
}

export interface BreadcrumbNavSettings {
	enabled: boolean;
	/** 面包屑与菜单中每项文本的最大长度，超出以 ... 截断 */
	maxLength: number;
	/** 悬浮面包屑某一级时显示同级其他标题 */
	enableSiblingsMenu: boolean;
	/** 面包屑末尾显示 ▸ 下一级图标 */
	enableNextLevel: boolean;
	/** 悬浮菜单项时自动展开它的下一级（级联子菜单），无需点击 */
	hoverExpandChildren: boolean;
	/** 悬浮菜单条目本体即展开下一级；关闭后只有停在右侧的 ▸ 上才展开 */
	hoverExpandOnItem: boolean;
	/** 悬浮页面项时显示同标签的其他页面 */
	enableRelatedPages: boolean;
	/** 是否把当前所在标题也放进面包屑 */
	includeCurrentHeading: boolean;
	/** 面包屑是否吸顶（关闭则随内容滚动） */
	sticky: boolean;
	/** 是否跟随光标/滚动位置自动更新 */
	followCursor: boolean;
	/** 悬浮菜单一次最多显示多少条目 */
	maxMenuItems: number;
}

export const DEFAULT_SETTINGS: BreadcrumbNavSettings = {
	enabled: true,
	maxLength: 50,
	enableSiblingsMenu: true,
	enableNextLevel: true,
	hoverExpandChildren: true,
	hoverExpandOnItem: true,
	enableRelatedPages: true,
	includeCurrentHeading: true,
	sticky: true,
	followCursor: true,
	maxMenuItems: 20,
};
