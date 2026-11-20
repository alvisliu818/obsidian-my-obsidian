/**
 * Token 锚定系统工厂(renderTree 拆分,2026-11-21):三套同型渲染占位 token 的
 * 铸造/登记/查找形状统一——
 *   - LGIMGANCHOR:库内 img 相对 src 锚定(blocks/externalMedia.ts);
 *   - LGMEDIAANCHOR:库外媒体嵌入锚定(同上);
 *   - LGPAGEEMBED:page-embed 占位(blocks/renderTree.ts)。
 * 交换机制各有不同(img/video 的 src 属性匹配 vs 文本节点替换),由消费方
 * 各自实现;工厂只收口铸造(take)、载荷登记与索引正则——同一前缀、同一
 * `${prefix}${i}${prefix}` 格式、同一「按索引回查载荷」语义。
 */
export interface AnchorToken {
	token: string;
}

export interface AnchorTokenSystem<T extends AnchorToken> {
	/** 登记载荷并铸造下一个 token(token 字段自动填充)。 */
	take(payload: Omit<T, 'token'>): T;
	/** 按 token 字符串回查载荷(编号越界/格式不符 → undefined)。 */
	entryOf(token: string): T | undefined;
	all(): readonly T[];
	/** 索引正则(搜索态,可嵌在更长字符串里匹配)。 */
	searchRe(): RegExp;
	/** 全匹配正则(整串恰好是一个 token,用于属性值完整命中)。 */
	fullRe(): RegExp;
}

export function makeTokenSystem<T extends AnchorToken>(prefix: string): AnchorTokenSystem<T> {
	const entries: T[] = [];
	const searchRe = (): RegExp => new RegExp(`${prefix}(\\d+)${prefix}`);
	return {
		take(payload) {
			const entry = { ...payload, token: `${prefix}${entries.length}${prefix}` } as T;
			entries.push(entry);
			return entry;
		},
		entryOf(token: string): T | undefined {
			const m = searchRe().exec(token);
			if (!m) return undefined;
			return entries[Number(m[1])];
		},
		all: () => entries,
		searchRe,
		fullRe: () => new RegExp(`^${prefix}(\\d+)${prefix}$`),
	};
}
