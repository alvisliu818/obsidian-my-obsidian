import type { HeadingCache } from "obsidian";
import type { HeadingNode, HeadingTree } from "./types";

/**
 * 把 metadataCache 里的平铺标题列表构建成层级树。
 * 用栈维护「当前祖先链」：遇到级别更高（数字更小）的标题就弹出栈顶，
 * 直到栈顶级别小于当前标题级别，成为其父节点。
 * 先序遍历结果即文档顺序，与 headings 原顺序一致。
 */
export function buildHeadingTree(headings?: HeadingCache[]): HeadingTree {
	const roots: HeadingNode[] = [];
	const byKey = new Map<string, HeadingNode>();
	const flat: HeadingNode[] = [];
	const stack: HeadingNode[] = [];

	(headings || []).forEach((h) => {
		const node: HeadingNode = {
			key: "h" + h.position.start.offset,
			level: h.level,
			heading: h,
			parent: null,
			children: [],
		};

		while (stack.length && stack[stack.length - 1].level >= node.level) {
			stack.pop();
		}
		const parent = stack.length ? stack[stack.length - 1] : null;
		node.parent = parent;
		if (parent) parent.children.push(node);
		else roots.push(node);

		byKey.set(node.key, node);
		flat.push(node);
		stack.push(node);
	});

	return { roots, byKey, flat };
}

/** 取子级：key 为空表示顶层标题 */
export function childrenOf(tree: HeadingTree, key: string | null): HeadingNode[] {
	if (!key) return tree.roots;
	return tree.byKey.get(key)?.children ?? [];
}

/** 取同级：包含自己 */
export function siblingsOf(tree: HeadingTree, key: string): HeadingNode[] {
	const node = tree.byKey.get(key);
	if (!node) return [];
	return node.parent ? node.parent.children : tree.roots;
}

/** 从根到该节点的链（includeSelf=false 时不含该节点本身） */
export function chainTo(node: HeadingNode | null, includeSelf: boolean): HeadingNode[] {
	const out: HeadingNode[] = [];
	let cur: HeadingNode | null = includeSelf ? node : node ? node.parent : null;
	while (cur) {
		out.unshift(cur);
		cur = cur.parent;
	}
	return out;
}
