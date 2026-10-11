/**
 * 视图头部（标签页下面那条导航条）的完整路径面包屑。
 *
 * 虚拟文档树打开的文件不在库里，Obsidian 只给自定义视图留了一个**空的**
 * `.view-header-title-parent`（原生 FileView 会在这里放 `E2E /` 这样的目录链），
 * 于是标签页下面只剩一个文件名，看不出文件在磁盘上的位置。这里按原生 FileView
 * 的 DOM 结构补上「挂载名 / 子目录 / … /」，观感与库内笔记一致。
 */

import { Menu, Notice } from 'obsidian';
import { scanExternal } from '../features/extFs';

export interface HeaderSegment {
	/** 这一段显示的文字 */
	label: string;
	/** 这一段对应的磁盘绝对路径（悬浮提示，点击可展开同级） */
	abs: string;
	/** 挂载名那一段（它的同级是别的挂载，不是磁盘目录） */
	isMount?: boolean;
}

/** 打开菜单需要的插件能力（结构化类型，免得这里反向依赖 main.ts）。 */
export interface ExternalMountLike {
	id: string;
	path: string;
	label: string;
	enabled?: boolean;
}
export interface MountNodeLike {
	name: string;
	rel: string;
	abs: string;
	isDir: boolean;
	children: MountNodeLike[];
}
export interface HeaderMenuHost {
	settings: { externalMounts?: ExternalMountLike[] };
	openExternalEntry(mount: ExternalMountLike, node: MountNodeLike): Promise<void>;
	revealInSystem(abs: string): void;
}

/**
 * 由「挂载相对路径」反推每一段的绝对路径。
 *
 * `rel` 是挂载根起的路径且含文件名（`probe-drag/c1.md`），文件名本身交给
 * 标题，不当面包屑段。`mountLabel` 为空时不显示挂载名那一段（此时退化为
 * 纯子目录链，仍然能说明位置）。
 */
export function headerPathSegments(abs: string, rel: string, mountLabel: string): HeaderSegment[] {
	const full = (abs || '').replace(/\\/g, '/');
	if (!full) return [];
	const relParts = (rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
	relParts.pop(); // 最后一段是文件名本身

	const fileIdx = full.lastIndexOf('/');
	const dirAbs = fileIdx >= 0 ? full.slice(0, fileIdx) : '';
	// dirAbs 去掉尾部 relParts.length 段，剩下的就是挂载根
	const rootParts = dirAbs.split('/');
	if (relParts.length) {
		rootParts.splice(Math.max(0, rootParts.length - relParts.length), relParts.length);
	}
	const root = rootParts.join('/');

	const out: HeaderSegment[] = [];
	if (mountLabel) out.push({ label: mountLabel, abs: root });
	let cur = root;
	for (const part of relParts) {
		cur = cur ? `${cur}/${part}` : part;
		out.push({ label: part, abs: cur });
	}
	return out;
}

/** 把路径段画成原生样式的 view-header 面包屑；重复调用会先清空。 */
export function renderHeaderPath(
	container: HTMLElement,
	segments: HeaderSegment[],
	host?: HeaderMenuHost,
): void {
	container.empty();
	for (const seg of segments) {
		const span = container.createSpan({ cls: 'view-header-breadcrumb', text: seg.label });
		span.setAttribute('aria-label', seg.label);
		span.setAttribute('draggable', 'true');
		span.title = `${seg.abs}（点击展开同级）`;
		if (host) {
			span.addClass('lgp-hdr-crumb');
			attachHeaderMenu(span, host, seg);
		}
		container.createSpan({ cls: 'view-header-breadcrumb-separator', text: '/' });
	}
}

// --------------------------------------------------------------------------
// 点击某一段：弹出它的同级（VSCode 面包屑的同款交互）
// --------------------------------------------------------------------------

/** 子菜单最多再往下铺几层，避免在大目录里递归读盘。 */
const MAX_MENU_DEPTH = 3;
/** 一层最多列多少条目 */
const MENU_LIMIT = 200;

function norm(p: string): string {
	return (p || '').replace(/\\/g, '/');
}

function findMount(host: HeaderMenuHost, abs: string): ExternalMountLike | null {
	const mounts = host.settings.externalMounts ?? [];
	const full = norm(abs).toLowerCase();
	let best: ExternalMountLike | null = null;
	let bestLen = -1;
	for (const m of mounts) {
		const root = norm(m.path).replace(/\/+$/, '').toLowerCase();
		if (!root || !full.startsWith(root + '/')) continue;
		if (root.length > bestLen) {
			bestLen = root.length;
			best = m;
		}
	}
	return best;
}

function relUnder(mount: ExternalMountLike, abs: string): string {
	const root = norm(mount.path).replace(/\/+$/, '');
	const full = norm(abs);
	return full.toLowerCase().startsWith(root.toLowerCase() + '/') ? full.slice(root.length + 1) : '';
}

/** 一个目录下的直接条目：文件夹在前，各自按名称排。 */
function listDir(dirAbs: string): { name: string; abs: string; isDir: boolean }[] {
	let entries: { rel: string; name: string; abs: string; isDir: boolean }[] = [];
	try {
		// depth 0 = only the direct children: scanExternal visits the root at
		// depth 0 and stops recursing once `depth > maxDepth`.
		const res = scanExternal(dirAbs, {
			shouldEnterDir: () => true,
			keepFile: () => true,
			depth: 0,
			limit: MENU_LIMIT,
		});
		entries = res.entries;
	} catch {
		return [];
	}
	const dirs = entries.filter((e) => e.isDir);
	const files = entries.filter((e) => !e.isDir);
	const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
	return [...dirs.sort(byName), ...files.sort(byName)];
}

function fileIcon(name: string): string {
	return /\.md$/i.test(name) ? 'file-text' : 'file-code';
}

/**
 * 点某一段 → 菜单列出**它的同级**（父目录里的条目），当前那一段勾选高亮；
 * 目录项带子菜单可以继续往下钻，文件项点击直接打开。
 */
export function attachHeaderMenu(span: HTMLElement, host: HeaderMenuHost, seg: HeaderSegment): void {
	span.addEventListener('click', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		const menu = new Menu();
		if (seg.isMount) addMountLevel(menu, host, seg.abs);
		else addDirLevel(menu, host, parentOf(seg.abs), seg.abs, 1);
		addTail(menu, host, seg);
		menu.showAtMouseEvent(ev as MouseEvent);
		highlightChecked(menu);
	});
}

/**
 * 给菜单里"当前所在"那一项加一层高亮。
 *
 * `setChecked` 只放一个 ✓（class `mod-checked`），VSCode 里当前那一级是整行
 * 底色 + 强调色，看得出来自己站在哪。Menu.addItem 返回的是 Menu 而不是
 * MenuItem，所以只能等菜单挂上 DOM 后按 class 回找再补——只碰根菜单，
 * 子菜单里没有"当前项"。
 */
function highlightChecked(menu: Menu): void {
	const root = (menu as unknown as { dom?: HTMLElement }).dom;
	if (!root) return;
	window.requestAnimationFrame(() => {
		Array.from(root.querySelectorAll<HTMLElement>('.menu-item.mod-checked'))
			.filter((el) => el.closest('.menu') === root)
			.forEach((el) => el.addClass('lgp-hdr-current'));
	});
}

function parentOf(abs: string): string {
	const full = norm(abs);
	const i = full.lastIndexOf('/');
	return i > 0 ? full.slice(0, i) : full;
}

function addTail(menu: Menu, host: HeaderMenuHost, seg: HeaderSegment): void {
	menu.addSeparator();
	menu.addItem((it) =>
		it.setTitle('复制路径').setIcon('copy').onClick(() => {
			void navigator.clipboard?.writeText(seg.abs).then(
				() => new Notice(`已复制路径：${seg.abs}`),
				() => new Notice(`复制失败：${seg.abs}`),
			);
		}),
	);
	menu.addItem((it) =>
		it.setTitle('在系统中显示').setIcon('folder-open').onClick(() => host.revealInSystem(seg.abs)),
	);
}

/** 挂载名那一段：同级是别的挂载；点开某个挂载列出它的顶层内容。 */
function addMountLevel(menu: Menu, host: HeaderMenuHost, currentRoot: string): void {
	const mounts = (host.settings.externalMounts ?? []).filter((m) => m.enabled !== false);
	if (!mounts.length) {
		menu.addItem((it) => it.setTitle('（没有挂载）').setDisabled(true));
		return;
	}
	for (const m of mounts) {
		const root = norm(m.path).replace(/\/+$/, '');
		menu.addItem((it) => {
			it.setTitle(m.label || root)
				.setIcon('folder-open')
				.setChecked(root.toLowerCase() === norm(currentRoot).toLowerCase());
			if (root.toLowerCase() !== norm(currentRoot).toLowerCase()) {
				it.onClick(() => host.revealInSystem(root));
			}
			return it;
		});
	}
}

/** 某一层的同级列表。`currentAbs` 是要点亮的那一项。 */
function addDirLevel(
	menu: Menu,
	host: HeaderMenuHost,
	dirAbs: string,
	currentAbs: string,
	depth: number,
): void {
	const items = listDir(dirAbs);
	if (!items.length) {
		menu.addItem((it) => it.setTitle('（空）').setDisabled(true));
		return;
	}
	const mount = findMount(host, dirAbs) ?? findMount(host, currentAbs);
	for (const entry of items) {
		const isCurrent = norm(entry.abs) === norm(currentAbs);
		menu.addItem((it) => {
			it.setTitle(entry.name)
				.setIcon(entry.isDir ? 'folder' : fileIcon(entry.name))
				.setChecked(isCurrent);
			if (entry.isDir && depth < MAX_MENU_DEPTH) {
				const sub = new Menu();
				addDirLevel(sub, host, entry.abs, '', depth + 1);
				const withSub = it as unknown as { setSubmenu?: (m: Menu) => void };
				if (typeof withSub.setSubmenu === 'function') withSub.setSubmenu(sub);
				it.onClick(() => host.revealInSystem(entry.abs));
			} else if (mount) {
				it.onClick(() => {
					void host.openExternalEntry(mount, {
						name: entry.name,
						rel: relUnder(mount, entry.abs) || entry.name,
						abs: entry.abs,
						isDir: entry.isDir,
						children: [],
					});
				});
			}
			return it;
		});
	}
}

/** 视图头部里放面包屑的那个容器（原生 FileView 用它放目录链）。 */
export function headerTitleParent(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>('.view-header-title-parent');
}

/**
 * 刷新视图头部的路径面包屑。
 *
 * 头部由框架装配，`onOpen` 时未必已经挂上，所以画完再在下一帧补一次——
 * 幂等（每次都先清空），多画一次没有副作用。
 */
export function applyHeaderPath(
	host: HTMLElement,
	segments: HeaderSegment[],
	menuHost?: HeaderMenuHost,
): void {
	const render = (): void => {
		const parent = headerTitleParent(host);
		if (!parent) return;
		renderHeaderPath(parent, segments, menuHost);
	};
	render();
	window.requestAnimationFrame(render);
}
