/**
 * 视图头部（标签页下面那条导航条）的完整路径面包屑。
 *
 * 虚拟文档树打开的文件不在库里，Obsidian 只给自定义视图留了一个**空的**
 * `.view-header-title-parent`（原生 FileView 会在这里放 `E2E /` 这样的目录链），
 * 于是标签页下面只剩一个文件名，看不出文件在磁盘上的位置。这里按原生 FileView
 * 的 DOM 结构补上「挂载名 / 子目录 / … /」，观感与库内笔记一致。
 */

import { Menu, Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { scanExternal } from '../../../virtual-tree/src/features/extFs';
import { iconForEntry } from '../../../virtual-tree/src/features/iconTheme';
import { buildExternalPaneMenu, type PaneMenuHost } from '../../../virtual-tree/src/features/externalPaneMenu';
import { docTreeOf } from '../../../virtual-tree/src/main';

export interface HeaderSegment {
	/** 这一段显示的文字 */
	label: string;
	/** 这一段对应的磁盘绝对路径（悬浮提示，点击可展开同级） */
	abs: string;
	/** 挂载名那一段（它的同级是别的挂载，不是磁盘目录） */
	isMount?: boolean;
	/** 库根那一段「/」（点击列库根的顶层条目，不是同级） */
	isVaultRoot?: boolean;
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
	/** Material 图标主题解析需要 app（宿主即 plugin 实例，自带 app） */
	app: App;
	openExternalEntry(mount: ExternalMountLike, node: MountNodeLike): Promise<void>;
	revealInSystem(abs: string): void;
	/** 库外文件夹/文件的完整上下文菜单（重命名/删除/复制路径/系统操作 + 其
	 *  他插件的 file-menu 转发项）。右键面包屑段/文件名/菜单行时用它弹真正的
	 *  文件夹菜单或文件菜单；缺省时右键回退到同级路径面板。 */
	paneMenuHost?: PaneMenuHost;
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

/** Obsidian 库适配器的极小子集（拿库根的磁盘绝对路径）。 */
interface VaultAdapterLike {
	getFullPath?: (p: string) => string;
	basePath?: string;
}

/** 库根的磁盘绝对路径（无尾分隔符）。拿不到（适配器怪异）时返回空串。 */
export function vaultRootOf(app: App): string {
	const adapter = (app?.vault as { adapter?: VaultAdapterLike } | undefined)?.adapter;
	let base = '';
	if (adapter && typeof adapter.getFullPath === 'function') {
		try {
			base = String(adapter.getFullPath('') ?? '');
		} catch {
			/* fall through to basePath */
		}
	}
	if (!base) base = String(adapter?.basePath ?? '');
	return norm(base).replace(/\/+$/, '');
}

/**
 * 库内文件的路径段：首段是库根「/」，其后是库内子目录链。
 *
 * 库内代码文件（registerExtensions 路由进 ExternalCodeView）不在任何挂载下，
 * Obsidian 又不给自定义视图生成目录链——库根文件连一个段都没有，嵌套文件
 * 同样全空（2026-10-29 用户报：库根下的 .py 面包屑上没有根路径）。这里把
 * 路径画成绝对路径的样子：「/」+ 子目录 + 文件名（标题本身）。
 */
export function vaultSegments(vaultRoot: string, abs: string): HeaderSegment[] {
	const root = norm(vaultRoot).replace(/\/+$/, '');
	const full = norm(abs);
	if (!root || !full.toLowerCase().startsWith(root.toLowerCase() + '/')) return [];
	const parts = full.slice(root.length + 1).split('/');
	parts.pop(); // 最后一段是文件名本身，交给标题
	const out: HeaderSegment[] = [{ label: '/', abs: root, isVaultRoot: true }];
	let cur = root;
	for (const part of parts) {
		cur = `${cur}/${part}`;
		out.push({ label: part, abs: cur });
	}
	return out;
}

/**
 * 视图头部路径的统一入口：挂载文件走「挂载名 / 子目录」链（并标好 isMount），
 * 不在任何挂载下的文件按库内文件走「/ + 库内目录链」。
 *
 * 挂载优先于库：挂载可以指向库内子目录，此时它更具体，面包屑跟着挂载走。
 */
export function headerSegmentsFor(
	app: App,
	abs: string,
	rel: string,
	mountLabel: string,
): HeaderSegment[] {
	const full = norm(abs);
	if (!full) return [];
	const m = mountLabel ? null : matchMountFor(abs, docTreeOf(app)?.settings.externalMounts ?? []);
	if (mountLabel || m) {
		const segments = headerPathSegments(abs, rel, mountLabel || m?.label || '');
		if (segments.length) segments[0].isMount = true;
		return segments;
	}
	const vault = vaultRootOf(app);
	if (vault) return vaultSegments(vault, abs);
	// 连库根都定位不了：维持旧兜底（rel 里的子目录链，通常为空）
	return headerPathSegments(abs, rel, '');
}

/** 把路径段画成原生样式的 view-header 面包屑；重复调用会先清空。 */
export function renderHeaderPath(
	container: HTMLElement,
	segments: HeaderSegment[],
	host?: HeaderMenuHost,
): void {
	container.empty();
	for (const seg of segments) {
		// 库根段「/」用分隔符的样式画：整个面包屑读起来就是一条绝对路径
		const span = container.createSpan({
			cls: seg.isVaultRoot
				? 'view-header-breadcrumb view-header-breadcrumb-separator'
				: 'view-header-breadcrumb',
			text: seg.label,
		});
		span.setAttribute('aria-label', seg.label);
		span.setAttribute('draggable', 'true');
		span.title = `${seg.abs}（点击查看${seg.isVaultRoot ? '根目录' : '同级'}）`;
		if (host) {
			attachHeaderMenu(span, host, {
				abs: seg.abs,
				currentAbs: seg.abs,
				isMount: seg.isMount,
				// 库根没有「同级」：点它列库根的顶层条目
				viewDir: seg.isVaultRoot,
			});
		}
		// 库根段后面不再补分隔符——它自己就是那条「/」，再补就成了「/ /」
		if (!seg.isVaultRoot) {
			container.createSpan({ cls: 'view-header-breadcrumb-separator', text: '/' });
		}
	}
}

// --------------------------------------------------------------------------
// 点击某一段：弹出它的同级（VSCode 面包屑的同款交互）
// --------------------------------------------------------------------------

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

/** 菜单里点一个文件：挂载文件走虚拟文档树入口；库内文件走 Obsidian 打开
 *  （代码扩展名会按 registerExtensions 路由进代码视图）。 */
function openFileEntry(host: HeaderMenuHost, abs: string): void {
	const mount = findMount(host, abs);
	if (mount) {
		void host.openExternalEntry(mount, {
			name: basenameOf(abs),
			rel: relUnder(mount, abs) || basenameOf(abs),
			abs,
			isDir: false,
			children: [],
		});
		return;
	}
	const root = vaultRootOf(host.app);
	const full = norm(abs);
	if (!root || !full.toLowerCase().startsWith(root.toLowerCase() + '/')) return;
	const target = host.app.vault.getAbstractFileByPath(full.slice(root.length + 1));
	if (target instanceof TFile) void host.app.workspace.getLeaf(false).openFile(target);
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

/** 条目的 Material 图标（与虚拟文档树行同源），菜单里用它替换原生 svg。 */
function entryIcon(host: HeaderMenuHost, entry: { name: string; abs: string; isDir: boolean }): HTMLElement {
	const mount = findMount(host, entry.abs);
	return iconForEntry(host.app, {
		name: entry.name,
		isDir: entry.isDir,
		mountPath: mount?.path ?? '',
		rel: mount ? relUnder(mount, entry.abs) : entry.name,
		collapsed: entry.isDir,
		fallback: entry.isDir ? '\ud83d\udcc1' : '\ud83d\udcc4',
	});
}

/** 点什么东西弹出来的菜单：看谁的同级、点亮谁。 */
interface MenuTarget {
	/** 段 / 文件自己的路径 */
	abs: string;
	/** 菜单里要点亮的那一项（空 = 不点亮） */
	currentAbs: string;
	/** 挂载名那一段：同级是别的挂载，不是磁盘目录 */
	isMount?: boolean;
	/** 直接看这个目录里的内容（点三角展开时用），而不是它的同级 */
	viewDir?: boolean;
}

/**
 * 点某一段（或文件名）→ 菜单列出**它的同级**，当前那一项高亮。
 *
 * 高亮是整行底色 + 强调色，不用 setChecked：那个只放一个 ✓，语义是"已选中"，
 * 放在"你当前在这里"上会读成勾选项。
 */
function openHeaderMenu(
	anchor: HTMLElement,
	host: HeaderMenuHost,
	target: MenuTarget,
	atX?: number,
	atY?: number,
): void {
	const menu = new Menu();
	const entries: { name: string; abs: string; isDir: boolean }[] = [];
	// 点文件夹（名字或左侧三角）= 展开/收起，展开的行就地插在同一张菜单里，
	// 不换浮窗。addItem 时还拿不到 DOM，所以先记名字，等菜单挂上再回填。
	const toggles = new Map<string, () => void>();
	if (target.isMount) {
		addMountLevel(menu, host, entries, toggles);
	} else {
		const dirAbs = target.viewDir ? target.abs : parentOf(target.abs);
		addDirLevel(menu, host, dirAbs, entries, toggles, menu);
	}
	addTail(menu, host, target.abs);
	if (typeof atX === 'number' && typeof atY === 'number') {
		menu.showAtPosition({ x: atX, y: atY });
	} else {
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 2 });
	}
	// 挂载那一段的菜单里写的是挂载名（不是目录名），所以点亮也得按挂载名比。
	decorateMenu(
		menu,
		entries,
		host,
		toggles,
		target.isMount ? (mountAtRoot(host, target.abs)?.label ?? '') : basenameOf(target.currentAbs),
	);
}

/** 挂载根本身精确匹配（findMount 要求 abs 在挂载之下，对挂载根不成立）。 */
function mountAtRoot(host: HeaderMenuHost, rootAbs: string): ExternalMountLike | null {
	const want = norm(rootAbs).replace(/\/+$/, '').toLowerCase();
	for (const m of host.settings.externalMounts ?? []) {
		if (norm(m.path).replace(/\/+$/, '').toLowerCase() === want) return m;
	}
	return null;
}

/**
 * 右键：弹**真正的文件夹/文件上下文菜单**（重命名/删除/复制路径/系统操作 +
 * 其他插件的 file-menu 转发项），锚在鼠标位置——不是同级路径面板。
 * 被右键的项加高亮 class（menu.onHide 时移除）；没装配 paneMenuHost 时回退到
 * 同级面板（与左键同款）。
 */
export function openEntryContextMenu(
	host: HeaderMenuHost,
	abs: string,
	fileName: string,
	isDir: boolean,
	x: number,
	y: number,
	anchor?: HTMLElement,
): void {
	const menu = new Menu();
	if (anchor) {
		anchor.addClass('lgp-hdr-ctx-open');
		menu.onHide(() => anchor.removeClass('lgp-hdr-ctx-open'));
	}
	if (host.paneMenuHost) {
		buildExternalPaneMenu(host.paneMenuHost, menu, { abs, fileName, isDir });
	} else {
		// 回退：宿主没给 paneMenuHost（老装配）→ 同级面板也能用
		openHeaderMenu(document.body as HTMLElement, host, { abs, currentAbs: abs }, x, y);
		return;
	}
	menu.showAtPosition({ x, y });
}

/** 点某一段 / 文件名：左键同级菜单（VSCode 面包屑同款）；右键文件夹/文件菜单。 */
export function attachHeaderMenu(el: HTMLElement, host: HeaderMenuHost, target: MenuTarget): void {
	el.addClass('lgp-hdr-crumb');
	const openAt = (x?: number, y?: number): void => openHeaderMenu(el, host, target, x, y);
	el.addEventListener('click', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		openAt();
	});
	el.addEventListener('contextmenu', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		// 面包屑段全部是目录（文件名是独立标题，不在这里）→ 文件夹菜单
		openEntryContextMenu(host, target.abs, basenameOf(target.abs), true, ev.clientX, ev.clientY, el);
	});
}

/**
 * 菜单挂上 DOM 之后再补的两件事：
 *
 *  - 给"当前所在"那一项加高亮 class
 *  - 给文件夹项在**图标左侧**插一个三角，点它展开该文件夹
 *
 * 为什么只能事后补：`Menu.addItem` 返回的是 Menu 而不是 MenuItem，拿不到
 * 条目对象；而且 Menu 在 show 时会按 section 重排，插入序 ≠ DOM 顺序，所以
 * 只能按标题文本回找。
 */
function decorateMenu(
	menu: Menu,
	entries: { name: string; abs: string; isDir: boolean }[],
	host: HeaderMenuHost,
	toggles: Map<string, () => void>,
	currentName: string,
): void {
	const root = (menu as unknown as { dom?: HTMLElement }).dom;
	if (!root) return;
	window.requestAnimationFrame(() => {
		const items = Array.from(root.querySelectorAll<HTMLElement>('.menu-item')).filter(
			(el) => el.closest('.menu') === root,
		);
		for (const el of items) {
			const name = el.querySelector('.menu-item-title')?.textContent ?? '';
			if (currentName && name === currentName) el.addClass('lgp-hdr-current');
			const entry = entries.find((f) => f.name === name);
			if (entry) {
				// 图标换成与虚拟文档树行同源的 Material 图标
				const slot = el.querySelector('.menu-item-icon');
				if (slot) {
					slot.empty();
					slot.appendChild(entryIcon(host, entry));
				}
				// 右键：这一项自己的文件夹/文件上下文菜单。**不要 hide 同级面板**：
				// 上下文菜单浮在它上面，关掉后同级面板还在（2026-10-29 用户要求）
				el.addEventListener('contextmenu', (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					openEntryContextMenu(
						host, entry.abs, entry.name, entry.isDir,
						(ev as MouseEvent).clientX, (ev as MouseEvent).clientY, el,
					);
				});
				if (entry.isDir) addTwisty(el, entry.abs, host, toggles, menu, currentName, 0);
				else addGutter(el);
			}
		}
	});
}

/**
 * 文件夹项左侧的三角：点它（或点整行）在**同一张菜单里**就地展开子项，
 * 再点收起——不换浮窗，子项和同级的文件/文件夹一起列着，跟 VSCode 一样。
 *
 * 展开的行是手建的 DOM：Menu.show 之后 addItem 就不再生效了，只能自己往里插
 * 结构相同的 `.menu-item`。好处是这些行不在 Obsidian 的条目表里，点它们不会
 * 触发"点完就关菜单"，所以能一路展开下去。
 */
function addTwisty(
	itemEl: HTMLElement,
	dirAbs: string,
	host: HeaderMenuHost,
	toggles: Map<string, () => void>,
	menu: Menu,
	currentName: string,
	depth: number,
): void {
	if (itemEl.querySelector('.lgp-hdr-twisty')) return;
	const name = itemEl.querySelector('.menu-item-title')?.textContent ?? '';
	const tw = document.createElement('div');
	tw.className = 'menu-item-icon lgp-hdr-twisty';
	tw.textContent = '▶';
	tw.title = '展开这个文件夹';
	let expanded = false;

	const collapse = (): void => {
		let next: Element | null = itemEl.nextElementSibling;
		while (next && (next as HTMLElement).dataset['lgpChild'] === '1') {
			const after: Element | null = next.nextElementSibling;
			next.remove();
			next = after;
		}
	};

	const expand = (): void => {
		let ref: Element = itemEl;
		for (const entry of listDir(dirAbs)) {
			const row = makeRow(entry, depth + 1, host, toggles, menu, currentName);
			ref.insertAdjacentElement('afterend', row);
			ref = row;
		}
	};

	tw.addEventListener('click', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		if (expanded) collapse();
		else expand();
		expanded = !expanded;
		tw.textContent = expanded ? '▼' : '▶';
	});
	itemEl.insertBefore(tw, itemEl.firstChild);
	if (name) toggles.set(name, () => tw.click());
}

/** 文件项左侧的空占位：与三角同宽同位，文件图标才和同层文件夹图标对齐（同树行）。 */
function addGutter(itemEl: HTMLElement): void {
	if (itemEl.querySelector('.lgp-hdr-twisty, .lgp-hdr-gutter')) return;
	const g = document.createElement('div');
	g.className = 'menu-item-icon lgp-hdr-gutter';
	itemEl.insertBefore(g, itemEl.firstChild);
}

/** 一行展开出来的子项：文件夹带自己的三角，文件点击直接打开。 */
function makeRow(
	entry: { name: string; abs: string; isDir: boolean },
	depth: number,
	host: HeaderMenuHost,
	toggles: Map<string, () => void>,
	menu: Menu,
	currentName: string,
): HTMLElement {
	const row = document.createElement('div');
	row.className = 'menu-item tappable lgp-hdr-child';
	row.dataset['lgpChild'] = '1';
	// 每级 17px，与挂载面板树行一致；起点 8px 与菜单原生 padding 对齐，
	// 图标列逐级正好右移 17px
	row.style.paddingLeft = `${8 + depth * 17}px`;

	const icon = document.createElement('div');
	icon.className = 'menu-item-icon';
	icon.appendChild(entryIcon(host, entry));
	row.appendChild(icon);

	const title = document.createElement('div');
	title.className = 'menu-item-title';
	title.textContent = entry.name;
	row.appendChild(title);

	if (entry.name === currentName) row.addClass('lgp-hdr-current');

	// 右键：这一行自己的文件夹/文件上下文菜单。不 hide 同级面板——上下文
	// 菜单浮在它上面，关掉后同级面板还在（2026-10-29 用户要求）。
	row.addEventListener('contextmenu', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		openEntryContextMenu(
			host, entry.abs, entry.name, entry.isDir,
			(ev as MouseEvent).clientX, (ev as MouseEvent).clientY, row,
		);
	});

	if (entry.isDir) {
		// 三角要插在图标左侧，所以先建行再加
		window.requestAnimationFrame(() =>
			addTwisty(row, entry.abs, host, toggles, menu, currentName, depth),
		);
	} else {
		addGutter(row);
		row.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			menu.hide();
			openFileEntry(host, entry.abs);
		});
	}
	return row;
}

/** abs 是否严格位于挂载根之下（不等于根本身；分隔符/大小写归一后比较）。 */
export function isUnderMount(abs: string, mountRoot: string): boolean {
	const root = norm(mountRoot).replace(/\/+$/, '').toLowerCase();
	return !!root && norm(abs).toLowerCase().startsWith(root + '/');
}

/**
 * 按 abs 最长前缀在挂载配置里找回挂载（path + label）。
 *
 * 视图 state 缺 mountPath/mountLabel（部分打开入口不传、老页签恢复）时兜底：
 * 没有挂载根，`relativeDisplayPath` 会退成裸文件名，头部面包屑就丢掉挂载内的
 * 整段子目录链（2026-10-29 用户报：深 5 层的文件只剩「挂载名 / 文件名」，
 * 中间 4 层目录全没）。严格要求 abs 在挂载之下；并列时取更长的前缀。
 */
export function matchMountFor(
	abs: string,
	mounts: ExternalMountLike[],
): { path: string; label: string } | null {
	const full = norm(abs).toLowerCase();
	let best: { path: string; label: string } | null = null;
	let bestLen = -1;
	for (const m of mounts) {
		const root = norm(m.path).replace(/\/+$/, '').toLowerCase();
		if (!root || !full.startsWith(root + '/')) continue;
		if (root.length > bestLen) {
			bestLen = root.length;
			best = { path: m.path, label: m.label || '' };
		}
	}
	return best;
}

function parentOf(abs: string): string {
	const full = norm(abs);
	const i = full.lastIndexOf('/');
	return i > 0 ? full.slice(0, i) : full;
}

function basenameOf(abs: string): string {
	const full = norm(abs);
	const i = full.lastIndexOf('/');
	return i >= 0 ? full.slice(i + 1) : full;
}

function addTail(menu: Menu, host: HeaderMenuHost, abs: string): void {
	menu.addSeparator();
	menu.addItem((it) =>
		it.setTitle('复制路径').setIcon('copy').onClick(() => {
			void navigator.clipboard?.writeText(norm(abs)).then(
				() => new Notice(`已复制路径：${norm(abs)}`),
				() => new Notice(`复制失败：${norm(abs)}`),
			);
		}),
	);
	menu.addItem((it) =>
		it.setTitle('在系统中显示').setIcon('folder-open').onClick(() => host.revealInSystem(abs)),
	);
}

/** 挂载名那一段：同级是别的挂载，当前挂载高亮。 */
function addMountLevel(
	menu: Menu,
	host: HeaderMenuHost,
	entries: { name: string; abs: string; isDir: boolean }[],
	toggles: Map<string, () => void>,
): void {
	const mounts = (host.settings.externalMounts ?? []).filter((m) => m.enabled !== false);
	if (!mounts.length) {
		menu.addItem((it) => it.setTitle('（没有挂载）').setDisabled(true));
		return;
	}
	for (const m of mounts) {
		const root = norm(m.path).replace(/\/+$/, '');
		menu.addItem((it) => {
			const name = m.label || root;
			it.setTitle(name).setIcon('folder-open');
			// 挂载根也是目录：和普通文件夹一样记账 + 就地展开，
			// 点击不再弹系统文件管理器（tail 里本来就有“在系统中显示”）
			entries.push({ name, abs: root, isDir: true });
			it.onClick(() => toggles.get(name)?.());
			return it;
		});
	}
}

/** 一个目录里的条目：文件夹在前、文件在后。文件夹由调用方补左侧三角。 */
function addDirLevel(
	menu: Menu,
	host: HeaderMenuHost,
	dirAbs: string,
	entries: { name: string; abs: string; isDir: boolean }[],
	toggles: Map<string, () => void>,
	owner: Menu,
): void {
	const items = listDir(dirAbs);
	if (!items.length) {
		menu.addItem((it) => it.setTitle('（空）').setDisabled(true));
		return;
	}
	for (const entry of items) {
		menu.addItem((it) => {
			it.setTitle(entry.name).setIcon(entry.isDir ? 'folder' : fileIcon(entry.name));
			// 条目全部记账：文件夹补三角，文件补图标前的空占位（列对齐用）
			entries.push({ name: entry.name, abs: entry.abs, isDir: entry.isDir });
			if (entry.isDir) {
				// 三角（也就是展开动作）要等菜单挂上 DOM 才有，先按名字记账
				it.onClick(() => toggles.get(entry.name)?.());
			} else {
				it.onClick(() => {
					owner.hide();
					openFileEntry(host, entry.abs);
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
	fileAbs?: string,
): void {
	const render = (): void => {
		const parent = headerTitleParent(host);
		if (!parent) return;
		renderHeaderPath(parent, segments, menuHost);
		if (menuHost && fileAbs) attachTitleMenu(host, menuHost, fileAbs);
	};
	render();
	window.requestAnimationFrame(render);
}

/**
 * 文件名（标题）也点得动：左键弹它所在目录的同级（当前文件高亮），右键弹
 * 这个文件的上下文菜单（重命名/删除/复制路径/系统操作）。
 * 标题节点由框架持有、每次 setState 复用，所以只挂一次监听。
 */
function attachTitleMenu(host: HTMLElement, menuHost: HeaderMenuHost, fileAbs: string): void {
	const title = host.querySelector<HTMLElement>('.view-header-title');
	if (!title) return;
	if (title.dataset['lgpHdrMenu'] === '1') return;
	title.dataset['lgpHdrMenu'] = '1';
	title.title = `${norm(fileAbs)}（点击查看同级，右键文件菜单）`;
	title.addClass('lgp-hdr-crumb');
	title.addEventListener('click', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		openHeaderMenu(title, menuHost, { abs: fileAbs, currentAbs: fileAbs });
	});
	title.addEventListener('contextmenu', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		openEntryContextMenu(
			menuHost, fileAbs, basenameOf(fileAbs), false,
			(ev as MouseEvent).clientX, (ev as MouseEvent).clientY, title,
		);
	});
}
