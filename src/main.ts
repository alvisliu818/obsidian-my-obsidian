import { MarkdownView, Plugin, TFile, addIcon, setIcon } from "obsidian";
import { buildHeadingTree, chainTo, childrenOf, siblingsOf } from "./headingTree";
import { BreadcrumbNavSettingTab } from "./settings";
import { DEFAULT_SETTINGS } from "./types";
import type { BreadcrumbNavSettings, HeadingNode, HeadingTree, MenuEntry } from "./types";

const ICON_ON = "breadcrumb-nav";
const ICON_OFF = "breadcrumb-nav-off";

const ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100" height="100" ' +
	'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
	'<rect x="2.5" y="9" width="4.5" height="6" rx="1"/>' +
	'<rect x="9.75" y="9" width="4.5" height="6" rx="1"/>' +
	'<rect x="17" y="9" width="4.5" height="6" rx="1"/>' +
	'<path d="M7 12h2.75M14.25 12H17"/></svg>';

const ICON_SVG_OFF =
	ICON_SVG.slice(0, -6) +
	'<line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="1.7"/></svg>';

const HOVER_DELAY = 160;
const HIDE_DELAY = 220;
/** 程序化跳转后的一段时间内，不把「光标移动」当成用户主动切换（否则会清掉下钻状态） */
const JUMP_GUARD = 600;
const TAG_CACHE_TTL = 10000;

/** obsidian-logseq 大纲编辑器视图（自定义视图，非 MarkdownView）的鸭子类型。
 *  它把「根 → 当前聚焦块」的路径维护在 contentEl.__lgFocusPath（文字）和
 *  __lgFocusBlocks（块对象链，与文字一一对应）上；__lgRoots 是当前缩放层级的
 *  根块列表（空路径时下一级菜单用），__lgTopBlocks 是文档顶层块（第 0 级的
 *  同级菜单用）。 */
const LOGSEQ_VIEW_TYPE = "logseq-block-editor";
/** obsidian-logseq Block 的极小子集（面包屑只读 text / children / parent） */
interface LgBlockLike {
	text: string;
	children: LgBlockLike[];
	parent?: LgBlockLike | null;
}
interface LogseqBlockView {
	contentEl: HTMLElement & {
		__lgFocusPath?: string[];
		__lgFocusBlocks?: LgBlockLike[];
		__lgRoots?: LgBlockLike[];
		__lgTopBlocks?: LgBlockLike[];
	};
	file: TFile | null;
	getViewType(): string;
	/** 聚焦某块（光标落进去）——面包屑路径随之截断到该级 */
	focusBlock?: (b: LgBlockLike, pos?: number | string) => void;
	/** 缩放到某块（null = 回到页面根） */
	zoomTo?: (b: LgBlockLike | null) => void;
}

/** 能挂面包屑的视图：原生 Markdown 视图或 logseq 大纲视图 */
type BarView = MarkdownView | LogseqBlockView;
/** CodeMirror 6 EditorView 的极小子集，避免直接依赖 CM 类型 */
interface CmLike {
	scrollDOM?: HTMLElement;
	contentDOM?: HTMLElement;
	coordsAtPos?: (pos: number) => { top: number } | null | undefined;
	domAtPos?: (pos: number) => { node: Node | null } | null;
	lineBlockAt?: (pos: number) => { top: number } | null;
	dispatch?: (spec: { effects?: unknown }) => void;
}

/** 悬浮菜单的一层；level 0 是根菜单，1 是它的子菜单，以此类推 */
interface PopupLayer {
	el: HTMLElement;
	/** 该层依附的元素：根层是面包屑上的项，子层是父菜单里的条目 */
	anchor: HTMLElement;
	level: number;
}

/** @codemirror/view 的极小子集；Obsidian 在运行时提供该模块 */
interface CmViewModule {
	EditorView?: {
		scrollIntoView?: (
			pos: number,
			options: { y?: string; yMargin?: number }
		) => unknown;
	};
}

let cmViewCache: CmViewModule | null | undefined;
function loadCmView(): CmViewModule | null {
	if (cmViewCache !== undefined) return cmViewCache;
	cmViewCache = null;
	try {
		cmViewCache = require("@codemirror/view") as CmViewModule;
	} catch (e) {
		cmViewCache = null; // 宿主未提供，走手动计算兜底
	}
	return cmViewCache;
}

const NAV_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	"Enter",
]);

export default class BreadcrumbNavPlugin extends Plugin {
	settings: BreadcrumbNavSettings = DEFAULT_SETTINGS;

	private ribbonEl: HTMLElement | null = null;
	/** 活动视图的面包屑（算吸顶高度、下钻后重新弹菜单都用它） */
	private barEl: HTMLElement | null = null;
	/**
	 * 每个笔记视图一条：host（view.contentEl）→ bar。
	 * 各自独立占位，切换视图 / 切到非笔记视图再切回来时正文不会上下跳。
	 */
	private bars: Map<HTMLElement, HTMLElement> = new Map();
	/** 已挂 lgp-block-focus 监听的 logseq 视图宿主（每个视图只挂一次） */
	private wiredLogseqHosts: Set<HTMLElement> = new Set();
	private nextIconEl: HTMLElement | null = null;
	private nextEntriesProvider: (() => MenuEntry[]) | null = null;

	/** 当前展开的菜单层（栈底是根菜单）；空数组表示没有菜单 */
	private popups: PopupLayer[] = [];
	private showTimer: number | null = null;
	private hideTimer: number | null = null;
	private scrollRaf: number | null = null;

	/** 手动下钻选中的标题（作为面包屑末尾，可继续下钻） */
	private focalKey: string | null = null;
	private lastJumpAt = 0;
	private refreshTimer: number | null = null;
	private tagIndex: { time: number; map: Map<string, Set<string>> } | null = null;

	// ============ 生命周期 ============
	async onload(): Promise<void> {
		await this.loadSettings();

		addIcon(ICON_ON, ICON_SVG);
		addIcon(ICON_OFF, ICON_SVG_OFF);

		this.addSettingTab(new BreadcrumbNavSettingTab(this.app, this));

		this.ribbonEl = this.addRibbonIcon(ICON_ON, "面包屑导航：开 / 关", () => {
			void this.toggleEnabled();
		});
		this.refreshRibbon();

		this.addCommand({
			id: "toggle-breadcrumb-nav",
			name: "启用 / 停用面包屑导航",
			callback: () => void this.toggleEnabled(),
		});
		this.addCommand({
			id: "refresh-breadcrumb-nav",
			name: "刷新面包屑导航",
			callback: () => this.scheduleRefresh(0),
		});

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.resetFollow();
				this.scheduleRefresh(150);
			})
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetFollow();
				this.scheduleRefresh(150);
			})
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh(200)));
		this.registerEvent(
			this.app.metadataCache.on("changed", () => {
				this.tagIndex = null;
				this.scheduleRefresh(250);
			})
		);
		this.registerEvent(this.app.workspace.on("editor-change", () => this.onFollowTrigger()));

		this.listen(window, "scroll", this.onWindowScroll, true);
		this.listen(window, "mousedown", this.onWindowMouseDown, true);
		this.listen(window, "keydown", this.onWindowKeyDown, true);

		this.scheduleRefresh(600);
	}

	onunload(): void {
		this.removeBars();
		this.closePopups();
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	// ============ 设置 ============
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async toggleEnabled(): Promise<void> {
		this.settings.enabled = !this.settings.enabled;
		await this.saveSettings();
		this.refreshRibbon();
		if (this.settings.enabled) this.scheduleRefresh(0);
		else this.removeBars();
	}

	refreshRibbon(): void {
		if (!this.ribbonEl) return;
		setIcon(this.ribbonEl, this.settings.enabled ? ICON_ON : ICON_OFF);
	}

	// ============ 事件 ============
	private listen<K extends keyof WindowEventMap>(
		target: Window,
		type: K,
		handler: (ev: WindowEventMap[K]) => void,
		capture = false
	): void {
		const listener = handler as EventListener;
		target.addEventListener(type, listener, capture);
		this.register(() => target.removeEventListener(type, listener, capture));
	}

	/** 用户主动动光标/滚动 → 回到「跟随当前位置」模式 */
	private onFollowTrigger(): void {
		if (!this.settings.followCursor) return;
		if (Date.now() - this.lastJumpAt < JUMP_GUARD) return;
		if (this.focalKey !== null) {
			this.focalKey = null;
			this.scheduleRefresh(0);
			return;
		}
		this.scheduleRefresh(250);
	}

	private resetFollow(): void {
		this.focalKey = null;
	}

	private onWindowScroll = (ev: Event): void => {
		if (this.popups.length) {
			if (this.scrollRaf === null) {
				this.scrollRaf = window.requestAnimationFrame(() => {
					this.scrollRaf = null;
					this.repositionPopups();
				});
			}
			// 菜单内部滚动不关闭、也不触发跟随
			const target = ev.target as Node | null;
			if (target && this.containsPopup(target)) return;
		}
		this.onFollowTrigger();
	};

	private onWindowMouseDown = (ev: MouseEvent): void => {
		const target = ev.target as Node | null;
		if (target && this.containsPopup(target)) return;
		this.closePopups();
		const el = ev.target as HTMLElement | null;
		if (el && el.closest && el.closest(".markdown-source-view, .markdown-preview-view")) {
			this.onFollowTrigger();
		}
	};

	private onWindowKeyDown = (ev: KeyboardEvent): void => {
		if (ev.key === "Escape") {
			this.closePopups();
			return;
		}
		if (NAV_KEYS.has(ev.key)) this.onFollowTrigger();
	};

	scheduleRefresh(delay = 200): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, delay);
	}

	// ============ 构建面包屑 ============
	async refresh(): Promise<void> {
		if (!this.settings.enabled) {
			this.removeBars();
			return;
		}

		const active = this.getActiveBarView();
		const views = this.collectBarViews(active);

		if (!views.length) {
			// 停在新建标签页 / 看板这类非笔记视图：只回收已关闭视图的面包屑，
			// 其余保留占位，切回笔记时正文位置不变
			this.pruneDetached();
			return;
		}

		const live = new Set<HTMLElement>();
		views.forEach((view) => {
			live.add(view.contentEl);
			this.renderBar(view, view === active);
		});
		this.pruneBars(live);
	}

	/** 活动视图（若它可挂面包屑）：优先 Markdown（含测试桩），logseq 视图走 activeLeaf */
	private getActiveBarView(): BarView | null {
		const md = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (md) return md;
		const v = this.app.workspace.activeLeaf?.view;
		if (v && this.isLogseqView(v)) return v;
		return null;
	}

	/** 所有打开的可挂面包屑视图（不止活动那个）；活动视图排在最前 */
	private collectBarViews(active: BarView | null): BarView[] {
		const out: BarView[] = [];
		const push = (v: unknown): void => {
			if (out.indexOf(v as BarView) >= 0) return;
			if (this.isMarkdownView(v) || this.isLogseqView(v)) out.push(v as BarView);
		};
		push(active);
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => push(leaf.view));
		this.app.workspace.getLeavesOfType(LOGSEQ_VIEW_TYPE).forEach((leaf) => push(leaf.view));
		return out;
	}

	/** 鸭子类型判断：测试桩里的视图不是 MarkdownView 实例，不能直接用 instanceof */
	private isMarkdownView(v: unknown): v is MarkdownView {
		if (!v || typeof v !== "object") return false;
		const c = v as Partial<MarkdownView>;
		return !!c.file && !!c.contentEl && typeof c.getMode === "function";
	}

	/** logseq 大纲编辑器视图（obsidian-logseq 插件的自定义视图） */
	private isLogseqView(v: unknown): v is LogseqBlockView {
		if (!v || typeof v !== "object") return false;
		const c = v as Partial<LogseqBlockView> & { getViewType?: () => string };
		return c.getViewType?.() === LOGSEQ_VIEW_TYPE && !!c.contentEl;
	}

	private renderBar(view: BarView, isActive: boolean): void {
		if (this.isLogseqView(view)) {
			this.renderLogseqBar(view, isActive);
			return;
		}
		const file = view.file;
		if (!file) return;
		this.closePopups();

		const cache = this.app.metadataCache.getFileCache(file);
		const tree = buildHeadingTree(cache ? cache.headings : undefined);

		// 内容变化后旧的 focal 可能已不存在（focal 下钻态只属于活动视图）；
		// 必须先清掉失效的 focal 再取值，否则会拿上一个笔记的 key 去查这棵树
		if (isActive && this.focalKey !== null && !tree.byKey.has(this.focalKey)) {
			this.focalKey = null;
		}
		const focal = isActive ? this.focalKey : null;

		const currentKey = this.getCurrentHeadingKey(view, tree);

		let chain: HeadingNode[] = [];
		if (focal !== null) {
			chain = chainTo(tree.byKey.get(focal) ?? null, true);
		} else if (currentKey !== null) {
			chain = chainTo(tree.byKey.get(currentKey) ?? null, this.settings.includeCurrentHeading);
		}

		// 末尾 ▸ 的数据源：有标题链时取最后一级的子标题，否则取顶层标题
		const nextKey = chain.length ? chain[chain.length - 1].key : null;
		const nextChildren = this.settings.enableNextLevel ? childrenOf(tree, nextKey) : [];

		const host = view.contentEl;
		let bar = this.bars.get(host);
		if (!bar) {
			bar = document.createElement("div");
			this.bars.set(host, bar);
		}
		// id 只给活动视图，避免多栏时出现重复 id
		if (isActive) bar.id = "bcn-bar";
		else if (bar.id) bar.removeAttribute("id");
		bar.className = "bcn-bar" + (this.settings.sticky ? " bcn-sticky" : "");
		bar.textContent = "";
		if (isActive) this.barEl = bar;

		// —— 首项：文件名（常驻） ——
		const pageEl = document.createElement("span");
		pageEl.className = "bcn-item bcn-page";
		pageEl.textContent = file.basename;
		pageEl.title = file.path;
		pageEl.addEventListener("click", () => {
			this.scrollToTop(view);
		});
		if (this.settings.enableRelatedPages) {
			this.attachHover(pageEl, () => this.getRelatedPageEntries(file));
		}
		bar.appendChild(pageEl);

		// —— 标题链 ——
		chain.forEach((node) => {
			bar.appendChild(this.createSeparator());
			const el = document.createElement("span");
			el.className = "bcn-item" + (node.key === currentKey ? " bcn-active" : "");
			el.textContent = this.truncate(node.heading.heading || "(无标题)");
			el.title = node.heading.heading;
			el.addEventListener("click", () => {
				// 点击某一级：跳过去，并把路径截短到该级
				this.focalKey = node.key;
				this.closePopups();
				this.jumpToHeading(view, tree, node);
				this.scheduleRefresh(0);
			});
			if (this.settings.enableSiblingsMenu) {
				// 高亮「本级所在的那一支」：即被悬浮的这一级本身
				this.attachHover(el, () =>
					this.headingEntries(view, tree, siblingsOf(tree, node.key), node.key)
				);
			}
			bar.appendChild(el);
		});

		// —— 末尾的 ▸：下一级 ——
		if (isActive) {
			this.nextIconEl = null;
			this.nextEntriesProvider = null;
		}
		if (nextChildren.length) {
			bar.appendChild(this.createSeparator());
			const icon = document.createElement("span");
			icon.className = "bcn-next";
			icon.textContent = "▸";
			icon.title = "下一级";
			const provider = () => this.headingEntries(view, tree, nextChildren, currentKey);
			this.attachHover(icon, provider);
			icon.addEventListener("click", (ev) => {
				ev.stopPropagation();
				// 该 ▸ 自己弹出的菜单，再点一次收起；否则（别的锚点开着菜单）改为弹它自己的
				const root = this.popups[0];
				if (root && root.anchor === icon) {
					this.closePopups();
					return;
				}
				this.showPopup(icon, provider());
			});
			bar.appendChild(icon);
			// 下钻后重新弹菜单只发生在活动视图，所以只记录它的 ▸
			if (isActive) {
				this.nextIconEl = icon;
				this.nextEntriesProvider = provider;
			}
		}

		if (bar.parentElement !== host) host.insertBefore(bar, host.firstChild);
	}

	/**
	 * logseq 大纲视图的面包屑：文件名 › 块层级路径（根 → 当前聚焦块）。
	 * 路径由 obsidian-logseq 实时维护在 contentEl.__lgFocusPath / __lgFocusBlocks
	 * （聚焦、缩放、结构变化时更新）；交互对齐 markdown 版 renderBar：点某级 =
	 * 聚焦该块（路径截断到该级），悬浮弹同级块菜单，末尾 ▸ 弹下一级。
	 */
	private renderLogseqBar(view: LogseqBlockView, isActive: boolean): void {
		const file = view.file;
		if (!file) return;
		this.closePopups();

		// logseq 视图在聚焦/失焦/结构变化时派发 lgp-block-focus（路径同步在
		// contentEl.__lgFocusPath 上）——监听一次，实时刷新面包屑位置。
		const host = view.contentEl;
		if (!this.wiredLogseqHosts.has(host)) {
			this.wiredLogseqHosts.add(host);
			host.addEventListener("lgp-block-focus", () => {
				if (!host.isConnected) {
					this.wiredLogseqHosts.delete(host);
					return;
				}
				this.refresh();
			});
		}

		const chain = view.contentEl.__lgFocusBlocks ?? [];
		const path = view.contentEl.__lgFocusPath ?? [];

		let bar = this.bars.get(host);
		if (!bar) {
			bar = document.createElement("div");
			this.bars.set(host, bar);
		}
		if (isActive) bar.id = "bcn-bar";
		else if (bar.id) bar.removeAttribute("id");
		bar.className = "bcn-bar" + (this.settings.sticky ? " bcn-sticky" : "");
		bar.textContent = "";
		if (isActive) {
			this.barEl = bar;
			this.nextIconEl = null;
			this.nextEntriesProvider = null;
		}

		// —— 首项：文件名（点击回到页面顶部） ——
		const pageEl = document.createElement("span");
		pageEl.className = "bcn-item bcn-page";
		pageEl.textContent = file.basename;
		pageEl.title = file.path;
		pageEl.addEventListener("click", () => {
			this.lastJumpAt = Date.now();
			this.closePopups();
			view.zoomTo?.(null);
			const sc = view.contentEl.querySelector<HTMLElement>(".block-editor-scroller") ?? view.contentEl;
			sc.scrollTop = 0;
			this.scheduleRefresh(0);
		});
		if (this.settings.enableRelatedPages) {
			this.attachHover(pageEl, () => this.getRelatedPageEntries(file));
		}
		bar.appendChild(pageEl);

		// —— 块层级路径 ——
		chain.forEach((b, i) => {
			bar.appendChild(this.createSeparator());
			const el = document.createElement("span");
			el.className = "bcn-item" + (i === chain.length - 1 ? " bcn-active" : "");
			const label = path[i] || "·";
			el.textContent = this.truncate(label);
			el.title = label;
			// 点击某一级：聚焦该块，路径截短到该级
			el.addEventListener("click", () => {
				this.closePopups();
				view.focusBlock?.(b);
				this.scheduleRefresh(0);
			});
			if (this.settings.enableSiblingsMenu) {
				// 高亮「本级所在的那一支」：即被悬浮的这一级本身
				this.attachHover(el, () => {
					const siblings = i > 0 ? chain[i - 1].children : (view.contentEl.__lgTopBlocks ?? []);
					return this.lgBlockEntries(view, siblings, b);
				});
			}
			bar.appendChild(el);
		});

		// —— 末尾的 ▸：下一级 ——
		const nextChildren = this.settings.enableNextLevel
			? chain.length
				? chain[chain.length - 1].children
				: (view.contentEl.__lgRoots ?? [])
			: [];
		if (nextChildren.length) {
			bar.appendChild(this.createSeparator());
			const icon = document.createElement("span");
			icon.className = "bcn-next";
			icon.textContent = "▸";
			icon.title = "下一级";
			const provider = () =>
				this.lgBlockEntries(view, nextChildren, chain.length ? chain[chain.length - 1] : null);
			this.attachHover(icon, provider);
			icon.addEventListener("click", (ev) => {
				ev.stopPropagation();
				// 该 ▸ 自己弹出的菜单，再点一次收起；否则（别的锚点开着菜单）改为弹它自己的
				const root = this.popups[0];
				if (root && root.anchor === icon) {
					this.closePopups();
					return;
				}
				this.showPopup(icon, provider());
			});
			bar.appendChild(icon);
			// 下钻后重新弹菜单只发生在活动视图，所以只记录它的 ▸
			if (isActive) {
				this.nextIconEl = icon;
				this.nextEntriesProvider = provider;
			}
		}

		if (bar.parentElement !== host) host.insertBefore(bar, host.firstChild);
	}

	/** logseq 块菜单条目：点文本 = 聚焦该块（路径变为它那条链）；点 ▸ = 聚焦并把
	 *  它的下一级菜单立即展开（下钻，等价 markdown 版 onDrill）。 */
	private lgBlockEntries(view: LogseqBlockView, blocks: LgBlockLike[], active: LgBlockLike | null): MenuEntry[] {
		return blocks.map((b, idx) => {
			const first = (b.text || "").split("\n")[0] || "·";
			return {
				key: "lg:" + idx + ":" + first,
				text: this.truncate(first),
				active: b === active,
				hasChildren: b.children.length > 0,
				onSelect: () => {
					this.closePopups();
					view.focusBlock?.(b);
					this.scheduleRefresh(0);
				},
				onDrill: () => {
					this.closePopups();
					view.focusBlock?.(b);
					void (async () => {
						await this.refresh();
						if (this.nextIconEl && this.nextEntriesProvider) {
							this.showPopup(this.nextIconEl, this.nextEntriesProvider());
						}
					})();
				},
				children: b.children.length ? () => this.lgBlockEntries(view, b.children, active) : undefined,
			};
		});
	}

	private createSeparator(): HTMLElement {
		const sep = document.createElement("span");
		sep.className = "bcn-sep";
		sep.textContent = "›";
		return sep;
	}

	private removeBars(): void {
		this.closePopups();
		this.bars.forEach((bar) => bar.remove());
		this.bars.clear();
		this.barEl = null;
		this.nextIconEl = null;
		this.nextEntriesProvider = null;
	}

	/** 关掉视图 / 不再是笔记视图的那些，回收掉，别留下孤儿占位 */
	private pruneBars(live: Set<HTMLElement>): void {
		let removed = false;
		this.bars.forEach((bar, host) => {
			if (live.has(host)) return;
			bar.remove();
			this.bars.delete(host);
			if (this.barEl === bar) this.barEl = null;
			removed = true;
		});
		if (removed) this.closePopups();
	}

	/** 没有活动笔记视图时：只清掉宿主已脱离文档的那些，其余继续占位 */
	private pruneDetached(): void {
		let removed = false;
		this.bars.forEach((bar, host) => {
			if (document.contains(host)) return;
			bar.remove();
			this.bars.delete(host);
			if (this.barEl === bar) this.barEl = null;
			removed = true;
		});
		if (removed) this.closePopups();
	}

	// ============ 菜单条目 ============
	private headingEntries(
		view: MarkdownView,
		tree: HeadingTree,
		nodes: HeadingNode[],
		activeKey: string | null
	): MenuEntry[] {
		return nodes.map((node) => ({
			key: node.key,
			text: this.truncate(node.heading.heading || "(无标题)"),
			active: node.key === activeKey,
			hasChildren: node.children.length > 0,
			// 点文本：跳转并回到跟随模式
			onSelect: () => {
				this.focalKey = null;
				this.closePopups();
				this.jumpToHeading(view, tree, node);
				this.scheduleRefresh(0);
			},
			// 点 ▸：该项追加为面包屑末尾，并立即展开它的下一级
			onDrill: () => {
				this.focalKey = node.key;
				this.closePopups();
				this.jumpToHeading(view, tree, node);
				void (async () => {
					await this.refresh();
					if (this.nextIconEl && this.nextEntriesProvider) {
						this.showPopup(this.nextIconEl, this.nextEntriesProvider());
					}
				})();
			},
			// 悬浮 ▸：不用点，直接把它的下一级铺开成子菜单
			children: node.children.length
				? () => this.headingEntries(view, tree, node.children, activeKey)
				: undefined,
		}));
	}

	// ============ 当前位置 ============
	private getCurrentHeadingKey(view: MarkdownView, tree: HeadingTree): string | null {
		if (!tree.flat.length) return null;

		if (view.getMode() === "source") {
			const line = view.editor.getCursor().line;
			let found: HeadingNode | null = null;
			for (const node of tree.flat) {
				if (node.heading.position.start.line <= line) found = node;
				else break;
			}
			return found ? found.key : null;
		}

		// 阅读模式：按滚动位置找最后一个已滚过的标题
		const previewEl = view.contentEl.querySelector<HTMLElement>(".markdown-preview-view");
		if (!previewEl) return null;
		const els = Array.from(previewEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
		if (!els.length) return null;

		const scroller = view.contentEl;
		const scrollTop = this.getPreviewScroll(view);
		const base = scroller.getBoundingClientRect().top;
		let idx = -1;
		for (let i = 0; i < els.length; i++) {
			const top = els[i].getBoundingClientRect().top - base + scrollTop;
			if (top - 12 <= scrollTop) idx = i;
			else break;
		}
		if (idx < 0) return null;
		const node = tree.flat[Math.min(idx, tree.flat.length - 1)];
		return node ? node.key : null;
	}

	private getPreviewScroll(view: MarkdownView): number {
		const pm = view.previewMode as unknown as { getScroll?: () => number } | undefined;
		if (pm && typeof pm.getScroll === "function") {
			const value = pm.getScroll();
			if (typeof value === "number") return value;
		}
		return view.contentEl.scrollTop;
	}

	// ============ 跳转 ============
	/** 目标标题落在滚动容器顶部下方多少像素：吸顶面包屑的高度 + 一点间距 */
	private barInset(): number {
		return (this.barEl ? this.barEl.offsetHeight : 0) + 8;
	}

	private jumpToHeading(view: MarkdownView, tree: HeadingTree, node: HeadingNode): void {
		this.lastJumpAt = Date.now();
		const inset = this.barInset();
		try {
			if (view.getMode() === "source") {
				const pos = { line: node.heading.position.start.line, ch: 0 };
				view.editor.setCursor(pos);
				// 先保证目标行进入视口，再对齐到顶部
				view.editor.scrollIntoView({ from: pos, to: pos }, false);
			const cm = (view.editor as unknown as { cm?: CmLike }).cm;
			this.alignLineToTop(view, cm ?? null, cm ? view.editor.posToOffset(pos) : -1, inset);
			return;
			}
			this.scrollHeadingToTop(view, tree, node, inset);
		} catch (e) {
			/* 视图已切换，忽略 */
		}
	}

	/**
	 * 实时预览 / 源码模式：把目标行对齐到滚动容器顶部，而不是居中。
	 * 三条路径依次降级：CM 原生 scrollIntoView effect → 视口坐标手算 → lineBlockAt 手算。
	 */
	private alignLineToTop(
		view: MarkdownView,
		cm: CmLike | null,
		offset: number,
		inset: number
	): void {
		if (!cm || offset < 0) return;

		// 1) CodeMirror 原生：y: "start" + yMargin 就是「距容器顶部 inset 像素」
		const cmView = loadCmView();
		const scrollEffect = cmView && cmView.EditorView && cmView.EditorView.scrollIntoView;
		if (scrollEffect && typeof cm.dispatch === "function") {
			cm.dispatch({ effects: scrollEffect.call(cmView.EditorView, offset, { y: "start", yMargin: inset }) });
			return;
		}

		// 2) 兜底：自己找滚动容器并换算
		const scroller = this.findScrollParent(cm.scrollDOM) ?? view.contentEl;
		const apply = (): void => {
			const lineTop = this.lineViewportTop(cm, offset);
			if (lineTop === null) return;
			const delta = lineTop - (scroller.getBoundingClientRect().top + inset);
			if (Math.abs(delta) < 1) return;
			scroller.scrollTop += delta;
		};
		apply();
		// CM / Obsidian 有时会在下一帧再修正一次滚动，量一次再校正
		window.requestAnimationFrame(() => apply());
	}

	/** 目标行在视口中的 top（像素）：coordsAtPos → lineBlockAt → DOM 上找 .cm-line */
	private lineViewportTop(cm: CmLike, offset: number): number | null {
		if (typeof cm.coordsAtPos === "function") {
			const coords = cm.coordsAtPos(offset);
			if (coords && typeof coords.top === "number") return coords.top;
		}
		if (typeof cm.lineBlockAt === "function" && cm.contentDOM) {
			const block = cm.lineBlockAt(offset);
			if (block && typeof block.top === "number") {
				// block.top 相对内容元素顶端；内容元素顶端此刻的视口坐标即 contentDOM.rect.top
				return cm.contentDOM.getBoundingClientRect().top + block.top;
			}
		}
		const line = this.lineElementAt(cm, offset);
		return line ? line.getBoundingClientRect().top : null;
	}

	/** 阅读模式：按标题元素位置直接算出目标滚动量 */
	private scrollHeadingToTop(
		view: MarkdownView,
		tree: HeadingTree,
		node: HeadingNode,
		inset: number
	): void {
		const previewEl = view.contentEl.querySelector<HTMLElement>(".markdown-preview-view");
		if (!previewEl) return;
		const els = Array.from(previewEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
		const el = els[tree.flat.indexOf(node)];
		if (!el) return;
		const scroller = this.findScrollParent(el) ?? view.contentEl;
		const top =
			el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
		scroller.scrollTop = Math.max(0, top - inset);
	}

	/** 从 cm 里取出目标行所在的 .cm-line 元素 */
	private lineElementAt(cm: CmLike, offset: number): HTMLElement | null {
		if (typeof cm.domAtPos !== "function") return null;
		const info = cm.domAtPos(offset);
		const raw = info ? info.node : null;
		const el = raw ? ((raw.nodeType === 3 ? raw.parentElement : raw) as HTMLElement | null) : null;
		return el && el.closest ? (el.closest(".cm-line") as HTMLElement | null) : null;
	}

	/** 从元素往上找真正会发生滚动的祖先容器 */
	private findScrollParent(el: HTMLElement | null | undefined): HTMLElement | null {
		let cur: HTMLElement | null = el || null;
		while (cur) {
			if (typeof getComputedStyle === "function") {
				const overflowY = getComputedStyle(cur).overflowY;
				if ((overflowY === "auto" || overflowY === "scroll") && cur.scrollHeight > cur.clientHeight + 1) {
					return cur;
				}
			}
			cur = cur.parentElement;
		}
		return null;
	}

	private scrollToTop(view: MarkdownView): void {
		this.lastJumpAt = Date.now();
		this.closePopups();
		this.focalKey = null;
		try {
			if (view.getMode() === "source") {
				const pos = { line: 0, ch: 0 };
				view.editor.setCursor(pos);
				view.editor.scrollIntoView({ from: pos, to: pos }, false);
			} else {
				view.contentEl.scrollTo({ top: 0, behavior: "auto" });
			}
		} catch (e) {
			/* ignore */
		}
		this.scheduleRefresh(0);
	}

	// ============ 同标签页面 ============
	private getTagIndex(): Map<string, Set<string>> {
		if (this.tagIndex && Date.now() - this.tagIndex.time < TAG_CACHE_TTL) return this.tagIndex.map;
		const map = new Map<string, Set<string>>();
		this.app.vault.getMarkdownFiles().forEach((file) => {
			const tags = this.collectTags(file);
			if (tags.size) map.set(file.path, tags);
		});
		this.tagIndex = { time: Date.now(), map };
		return map;
	}

	private collectTags(file: TFile): Set<string> {
		const out = new Set<string>();
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return out;
		const push = (raw: unknown): void => {
			const tag = String(raw ?? "")
				.replace(/^#/, "")
				.trim()
				.toLowerCase();
			if (tag) out.add(tag);
		};
		(cache.tags || []).forEach((t) => push(t.tag));
		const fm = cache.frontmatter;
		if (fm) {
			const raw = fm.tags ?? fm.tag;
			(Array.isArray(raw) ? raw : String(raw ?? "").split(/[,，\s]+/)).forEach((t) => push(t));
		}
		return out;
	}

	private getRelatedPageEntries(file: TFile): MenuEntry[] {
		const index = this.getTagIndex();
		const current = index.get(file.path);
		if (!current || !current.size) return [];

		const out: MenuEntry[] = [];
		index.forEach((tags, path) => {
			if (path === file.path) return;
			const shared: string[] = [];
			tags.forEach((tag) => {
				if (current.has(tag)) shared.push(tag);
			});
			if (!shared.length) return;
			const target = this.app.vault.getAbstractFileByPath(path);
			if (!(target instanceof TFile)) return;
			out.push({
				key: "page:" + path,
				text: this.truncate(target.basename),
				suffix: " #" + shared.slice(0, 3).join(" #"),
				onSelect: () => {
					this.closePopups();
					void this.app.workspace.getLeaf(false).openFile(target);
				},
			});
		});

		out.sort((a, b) => a.text.localeCompare(b.text));
		return out.slice(0, this.settings.maxMenuItems);
	}

	// ============ 悬浮浮层 ============
	/** 根菜单：悬浮面包屑上的某一项后延时弹出 */
	private attachHover(anchor: HTMLElement, loader: () => MenuEntry[]): void {
		anchor.addEventListener("mouseenter", () => this.schedulePopup(anchor, loader));
		anchor.addEventListener("mouseleave", () => this.scheduleHide());
	}

	/**
	 * 子菜单：悬浮菜单项右侧的 ▸ 就延时展开它的下一级，不必点击。
	 * 与点击 ▸ 并存：悬浮 = 就地铺开子菜单，点击 = 追加到面包屑末尾（下钻）。
	 */
	private attachSubmenuHover(
		trigger: HTMLElement,
		item: HTMLElement,
		level: number,
		loader: () => MenuEntry[]
	): void {
		trigger.addEventListener("mouseenter", () => this.schedulePopup(item, loader, level + 1));
		trigger.addEventListener("mouseleave", () => this.scheduleHide());
	}

	/** 统一的「延时弹出」：期间鼠标移开就会取消 */
	private schedulePopup(
		anchor: HTMLElement,
		loader: () => MenuEntry[],
		level = 0
	): void {
		this.cancelHide();
		if (this.showTimer !== null) window.clearTimeout(this.showTimer);
		this.showTimer = window.setTimeout(() => {
			this.showTimer = null;
			const entries = loader();
			if (!entries.length) return;
			this.closePopupsFrom(level);
			this.openPopup(anchor, entries, level);
		}, HOVER_DELAY);
	}

	/** 打开一个全新的根菜单（供点击 ▸、下钻后自动展开等场景调用） */
	showPopup(anchor: HTMLElement, entries: MenuEntry[]): void {
		this.closePopups();
		if (!entries.length) return;
		this.openPopup(anchor, entries, 0);
	}

	private openPopup(anchor: HTMLElement, entries: MenuEntry[], level: number): void {
		const popup = document.createElement("div");
		popup.className = level === 0 ? "bcn-popup" : "bcn-popup bcn-popup-sub";
		entries.slice(0, this.settings.maxMenuItems).forEach((entry) => {
			popup.appendChild(this.createPopupItem(entry, level));
		});

		document.body.appendChild(popup);
		// 子菜单的锚点就是父菜单里的那个条目，标出来以便看清子菜单是从哪条展开的
		if (level > 0) anchor.classList.add("is-open");
		this.popups.push({ el: popup, anchor, level });
		this.repositionPopups();

		popup.addEventListener("mouseenter", () => this.cancelHide());
		// mouseenter 只在进入时触发一次，菜单内持续移动要靠 mousemove 顶住收起计时
		popup.addEventListener("mousemove", () => this.cancelHide());
		popup.addEventListener("mouseleave", () => this.scheduleHide());
	}

	private createPopupItem(entry: MenuEntry, level: number): HTMLElement {
		const item = document.createElement("div");
		item.className = "bcn-popup-item" + (entry.active ? " is-active" : "");

		const text = document.createElement("span");
		text.className = "bcn-popup-text";
		text.textContent = entry.text;
		text.addEventListener("click", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			entry.onSelect();
		});
		item.appendChild(text);

		if (entry.suffix) {
			const suffix = document.createElement("span");
			suffix.className = "bcn-popup-tag";
			suffix.textContent = entry.suffix;
			item.appendChild(suffix);
		}

		const children = entry.children;
		const onDrill = entry.onDrill;
		if (entry.hasChildren && (children || onDrill)) {
			const next = document.createElement("span");
			next.className = "bcn-popup-next";
			next.textContent = "▸";
			next.title = onDrill ? "下一级（悬浮展开 / 点击下钻）" : "下一级";
			// 有下一级数据时才挂悬浮展开；没有则退回「只能点击」的旧行为
			if (children && this.settings.hoverExpandChildren) {
				this.attachSubmenuHover(next, item, level, children);
			}
			next.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				if (onDrill) onDrill();
				else if (children) {
					this.closePopupsFrom(level + 1);
					this.openPopup(item, children(), level + 1);
				}
			});
			item.appendChild(next);
		}

		// 悬浮条目本体即展开下一级；顺带收起别的条目展开的子菜单
		item.addEventListener("mouseenter", () => {
			this.cancelHide();
			const child = this.popups.find((p) => p.level === level + 1);
			if (child && child.anchor !== item) {
				if (this.showTimer !== null) window.clearTimeout(this.showTimer);
				this.showTimer = null;
				this.closePopupsFrom(level + 1);
			}
			if (child && child.anchor === item) return; // 已经展开的就是它自己，保持不动
			if (!children || !this.settings.hoverExpandChildren) return;
			// 关掉「悬浮条目即展开」时，只有 ▸ 上的 mouseenter 会触发展开（见 attachSubmenuHover）
			if (!this.settings.hoverExpandOnItem) return;
			this.schedulePopup(item, children, level + 1);
		});

		return item;
	}

	private repositionPopups(): void {
		// 定位过程中可能触发 closePopupsFrom（锚点失效），先快照一份再遍历
		this.popups.slice().forEach((layer) => this.positionPopup(layer));
	}

	private positionPopup(layer: PopupLayer): void {
		const { el, anchor, level } = layer;
		if (!document.contains(anchor)) {
			this.closePopupsFrom(level); // 锚点已随面包屑重建被移除
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		if (level === 0) {
			const maxLeft = Math.max(8, vw - width - 8);
			el.style.left = Math.min(rect.left, maxLeft) + "px";
			let top = rect.bottom + 4;
			if (top + height > vh - 8) top = Math.max(8, rect.top - height - 4);
			el.style.top = top + "px";
			return;
		}

		// 子菜单：贴在所属条目右侧，右边放不下就翻到左侧
		let left = rect.right + 4;
		if (left + width > vw - 8) left = rect.left - width - 4;
		if (left < 8) left = Math.max(8, vw - width - 8);
		let top = rect.top - 4;
		if (top + height > vh - 8) top = Math.max(8, vh - height - 8);
		el.style.left = left + "px";
		el.style.top = top + "px";
	}

	private cancelHide(): void {
		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}
	}

	private scheduleHide(): void {
		this.cancelHide();
		this.hideTimer = window.setTimeout(() => this.closePopups(), HIDE_DELAY);
	}

	/** 关闭第 level 层及其之后的所有层（level 0 = 全部关闭） */
	private closePopupsFrom(level: number): void {
		const closing = this.popups.filter((p) => p.level >= level);
		if (!closing.length) return;
		this.popups = this.popups.filter((p) => p.level < level);
		closing.forEach((p) => {
			if (p.level > 0) p.anchor.classList.remove("is-open");
			p.el.remove();
		});
	}

	closePopups(): void {
		if (this.showTimer !== null) {
			window.clearTimeout(this.showTimer);
			this.showTimer = null;
		}
		if (this.scrollRaf !== null) {
			window.cancelAnimationFrame(this.scrollRaf);
			this.scrollRaf = null;
		}
		this.cancelHide();
		this.closePopupsFrom(0);
	}

	/** 节点是否落在任一展开的菜单里 */
	private containsPopup(node: Node): boolean {
		return this.popups.some((p) => p.el.contains(node));
	}

	// ============ 工具 ============
	private truncate(text: string): string {
		const max = this.settings.maxLength > 0 ? this.settings.maxLength : 50;
		const first = (text || "").split("\n")[0];
		return first.length > max ? first.slice(0, max) + "…" : first;
	}
}
