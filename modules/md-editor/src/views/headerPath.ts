/**
 * 视图头部（标签页下面那条导航条）的完整路径面包屑。
 *
 * 虚拟文档树打开的文件不在库里，Obsidian 只给自定义视图留了一个**空的**
 * `.view-header-title-parent`（原生 FileView 会在这里放 `E2E /` 这样的目录链），
 * 于是标签页下面只剩一个文件名，看不出文件在磁盘上的位置。这里按原生 FileView
 * 的 DOM 结构补上「挂载名 / 子目录 / … /」，观感与库内笔记一致。
 */

import { Menu, Notice, TFile, setIcon } from 'obsidian';
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

/** 条目的 Material 图标（与虚拟文档树行同源），弹窗行用它替换原生 svg。 */
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

// --- 自绘同级弹窗 -----------------------------------------------------------
// 2026-11-03 起不再用 Obsidian Menu：同级列表动辄上百行，Menu 超高后把弹窗顶
// 满视口，鼠标一靠近上下边沿内容就自己滚（用户报"自动随鼠标滚动"），尺寸和
// 滚动条也不受控。自绘浮层（.lgp-hdr-sibpop，样式在根 styles.css）：
//   - 悬停绝不自动滚，只有滚轮和拖滚动条才动
//   - 宽度按窗口比例（30vw，320-640px 钳位）、高度最多 70vh（"按比例设置大小"）
//   - 内容超出出横竖两条滚动条；长文件名 nowrap 撑出横向

interface SibEntry {
	name: string;
	abs: string;
	isDir: boolean;
}

/** 当前打开的同级弹窗（全局最多一张：再点一段就换一张）。 */
let sibPopup: HTMLElement | null = null;

function closeSibPopup(): void {
	const el = sibPopup;
	if (!el) return;
	sibPopup = null;
	el.remove();
	document.removeEventListener('pointerdown', onDocPointerDown, true);
	document.removeEventListener('keydown', onDocKeyDown, true);
}

/** 点弹窗外才关；行右键弹的上下文菜单（真 .menu）浮在弹窗上，点它不关——
 *  关掉上下文菜单后同级弹窗还在（2026-10-29 用户要求）。 */
function onDocPointerDown(ev: PointerEvent): void {
	if (!sibPopup) return;
	const t = ev.target;
	if (t instanceof Element) {
		if (sibPopup.contains(t)) return;
		if (t.closest('.menu')) return;
	}
	closeSibPopup();
}

function onDocKeyDown(ev: KeyboardEvent): void {
	if (ev.key === 'Escape') closeSibPopup();
}

/**
 * 点某一段（或文件名）→ 弹窗列出**它的同级**，当前那一项高亮。
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
	closeSibPopup();

	const pop = document.createElement('div');
	pop.className = 'lgp-hdr-sibpop';
	const inner = document.createElement('div');
	inner.className = 'lgp-hdr-sibpop-inner';
	pop.appendChild(inner);

	// 首层条目：挂载名那一段列的是别的挂载，其余段列它所在目录的同级
	let entries: SibEntry[];
	if (target.isMount) {
		entries = [];
		for (const m of host.settings.externalMounts ?? []) {
			if (m.enabled === false) continue;
			const root = norm(m.path).replace(/\/+$/, '');
			entries.push({ name: m.label || root, abs: root, isDir: true });
		}
	} else {
		entries = listDir(target.viewDir ? target.abs : parentOf(target.abs));
	}
	if (!entries.length) {
		const empty = document.createElement('div');
		empty.className = 'lgp-hdr-pop-row is-disabled';
		empty.textContent = target.isMount ? '（没有挂载）' : '（空）';
		inner.appendChild(empty);
	}
	// 挂载那一段的弹窗里写的是挂载名（不是目录名），所以点亮也得按挂载名比。
	const currentName = target.isMount
		? (mountAtRoot(host, target.abs)?.label ?? '')
		: basenameOf(target.currentAbs);
	for (const entry of entries) inner.appendChild(popEntryRow(entry, 0, host, currentName));

	// 尾部动作（与原菜单一致：复制路径 / 在系统中显示）
	inner.appendChild(makePopSep());
	for (const act of [
		{
			icon: 'copy',
			label: '复制路径',
			run: () => {
				void navigator.clipboard?.writeText(norm(target.abs)).then(
					() => new Notice(`已复制路径：${norm(target.abs)}`),
					() => new Notice(`复制失败：${norm(target.abs)}`),
				);
			},
		},
		{ icon: 'folder-open', label: '在系统中显示', run: () => host.revealInSystem(target.abs) },
	]) {
		inner.appendChild(makePopActionRow(act.icon, act.label, act.run));
	}

	document.body.appendChild(pop);
	sibPopup = pop;
	document.addEventListener('pointerdown', onDocPointerDown, true);
	document.addEventListener('keydown', onDocKeyDown, true);

	// 锚在段的下方（外部给坐标就用坐标），量完实际宽高再钳回视口
	const rect = anchor.getBoundingClientRect();
	const x0 = typeof atX === 'number' ? atX : rect.left;
	const y0 = typeof atY === 'number' ? atY : rect.bottom + 2;
	const m = 8;
	const w = pop.offsetWidth;
	const h = pop.offsetHeight;
	pop.style.left = `${Math.max(m, Math.min(x0, window.innerWidth - w - m))}px`;
	pop.style.top = `${Math.max(m, Math.min(y0, window.innerHeight - h - m))}px`;
}

/**
 * 弹窗里的一行条目：文件夹带左侧三角，点三角或整行在**同一张弹窗里**就地
 * 展开/收起（子项插在自己后面，dataset.lgpChild 标记，收起时成串移除）；
 * 文件点击直接打开。右键弹这一行自己的文件夹/文件上下文菜单，同级弹窗不关。
 */
function popEntryRow(
	entry: SibEntry,
	depth: number,
	host: HeaderMenuHost,
	currentName: string,
): HTMLElement {
	const row = document.createElement('div');
	row.className = 'lgp-hdr-pop-row';
	// 每级 17px，与挂载面板树行一致；起点 8px 与菜单原生 padding 对齐，
	// 图标列逐级正好右移 17px
	row.style.paddingLeft = `${8 + depth * 17}px`;
	if (entry.name === currentName) row.addClass('lgp-hdr-current');

	if (entry.isDir) {
		const tw = document.createElement('div');
		tw.className = 'lgp-hdr-twisty';
		tw.textContent = '▶';
		tw.title = '展开这个文件夹';
		row.appendChild(tw);
		let expanded = false;
		const expand = (): void => {
			let ref: Element = row;
			for (const child of listDir(entry.abs)) {
				const childRow = popEntryRow(child, depth + 1, host, currentName);
				childRow.dataset['lgpChild'] = '1';
				ref.insertAdjacentElement('afterend', childRow);
				ref = childRow;
			}
		};
		const collapse = (): void => {
			let next: Element | null = row.nextElementSibling;
			while (next && (next as HTMLElement).dataset['lgpChild'] === '1') {
				const after: Element | null = next.nextElementSibling;
				next.remove();
				next = after;
			}
		};
		const toggle = (): void => {
			if (expanded) collapse();
			else expand();
			expanded = !expanded;
			tw.textContent = expanded ? '▼' : '▶';
		};
		tw.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			toggle();
		});
		row.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			toggle();
		});
	} else {
		// 文件没有三角，补一个同宽占位，图标列才与同层文件夹对齐（同树行）
		const g = document.createElement('div');
		g.className = 'lgp-hdr-gutter';
		row.appendChild(g);
		row.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			closeSibPopup();
			openFileEntry(host, entry.abs);
		});
	}

	const slot = document.createElement('div');
	slot.className = 'lgp-hdr-pop-icon';
	slot.appendChild(entryIcon(host, entry));
	row.appendChild(slot);

	const title = document.createElement('div');
	title.className = 'lgp-hdr-pop-title';
	title.textContent = entry.name;
	row.appendChild(title);

	// 右键：这一行自己的文件夹/文件上下文菜单。**不要关同级弹窗**：
	// 上下文菜单浮在它上面，关掉后弹窗还在（2026-10-29 用户要求）
	row.addEventListener('contextmenu', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		openEntryContextMenu(
			host, entry.abs, entry.name, entry.isDir,
			(ev as MouseEvent).clientX, (ev as MouseEvent).clientY, row,
		);
	});

	return row;
}

/** 弹窗分隔线（同级列表与尾部动作之间）。 */
function makePopSep(): HTMLElement {
	const sep = document.createElement('div');
	sep.className = 'lgp-hdr-pop-sep';
	return sep;
}

/** 尾部动作行（复制路径 / 在系统中显示），Obsidian 原图标。 */
function makePopActionRow(icon: string, label: string, run: () => void): HTMLElement {
	const row = document.createElement('div');
	row.className = 'lgp-hdr-pop-row lgp-hdr-pop-action';
	const slot = document.createElement('div');
	slot.className = 'lgp-hdr-pop-icon';
	setIcon(slot, icon);
	row.appendChild(slot);
	const title = document.createElement('div');
	title.className = 'lgp-hdr-pop-title';
	title.textContent = label;
	row.appendChild(title);
	row.addEventListener('click', (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		closeSibPopup();
		run();
	});
	return row;
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
	// 锁定态（虚拟树「文件名点击重命名」= 关）拦掉 mousedown 默认行为：焦点
	// 跟着 mousedown 走，不拦的话点击会把标题变成焦点元素（聚焦态），且核心
	// rename 模式对聚焦标题的响应会清空 .view-header-title-parent 的路径段
	// （用户 2026-11-05：点击不要有聚焦态、路径不要收缩）。解锁态不拦——
	// 重命名的点击聚焦照旧。锁标记由 virtual-tree 的 titleRename 观察器维护。
	title.addEventListener('mousedown', (ev) => {
		if (title.getAttribute('data-lgp-title-lock') === '1') ev.preventDefault();
	});
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

/**
 * 原生 markdown 视图的头部路径：与三个自定义视图同款的可点击面包屑 +
 * 文件名同级面板（用户 2026-11-03：原生编辑器打开库内或库外文件也一样）。
 *
 * 原生 markdown 自己会在 `.view-header-title-parent` 里画目录链，但不可点。
 * 这里替换成同结构的可点击版本；原生重写头部（打开/改名/布局变化）会把
 * 内容冲掉，调用方在 layout-change / active-leaf-change 上重复调用即可——
 * marker（lgpHdrFile）没变且我们的节点还在时跳过，变了就重画。
 *
 * 不传 paneMenuHost：右键回落到同级面板。外链菜单（paneMenuHost）是按库外
 * 文件装配的，库内笔记的改名/删除应走 Obsidian 原生右键，不冒充。
 */
export function applyNativeMarkdownHeaderPath(app: App, leaf: unknown, host: HeaderMenuHost): void {
	const view = (leaf as { view?: { getViewType?: () => string; file?: { path?: string }; containerEl?: HTMLElement } | null })
		?.view;
	if (!view || view.getViewType?.() !== 'markdown') return;
	const filePath = view.file?.path;
	if (!filePath) return;
	const container = view.containerEl;
	if (!container) return;
	const parent = container.querySelector<HTMLElement>('.view-header-title-parent');
	if (!parent) return;
	if (parent.dataset['lgpHdrFile'] === filePath && parent.querySelector('.lgp-hdr-crumb')) return;
	parent.dataset['lgpHdrFile'] = filePath;

	const external = /^file:/i.test(filePath);
	const full = external ? norm(filePath.slice(5)) : `${vaultRootOf(app)}/${filePath.replace(/^\//, '')}`;
	if (!full || full === '/') return;
	const m = matchMountFor(full, host.settings.externalMounts ?? []);
	const rel = m ? full.slice(norm(m.path).replace(/\/+$/, '').length + 1) : external ? basenameOf(full) : filePath;
	const segments = headerSegmentsFor(app, full, rel, '');
	applyHeaderPath(container, segments, host, full);
}
