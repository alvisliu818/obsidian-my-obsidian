/**
 * The merged plugin's own settings: which sub-features are on, plus each
 * sub-feature's private data.
 *
 * Every module keeps reading and writing `this.loadData()` / `this.saveData()`
 * exactly as it did as a standalone plugin — the host patches those two methods
 * so a module only ever sees its own slice. That is what lets four plugins,
 * each with its own settings shape, share one data.json without any of them
 * having to know they were merged.
 */
import type { App, PluginManifest } from "obsidian";
import { Notice, PluginSettingTab, Setting as SettingCtor, setIcon } from "obsidian";
import { DEFAULT_CODE_EXTENSIONS } from "./codeFileView";
import { setTitlebarMenuSuppressed } from "./windowFrame";

export interface ModuleState {
	/** Master switch. Off = the module is never loaded at all. */
	enabled: boolean;
	/** The module's own settings blob (what it thinks is its whole data.json). */
	data: unknown;
}

export interface MyObsidianSettings {
	modules: Record<string, ModuleState>;
	/** 宿主自己的代码文件视图接管哪些扩展名（Markdown 永远不在其中） */
	codeFileExtensions?: string[];
	/** true = 接管无边框窗口顶栏的标签条空白区:右键弹「最小化/还原/关闭」
	 *  Obsidian 简版菜单;false/缺省 = 完全放手,原生完整系统菜单与拖窗照旧
	 *  （主窗口 drag 区自带,无需代码）。用户 2026-11-21 终版定案。 */
	suppressTitlebarMenu?: boolean;
}

/** Catalogue of what can be switched on. Order = the order shown in settings. */
export interface ModuleDescriptor {
	/** Our own id (the key in settings.modules). */
	id: string;
	/** Shown as this module's settings-section name. */
	name: string;
	summary: string;
	/** Desktop-only modules are refused when Obsidian has no Node/electron. */
	desktopOnly: boolean;
	/**
	 * Per-module manifest overrides, merged over the host's manifest before
	 * the copy is handed to the instance.
	 *
	 * 单一插件 id 策略下只允许 `version` 这类语义字段：一些模块的内部逻辑
	 * 读 `manifest.version` 做版本门禁/迁移（vault-explorer 的迁移链、
	 * terminal 的版本显示），须保持上游值；宿主自己的 0.1.0 会把它们带偏。
	 * `id` 覆盖已随插件表别名机制移除（2026-11-03）；`dir` 永远不许覆盖
	 * （sidecar 路径落在真插件目录）；`name` 总是取自 descriptor。
	 */
	manifest?: Partial<PluginManifest>;
	/**
	 * 一次性设置迁移来源：曾作为独立插件装在库里的 id。模块数据片为空且
	 * `<configDir>/plugins/<该id>/data.json` 存在时，宿主在 loadSettings 阶段
	 * 把它读进数据片——合并版首次启动即继承原独立版的设置（只做一次：
	 * 导入后写回 data.json，此后以数据片为准）。
	 */
	migrateFrom?: string;
	/**
	 * 内层子插件实例会注册的设置 tab id 清单（如 momentum 的 WorkLife 报
	 * worklife-calendar）。垫片按此截获这类 tab 进「其他」区，避免它们
	 * 在设置侧栏单独成栏。
	 */
	internalTabIds?: string[];
	/**
	 * 随本模块一并启停的伴生子插件（2026-11-21 momentum 并入 life）：宿主在
	 * 启动本模块后立即启动它，数据片嵌在本模块 data 的以 id 为键的子对象里
	 * （迁移自旧的独立 modules.<id> 片），设置 tab 截进 capturedTabs 的
	 * <id> 键——设置列表不再单独成行，入口走 subPages。
	 */
	companion?: { id: string; cls: new (app: App, manifest: unknown) => SubPluginLike; name: string };
	/**
	 * 本模块设置页之外的附属设置页（如并入 life 的 momentum）：模块行上多画
	 * 一个齿轮直达 capturedTabs.get(id)，设置搜索也把这些页爬进索引。
	 */
	subPages?: Array<{ id: string; name: string }>;
	/** The module's own Plugin class, imported from modules/<id>/src/main. */
	cls: new (app: App, manifest: unknown) => SubPluginLike;
}

/**
 * What the host needs from a sub-plugin: the lifecycle hooks, plus the two
 * data methods it shadows with per-module slices.
 */
export interface SubPluginLike {
	onload(): Promise<void> | void;
	onunload?(): void;
	loadData?(): Promise<unknown>;
	saveData?(data: unknown): Promise<void>;
}

export const DEFAULT_SETTINGS: MyObsidianSettings = { modules: {}, codeFileExtensions: [], suppressTitlebarMenu: false };

export function defaultModuleState(desktopOnly: boolean): ModuleState {
	return { enabled: !desktopOnly || isDesktopApp(), data: {} };
}

function isDesktopApp(): boolean {
	return typeof window !== "undefined" && !!(window as unknown as { require?: unknown }).require;
}

/** 设置搜索索引条目(节点为活体,搬移后控件可用)。 */
interface SettingSearchEntry {
	moduleId: string;
	moduleLabel: string;
	name: string;
	desc: string;
	node: HTMLElement;
}

type CrawlableTab = {
	containerEl: HTMLElement;
	display(): void;
	onLoad?(): unknown;
	__myLoaded?: boolean;
	update?(): unknown;
	renderTab?(): unknown;
};

export class MyObsidianSettingTab extends PluginSettingTab {
	private readonly host: {
		settings: MyObsidianSettings;
		descriptors: ModuleDescriptor[];
		save(): Promise<void>;
		reload(id: string): Promise<void>;
		capturedTabs: Map<string, unknown>;
	};

	/**
	 * 设置搜索(用户 2026-11-20:插件支持搜索设置,能在搜索出的设置里直接改设置)。
	 *
	 * 索引 = 离散爬取全部模块设置页:对每个 captured tab 走模块二级页同款
	 * 渲染配方(containerEl 迁入分离容器 + update/renderTab 或 display),
	 * 收集 .setting-item 的名字/描述与**节点本体**。结果列表直接把真实节点
	 * 搬进去(appendChild 移动,监听器全保留)——开关/输入框在结果里就是活的,
	 * 改动经模块自己的 onChange 落库,完全满足「直接改」;之后打开该模块页时
	 * update()/renderTab() 会重建全新节点,自愈。
	 */
	private searchEntries: SettingSearchEntry[] | null = null;

	/**
	 * 上一次搜索词(仅内存,不落盘):点结果里的齿轮进模块二级页再返回时,
	 * closePage 出栈后框架重放本 tab 的 display()(obsidian.asar 逆向:栈空走
	 * activeTab.renderTab(),legacy tab 的 settingItems 恒空 → this.display()),
	 * 输入框与结果区都是全新节点——靠它回填并自动恢复结果。
	 */
	private lastQuery = "";

	constructor(
		app: App,
		plugin: unknown,
		host: {
			settings: MyObsidianSettings;
			descriptors: ModuleDescriptor[];
			save(): Promise<void>;
			reload(id: string): Promise<void>;
			/** 模块自己的设置页（addSettingTab 截获物），键 = 模块 id。 */
			capturedTabs: Map<string, unknown>;
		},
	) {
		super(app, plugin as never);
		this.host = host;
	}

	/**
	 * 模块设置二级页（用户拍板的形态：不内嵌展开，点开进下一页）。
	 *
	 * 形状逆向自 Obsidian 1.15 app.js 的 page 基类（aT）与 openPage 契约：
	 * rootEl = div.setting-page.vertical-tab-content，其下 titlebarEl =
	 * div.setting-page-titlebar（框架塞返回键与标题）、containerEl =
	 * div.setting-page-content。openPage 负责把 rootEl 挂进设置容器并做
	 * 滑入动画（旧页自动 detach），closePage 滑出并回渲染宿主页；但
	 * clearPageStack（切换 tab 时）只调 page.hide() 不摘 DOM——hide 里延迟
	 * detach 兜底，避免残页叠在宿主页上。
	 *
	 * 页内容渲染复用 1.15 配方：模块 tab 的 display() 在 1.15 已成空壳
	 * （displayLegacy 只 beginRenderCycle + empty），真实渲染 = update() 从
	 * getSettingDefinitions() 填 settingItems + renderTab() 铺 DOM；1.14 及
	 * 更早没有 openPage，走到这里直接提示（Obsidian 自动升级，1.14 分支
	 * 不再维护）。
	 */
	private modulePage: {
		title: string;
		rootEl: HTMLElement;
		titlebarEl: HTMLElement;
		containerEl: HTMLElement;
		display(): void;
		hide(): void;
	} | null = null;

	private modulePageTab: {
		containerEl: HTMLElement;
		display(): void;
		hide?(): void;
		update?(): unknown;
		renderTab?(): unknown;
	} | null = null;

	/** 待执行的延迟 detach 定时器（hide 挂、openModulePage 取消——防单例 rootEl 复用竞态）。 */
	private modulePageDetachTimer: number | null = null;

	private openModulePage(moduleId: string, moduleName: string): void {
		const tab = this.host.capturedTabs.get(moduleId) as
			| {
					containerEl: HTMLElement;
					display(): void;
					hide?(): void;
					update?(): unknown;
					renderTab?(): unknown;
			  }
			| undefined;
		if (!tab) {
			new Notice(`「${moduleName}」暂无设置页（模块可能尚未启动）`);
			return;
		}
		const api = this.app.setting as unknown as {
			openPage?(page: unknown): void;
			closePage?(): void;
			pageStack?: Array<unknown>;
		};
		if (typeof api.openPage !== "function") {
			new Notice("当前 Obsidian 版本不支持设置二级页（需要 1.15+）");
			return;
		}
		// 复用单例 page：openPage 拒绝重复 push 同一对象，换模块时先出栈。
		// 栈条目形状不假设（{page} 包装或裸 page 都认——形状猜错会让 closePage
		// 永远不被调、openPage 拒绝重复 push，模块页打不开（用户实报「有时
		// 打不开」的候选根因）。
		if (this.modulePage) {
			this.cancelModulePageDetach();
			const inStack = (api.pageStack ?? []).some(
				(e) => e === this.modulePage || (e as { page?: unknown })?.page === this.modulePage,
			);
			if (inStack) api.closePage?.();
		}
		if (!this.modulePage) {
			this.modulePage = this.buildModulePage();
		}
		this.modulePageTab = tab;
		this.modulePage.title = `${moduleName} 设置`;
		try {
			api.openPage(this.modulePage);
		} catch {
			// 重复 push 被核心拒绝（栈状态与我们的判断不一致）时：先出栈再试一次
			api.closePage?.();
			api.openPage(this.modulePage);
		}
		// 挂载确认：openPage 返回后 rootEl 应已入 DOM。没入（核心吞了 push）=
		// 用户看到的「打不开」——出栈重试一次。
		if (!this.modulePage.rootEl.isConnected) {
			api.closePage?.();
			api.openPage(this.modulePage);
			if (!this.modulePage.rootEl.isConnected) {
				new Notice(`「${moduleName}」设置页打开失败，请重试`);
			}
		}
	}

	private buildModulePage(): {
		title: string;
		rootEl: HTMLElement;
		titlebarEl: HTMLElement;
		containerEl: HTMLElement;
		display(): void;
		hide(): void;
	} {
		const self = this;
		const rootEl = createDiv("setting-page vertical-tab-content");
		const titlebarEl = rootEl.createDiv("setting-page-titlebar");
		const containerEl = rootEl.createDiv("setting-page-content");
		return {
			title: "",
			rootEl,
			titlebarEl,
			containerEl,
			display() {
				const tab = self.modulePageTab;
				if (!tab) return;
				containerEl.empty();
				containerEl.appendChild(tab.containerEl);
				// polyipseity 系 tab 的 UI widgets 在其 onLoad() 里注册（构造期
				// 经 Promise.then→addChild(LambdaComponent) 触发）；1.15 下
				// 该链断掉（addChild 挂起 / load() 不达 onload，两者实测），
				// display() 的 ui.update() 无 widget 可渲染——宿主直接补调
				// 一次 onLoad（打标防重复；多次调用会重复注册语言监听与
				// widget）。
				const t0 = tab as { __myLoaded?: boolean; onLoad?(): unknown };
				if (!t0.__myLoaded && typeof t0.onLoad === "function") {
					t0.__myLoaded = true;
					try {
						t0.onLoad();
					} catch {
						/* lifecycle best-effort */
					}
				}
				// 模块 tab 的 containerEl 类名是 .vertical-tab-content——1.x 里
				// 它自身就是滚动容器（height:100% + overflow-y:auto），嵌进
				// 二级页后与 .setting-page 的滚动叠加成双滚动条（实测）。加标
				// 记类取消它的高度约束与滚动，滚动职责上交 .setting-page。
				tab.containerEl.addClass("module-page-embed");
				if (typeof tab.update === "function" && typeof tab.renderTab === "function") {
					tab.update();
					tab.renderTab();
				} else {
					tab.display();
				}
			},
			hide() {
				self.modulePageTab?.hide?.();
				// closePage 路径：框架滑出动画（150ms）后自会 detach；
				// clearPageStack 路径无人摘 DOM——延迟兜底。对已 detach 的
				// rootEl 再 detach 无害。
				//
				// 但这个 detach 必须可取消（用户实报「模块设置页有时打不开」的
				// 根因之一）：单例 rootEl 复用——关页后 250ms 内又点开别的模块
				// 页，openPage 把同一个 rootEl 重新挂上，此时若延迟 detach 照跑，
				// 刚挂好的页又被摘掉（表现=点了齿轮没反应）。openModulePage 进
				// 场时会 cancelModulePageDetach()。
				self.modulePageDetachTimer = window.setTimeout(() => {
					self.modulePageDetachTimer = null;
					// 双保险：若 rootEl 已被重新挂载成活动页（isConnected 且仍是
					// 当前单例），放弃摘除
					if (rootEl.isConnected && self.modulePage?.rootEl === rootEl) return;
					try {
						rootEl.detach();
					} catch {
						/* already detached */
					}
				}, 250);
			},
		};
	}

	/** 取消待执行的延迟 detach（快速连续换模块页时防竞态）。 */
	private cancelModulePageDetach(): void {
		if (this.modulePageDetachTimer !== null) {
			window.clearTimeout(this.modulePageDetachTimer);
			this.modulePageDetachTimer = null;
		}
	}

	/**
	 * 就地重渲染（tab 动态注册的补救，2026-11-07 用户报「设置页面有时会
	 * 加载不全」）:宿主页 display() 一次性铺完,内层实例的 tab（「其他」区）
	 * 在启动中后段才注册——启动窗口期打开设置就终身停在缺行状态。垫片截获
	 * 新 tab / 启动收尾时调用;仅当设置弹窗开着且宿主页正显示时重画
	 * （containerEl.isConnected 就是「正显示」判据,未显示等下次 display）。
	 */
	refreshIfVisible(): void {
		if (!this.containerEl.isConnected) return;
		this.display();
	}

	/** 离散爬取全部模块设置项(每模块之间让出主线程;单模块失败不影响整体)。 */
	private async crawlSettingIndex(): Promise<SettingSearchEntry[]> {
		const items: Array<{ id: string; label: string; tab: CrawlableTab }> = [];
		for (const m of this.host.descriptors) {
			const tab = this.host.capturedTabs.get(m.id) as CrawlableTab | undefined;
			if (tab) items.push({ id: m.id, label: m.name, tab });
			// 附属设置页(momentum 并入 life):同主页一起爬进索引,搜索按
			// 附属页自己的名字分组,齿轮直达该页。
			for (const sp of m.subPages ?? []) {
				const spTab = this.host.capturedTabs.get(sp.id) as CrawlableTab | undefined;
				if (spTab) items.push({ id: sp.id, label: sp.name, tab: spTab });
			}
		}
		// 已被 descriptor.subPages 收编的 inner: 键不重复爬(如 WorkLife
		// Calendar 已是 Life 的附属页)。
		const subPageIds = new Set(
			this.host.descriptors.flatMap((m) => (m.subPages ?? []).map((sp) => sp.id)),
		);
		for (const [key, tab] of this.host.capturedTabs) {
			if (!key.startsWith("inner:") || subPageIds.has(key)) continue;
			const t = tab as { plugin?: { manifest?: { name?: string } } };
			items.push({
				id: key,
				label: t?.plugin?.manifest?.name || key.split(":")[2] || key,
				tab: tab as CrawlableTab,
			});
		}
		const entries: SettingSearchEntry[] = [];
		for (const it of items) {
			this.crawlOneTab(it, entries);
			await new Promise((r) => setTimeout(r, 0));
		}
		return entries;
	}

	/** 单模块爬取:二级页同款渲染配方 → 收集节标题上下文 + setting-item 节点。 */
	private crawlOneTab(it: { id: string; label: string; tab: CrawlableTab }, entries: SettingSearchEntry[]): void {
		const tab = it.tab;
		try {
			const holder = createDiv();
			holder.appendChild(tab.containerEl);
			const t0 = tab as { __myLoaded?: boolean; onLoad?(): unknown };
			if (!t0.__myLoaded && typeof t0.onLoad === "function") {
				t0.__myLoaded = true;
				try {
					t0.onLoad();
				} catch {
					/* lifecycle best-effort */
				}
			}
			if (typeof tab.update === "function" && typeof tab.renderTab === "function") {
				tab.update();
				tab.renderTab();
			} else {
				tab.display();
			}
			let section = "";
			for (const el of Array.from(tab.containerEl.querySelectorAll("h2, h3, .setting-item"))) {
				if (!(el instanceof HTMLElement)) continue;
				if (el.matches("h2, h3")) {
					section = el.textContent?.trim() ?? "";
					continue;
				}
				const name = el.querySelector(".setting-item-name")?.textContent?.trim() ?? "";
				const desc = el.querySelector(".setting-item-description")?.textContent?.trim() ?? "";
				if (!name && !desc) continue;
				entries.push({
					moduleId: it.id,
					moduleLabel: it.label,
					name,
					desc: section ? `${section} · ${desc}` : desc,
					node: el,
				});
			}
		} catch {
			/* 该模块设置爬不出来就跳过 */
		}
	}

	/** 渲染搜索结果:真实节点搬入(控件活性保留),按模块分组——模块名独立成栏
	 * (用户 2026-11-21「按模块分组,模块名单独占一栏,不要在设置项左侧占空间」);
	 * 空结果给提示。 */
	private renderSearchResults(query: string, resultsEl: HTMLElement, listEl: HTMLElement): void {
		resultsEl.empty();
		const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const entries = this.searchEntries ?? [];
		const hits = entries
			.filter((e) => {
				const hay = `${e.moduleLabel} ${e.name} ${e.desc}`.toLowerCase();
				return tokens.every((t) => hay.includes(t));
			})
			.slice(0, 60);
		const countEl = resultsEl.createDiv({ cls: "setting-search-count" });
		countEl.setText(hits.length === 0 ? `没有匹配「${query.trim()}」的设置项` : `${hits.length} 个匹配(改动即时生效)`);
		// 按模块分组(保持索引序=设置页模块序);模块名独立成栏,右侧小齿轮
		// 进该模块设置页;组内条目不再带左侧芯片。
		const groups = new Map<string, { label: string; items: SettingSearchEntry[] }>();
		for (const h of hits) {
			const g = groups.get(h.moduleId) ?? { label: h.moduleLabel, items: [] };
			g.items.push(h);
			groups.set(h.moduleId, g);
		}
		for (const [, g] of groups) {
			const header = resultsEl.createDiv({ cls: "setting-search-group-header" });
			header.createSpan({ cls: "setting-search-group-name", text: g.label });
			const gear = header.createEl("button", {
				cls: "setting-search-group-gear clickable-icon",
				attr: { "aria-label": `打开 ${g.label} 设置页` },
			});
			setIcon(gear, "settings-2");
			gear.addEventListener("click", () => this.openModulePage(g.items[0].moduleId, g.label));
			for (const item of g.items) {
				const wrap = resultsEl.createDiv({ cls: "setting-search-hit" });
				wrap.appendChild(item.node);
				item.node.addClass("setting-search-node");
			}
		}
		if (!hits.length) listEl.show();
	}

	private async onSearchInput(query: string, resultsEl: HTMLElement, listEl: HTMLElement): Promise<void> {
		if (!query.trim()) {
			resultsEl.empty();
			listEl.show();
			return;
		}
		listEl.hide();
		if (!this.searchEntries) {
			resultsEl.empty();
			resultsEl.createDiv({ cls: "setting-search-count", text: "正在索引全部模块设置…" });
			this.searchEntries = await this.crawlSettingIndex();
			// 爬取期间输入已变化/清空 → 以当前输入框值为准
			if (!(this.containerEl.querySelector(".setting-search-input") as HTMLInputElement | null)?.value.trim()) {
				resultsEl.empty();
				listEl.show();
				return;
			}
		}
		this.renderSearchResults(query, resultsEl, listEl);
	}


	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.searchEntries = null; // 每次重渲染重建索引缓存
		containerEl.createEl("h2", { text: "My Obsidian" });
		containerEl.createEl("p", {
			text: "一个插件、一个 id。每个功能一把大开关：关掉的功能在下次启动前不会占用任何资源；开启即时生效，关闭需重启 Obsidian 才能卸载已载入的模块。点齿轮进入该模块的设置页。",
			cls: "setting-item-description",
		});

		// 设置搜索(用户 2026-11-20):输入即搜,结果里是活的设置控件,直接改。
		const searchWrap = containerEl.createDiv({ cls: "setting-search" });
		const searchInput = searchWrap.createEl("input", {
			type: "search",
			cls: "setting-search-input",
			attr: { placeholder: "搜索设置(模块名/项名/描述)——结果里可直接改动", spellcheck: "false" },
		});
		const resultsEl = containerEl.createDiv({ cls: "setting-search-results" });
		const listEl = containerEl.createDiv({ cls: "setting-search-list" });
		searchInput.addEventListener("input", () => {
			// 输入每次变化同步记忆(清空即置空);仅内存,不落盘。
			this.lastQuery = searchInput.value;
			void this.onSearchInput(searchInput.value, resultsEl, listEl);
		});

		// 二级页返回恢复(用户 2026-11-21「返回搜索结果没了」):display() 被框架
		// 重放后搜索 UI 全是新节点,lastQuery 非空则回填并自动触发一次恢复——
		// 走与正常搜索同一条 onSearchInput 路径,计数条/分组头/活控件完全一致;
		// searchEntries 重建索引是既有行为,爬取是异步的,期间输入再变化仍由
		// onSearchInput 的既有防护兜底(以输入框当前值为准)。
		if (this.lastQuery) {
			searchInput.value = this.lastQuery;
			void this.onSearchInput(this.lastQuery, resultsEl, listEl);
		}

		// 模块行按名称排序（用户 2026-11-20：设置页模块按名称排序）——大小写
		// 不敏的稳定排序，descriptor 数组本身不动（boot 顺序与 UI 无关）。
		const sortedDescriptors = [...this.host.descriptors].sort((a, b) =>
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
		);
		for (const m of sortedDescriptors) {
			const state = this.host.settings.modules[m.id] ?? defaultModuleState(m.desktopOnly);
			const row = new SettingCtor(listEl)
				.setName(m.name)
				.setDesc(m.summary)
				.addToggle((toggle) =>
					toggle.setValue(state.enabled).onChange(async (value) => {
						state.enabled = value;
						await this.host.save();
						// Loading can happen right away; unloading cannot —
						// a plugin cannot revoke commands/views safely once
						// registered, so that waits for the next restart.
						if (value) await this.host.reload(m.id);
						else new Notice(`「${m.name}」已关闭，重启 Obsidian 后生效`);
					}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("settings-2")
						.setTooltip(`${m.name} 设置`)
						.onClick(() => this.openModulePage(m.id, m.name)),
				);
			// 附属设置页(momentum 并入 life,2026-11-21):每页一枚齿轮直达,
			// 与主齿轮同款样式——并入的模块不再单独占行。
			for (const sp of m.subPages ?? []) {
				row.addExtraButton((btn) =>
					btn
						.setIcon("settings-2")
						.setTooltip(`${sp.name} 设置`)
						.onClick(() => this.openModulePage(sp.id, sp.name)),
				);
			}
		}

		// 内层子插件实例的设置页（addTab 垫片截获的 inner: 键）：没有对应的
		// descriptor 行，统一挂在末尾的「其他」区。显示名用内层插件的
		// manifest.name，内部 id 只作兜底。已被 descriptor.subPages 收编的
		// 键（如 WorkLife Calendar → Life 附属页）不在这里重复出现。
		const orphanSubPageIds = new Set(
			this.host.descriptors.flatMap((m) => (m.subPages ?? []).map((sp) => sp.id)),
		);
		for (const [key, tab] of this.host.capturedTabs) {
			if (!key.startsWith("inner:") || orphanSubPageIds.has(key)) continue;
			const t = tab as { plugin?: { manifest?: { name?: string } } } | undefined;
			const label = t?.plugin?.manifest?.name || key.split(":")[2] || key;
			new SettingCtor(listEl)
				.setName(label)
				.setDesc("内嵌模块设置页")
				.addExtraButton((btn) =>
					btn
						.setIcon("settings-2")
						.setTooltip("打开设置")
						.onClick(() => this.openModulePage(key, label)),
				);
		}

		listEl.createEl("p", {
			text: "这些扩展名由本插件打开（Obsidian 原本对它们没有视图，点了只会是一片空白）。带 ▶ 运行的会在运行前自动保存。改动后需要重启 Obsidian。",
			cls: "setting-item-description",
		});
		new SettingCtor(listEl)
			.setName("接管的扩展名")
			.setDesc("英文逗号分隔。留空则用默认清单；Markdown 与 canvas 永远不会被接管。")
			.addText((text) =>
				text
					.setPlaceholder(
						`默认清单（${DEFAULT_CODE_EXTENSIONS.length} 个，含 ${DEFAULT_CODE_EXTENSIONS.slice(0, 8).join(", ")} …）`,
					)
					.setValue((this.host.settings.codeFileExtensions ?? []).join(","))
					.onChange(async (value) => {
						const list = value
							.split(/[,\s]+/)
							.map((s) => s.trim().replace(/^\./, "").toLowerCase())
							.filter(Boolean);
						this.host.settings.codeFileExtensions = list;
						await this.host.save();
					}),
			);

		// 顶栏右键窗口菜单开关(用户 2026-11-21 终版定案「主窗口本来就有完整
		// 系统菜单,不需要写代码」):开 = 接管标签条空白区,右键弹 Obsidian 简版
		// 菜单(windowFrame 接管);关/缺省 = 完全放手,原生完整系统菜单与拖窗
		// 照旧。存值语义 = 抑制原生(true=接管),与开关方向一致。标签本身的
		// 右键菜单不受影响。
		new SettingCtor(listEl)
			.setName("顶栏右键窗口菜单")
			.setDesc(
				"开启后,无边框窗口顶栏的标签条空白区右键弹「最小化/还原/关闭」Obsidian 简版菜单;关闭则恢复 Windows 原生完整系统菜单（还原/移动/大小/最小化/最大化/关闭）。标签本身的右键菜单不受影响。",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.host.settings.suppressTitlebarMenu === true).onChange(async (value) => {
					// value = 开 = 接管(简版菜单);关 = 放手回原生完整菜单。
					this.host.settings.suppressTitlebarMenu = value;
					setTitlebarMenuSuppressed(value);
					await this.host.save();
				}),
			);
	}
}

