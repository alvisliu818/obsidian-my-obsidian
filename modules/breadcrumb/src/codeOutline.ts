/**
 * 代码文件面包屑的「缩进大纲」。
 *
 * 代码没有 md 的标题层级，但缩进本身就是层级：`def` / `class` / `for` /
 * `if` 等块头（以 `:` 或 `{` 结尾的行）加上更深的缩进，构成一条从文件顶层
 * 到当前行的路径。面包屑显示的就是这条路径——交互与 md 标题面包屑一致：
 * 点击某一段跳到那一行、悬浮看同级、末尾 › 看下一级。
 *
 * 纯函数（不 import obsidian），便于单测。
 */

export interface CodeOutlineNode {
	/** 1-based 行号（Monaco 行号空间，混合视图即代码区行号） */
	line: number;
	/** 去掉缩进后的行文本（面包屑标签） */
	text: string;
	/** 缩进宽度（tab 按 4 列） */
	indent: number;
	parent: CodeOutlineNode | null;
	children: CodeOutlineNode[];
}

export interface CodeOutline {
	/** 顶层块头 */
	roots: CodeOutlineNode[];
	/** 每一行（1-based）的祖先链；块头行含自身 */
	chainAt: Map<number, CodeOutlineNode[]>;
}

/** 缩进宽度：tab 记 4 列（与常见编辑器显示一致）。 */
export function indentWidth(raw: string): number {
	let w = 0;
	for (const ch of raw) {
		if (ch === ' ') w += 1;
		else if (ch === '\t') w += 4;
		else break;
	}
	return w;
}

/**
 * 块头判定：以 `:` 或 `{` 结尾的行是块的开始。
 *
 * - Python / YAML / Ruby：`def foo():`、`for i in xs:`、`key:`
 * - JS / TS / Java / C：`if (x) {`、`class A {`、`switch (x) {`
 *
 * 刻意不把 `(` / `[` 当块头：多行函数调用的括号会被误判成层级，面包屑
 * 就会为一次普通调用多画一层。
 */
export function isCodeBlockHeader(text: string): boolean {
	const t = text.trimEnd();
	if (!t) return false;
	return t.endsWith(':') || t.endsWith('{');
}

/**
 * 扫描全文，构建缩进树并记录每行的祖先链。
 *
 * 栈式扫描：遇到更深缩进的行入栈，遇到同级/更浅的行先出栈——出栈只看
 * **非空行**的缩进，空行沿用上一行的链（面包屑不会因为空行断掉）。
 */
export function buildCodeOutline(lines: string[]): CodeOutline {
	const roots: CodeOutlineNode[] = [];
	const chainAt = new Map<number, CodeOutlineNode[]>();
	const stack: CodeOutlineNode[] = [];
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? '';
		const text = raw.trim();
		if (!text) {
			chainAt.set(i + 1, [...stack]);
			continue;
		}
		const indent = indentWidth(raw);
		while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
		if (isCodeBlockHeader(text)) {
			const parent = stack[stack.length - 1] ?? null;
			const node: CodeOutlineNode = { line: i + 1, text, indent, parent, children: [] };
			if (parent) parent.children.push(node);
			else roots.push(node);
			stack.push(node);
			chainAt.set(i + 1, [...stack]);
		} else {
			chainAt.set(i + 1, [...stack]);
		}
	}
	return { roots, chainAt };
}
