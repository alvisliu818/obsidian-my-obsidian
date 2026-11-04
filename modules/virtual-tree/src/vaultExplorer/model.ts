/**
 * Vault virtual explorer — pure tree model.
 *
 * The single memory rule that motivates this module: the native file explorer
 * builds a DOM row for EVERY file in the vault at load time (55k files →
 * ~165k detached DOM nodes + a 58k-entry item registry, measured via heap
 * snapshot 2026-11-04). This model never materialises the whole tree: rows
 * are emitted only for the folders currently expanded, walked lazily off the
 * live vault structure.
 *
 * Everything here is plain data in/out so vitest can hammer it without an
 * Obsidian instance; the view adapts TFolder/TFile onto the lazy node shape.
 */

/** A vault entry as the model sees it. `children` is a LAZY accessor: for a
 * folder it reads the live folder children (no copy); for a file it is null. */
export interface VxNode {
	readonly path: string;
	readonly name: string;
	readonly isDir: boolean;
	/** Direct children in vault order, or null for files. Lazy on purpose. */
	readonly children: readonly VxNode[] | null;
}

/** The sort orders the explorer header offers. */
export type VxSortOrder = "alphabetical" | "alphabeticalReverse" | "byModifiedTime" | "byModifiedTimeReverse";

/** One drawable row: a flattened tree entry at its nesting depth. */
export interface VxRow {
	readonly path: string;
	readonly name: string;
	readonly isDir: boolean;
	/** Nesting depth (0 = directly under the vault root). */
	readonly depth: number;
}

/** Default sort: folders first, then case-insensitive name. */
export function vxCompare(a: VxNode, b: VxNode, order: VxSortOrder): number {
	if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
	switch (order) {
		case "alphabeticalReverse":
			return b.name.localeCompare(a.name, undefined, { sensitivity: "base" });
		case "byModifiedTime":
		case "byModifiedTimeReverse":
			// mtime lives on files only; folders keep name order so the tree
			// part of the list stays stable while the files reshuffle.
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		default:
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	}
}

/** Sort one folder's children for display. `mtimeOf` supplies file mtimes
 * (files sort newest-first for byModifiedTime, oldest-first for the reverse). */
export function vxSortChildren(
	children: readonly VxNode[],
	order: VxSortOrder,
	mtimeOf: (node: VxNode) => number | undefined,
): VxNode[] {
	const sorted = [...children].sort((a, b) => {
		if ((order === "byModifiedTime" || order === "byModifiedTimeReverse") && !a.isDir && !b.isDir) {
			const at = mtimeOf(a) ?? 0;
			const bt = mtimeOf(b) ?? 0;
			if (at !== bt) return order === "byModifiedTime" ? bt - at : at - bt;
		}
		return vxCompare(a, b, order);
	});
	return sorted;
}

/** Paths of every ancestor folder of `path`, nearest first, excluding "" (the
 * root is always expanded and never enters the expanded set). */
export function vxAncestorFolders(path: string): string[] {
	const out: string[] = [];
	const slash = path.lastIndexOf("/");
	let cur = path.slice(0, slash === -1 ? 0 : slash);
	while (cur !== "") {
		out.push(cur);
		const next = cur.lastIndexOf("/");
		cur = next === -1 ? "" : cur.slice(0, next);
	}
	return out;
}

/**
 * Flatten the vault tree into draw order.
 *
 * Normal mode: only folders in `expanded` contribute their children — the
 * whole-vault walk never happens, so a collapsed vault costs O(top level).
 * Query mode (`query` non-empty): walk EVERYTHING and emit matching entries
 * (name contains query, case-insensitive), each at its true depth. The row
 * array is transient either way; nothing is cached.
 *
 * `mtimeOf` only matters for the mtime sort orders.
 */
export function vxFlatten(
	roots: readonly VxNode[],
	expanded: ReadonlySet<string>,
	order: VxSortOrder,
	mtimeOf: (node: VxNode) => number | undefined,
	query = "",
): VxRow[] {
	const out: VxRow[] = [];
	const q = query.trim().toLowerCase();
	if (q) {
		const walk = (children: readonly VxNode[], depth: number): void => {
			for (const child of children) {
				if (child.name.toLowerCase().includes(q)) {
					out.push({ path: child.path, name: child.name, isDir: child.isDir, depth });
				}
				if (child.isDir && child.children !== null) walk(child.children, depth + 1);
			}
		};
		// 命中行按"文件夹在前 + 名字"排序没有意义(跨层级混排),按路径排序
		// 给一个稳定顺序——搜索要的是"找到",不是浏览。
		walk(roots, 0);
		out.sort((a, b) => a.path.localeCompare(b.path));
		return out;
	}
	const walk = (children: readonly VxNode[], depth: number): void => {
		for (const child of vxSortChildren(children, order, mtimeOf)) {
			out.push({ path: child.path, name: child.name, isDir: child.isDir, depth });
			if (child.isDir && expanded.has(child.path)) {
				walk(child.children ?? [], depth + 1);
			}
		}
	};
	walk(roots, 0);
	return out;
}

/**
 * The expanded set a reveal operation needs: every ancestor folder of `path`
 * (the target file's own folder chain). Root ('') excluded — always expanded.
 */
export function vxExpandedForReveal(path: string, current: ReadonlySet<string>): Set<string> {
	const next = new Set(current);
	for (const p of vxAncestorFolders(path)) next.add(p);
	return next;
}

/** Row index of `path` in a flattened list (root's own row excluded — the
 * model never emits a root row), or -1. */
export function vxIndexOf(rows: readonly VxRow[], path: string): number {
	for (let i = 0; i < rows.length; i++) if (rows[i].path === path) return i;
	return -1;
}

/** Rename a folder path prefix in an expanded set (vault rename event). */
export function vxRepathExpanded(current: ReadonlySet<string>, oldPath: string, newPath: string): Set<string> {
	const next = new Set<string>();
	for (const p of current) {
		if (p === oldPath) next.add(newPath);
		else if (p.startsWith(`${oldPath}/`)) next.add(newPath + p.slice(oldPath.length));
		else next.add(p);
	}
	return next;
}
