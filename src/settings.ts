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
import { Notice, PluginSettingTab, Setting as SettingCtor } from "obsidian";
import { DEFAULT_CODE_EXTENSIONS } from "./codeFileView";

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
	 * my-worklife-calendar）。垫片按此截获这类 tab 进「其他」区，避免它们
	 * 在设置侧栏单独成栏。
	 */
	internalTabIds?: string[];
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

export const DEFAULT_SETTINGS: MyObsidianSettings = { modules: {}, codeFileExtensions: [] };

export function defaultModuleState(desktopOnly: boolean): ModuleState {
	return { enabled: !desktopOnly || isDesktopApp(), data: {} };
}

function isDesktopApp(): boolean {
	return typeof window !== "undefined" && !!(window as unknown as { require?: unknown }).require;
}

export class MyObsidianSettingTab extends PluginSettingTab {
	private readonly host: {
		settings: MyObsidianSettings;
		descriptors: ModuleDescriptor[];
		save(): Promise<void>;
		reload(id: string): Promise<void>;
		capturedTabs: Map<string, unknown>;
	};

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
			pageStack?: Array<{ page: unknown }>;
		};
		if (typeof api.openPage !== "function") {
			new Notice("当前 Obsidian 版本不支持设置二级页（需要 1.15+）");
			return;
		}
		// 复用单例 page：openPage 拒绝重复 push 同一对象，换模块时先出栈。
		if (this.modulePage && api.pageStack?.some((e) => e.page === this.modulePage)) {
			api.closePage?.();
		}
		if (!this.modulePage) {
			this.modulePage = this.buildModulePage();
		}
		this.modulePageTab = tab;
		this.modulePage.title = `${moduleName} 设置`;
		api.openPage(this.modulePage);
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
				tab.containerEl.addClass("my-module-page-embed");
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
				window.setTimeout(() => {
					try {
						rootEl.detach();
					} catch {
						/* already detached */
					}
				}, 250);
			},
		};
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "My Obsidian" });
		containerEl.createEl("p", {
			text: "一个插件、一个 id。每个功能一把大开关：关掉的功能在下次启动前不会占用任何资源；开启即时生效，关闭需重启 Obsidian 才能卸载已载入的模块。点齿轮进入该模块的设置页。",
			cls: "setting-item-description",
		});

		for (const m of this.host.descriptors) {
			const state = this.host.settings.modules[m.id] ?? defaultModuleState(m.desktopOnly);
			new SettingCtor(containerEl)
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
		}

		// 内层子插件实例的设置页（addTab 垫片截获的 inner: 键）：没有对应的
		// descriptor 行，统一挂在末尾的「其他」区。
		for (const [key, tab] of this.host.capturedTabs) {
			if (!key.startsWith("inner:")) continue;
			void tab;
			const label = key.split(":")[2] ?? key;
			new SettingCtor(containerEl)
				.setName(`其他模块设置（${label}）`)
				.addExtraButton((btn) =>
					btn
						.setIcon("settings-2")
						.setTooltip("打开设置")
						.onClick(() => this.openModulePage(key, label)),
				);
		}

		containerEl.createEl("p", {
			text: "这些扩展名由本插件打开（Obsidian 原本对它们没有视图，点了只会是一片空白）。带 ▶ 运行的会在运行前自动保存。改动后需要重启 Obsidian。",
			cls: "setting-item-description",
		});
		new SettingCtor(containerEl)
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
	}
}

