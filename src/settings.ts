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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "My Obsidian" });
		containerEl.createEl("p", {
			text: "一个插件、一个 id。每个功能一把大开关：关掉的功能在下次启动前不会占用任何资源；开启即时生效，关闭需重启 Obsidian 才能卸载已载入的模块。带设置的模块在开关下方直接展开。",
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
				);

			// 内嵌模块设置：模块 onload 里 addSettingTab 的截获物。展开时把它的
			// containerEl 挂进 details 并调 display()（PluginSettingTab 渲染进
			// 自带容器，搬 DOM 节点即可）；收起时调 hide() 让它落盘/清定时器。
			const tab = this.host.capturedTabs.get(m.id) as
				| {
						containerEl: HTMLElement;
						display(): void;
						hide?(): void;
				  }
				| undefined;
			if (!tab) continue;
			const details = containerEl.createEl("details", {
				cls: "my-module-settings",
			});
			details.createEl("summary", { text: `${m.name} 设置` });
			const holder = details.createDiv({ cls: "my-module-settings-holder" });
			let rendered = false;
			details.addEventListener("toggle", () => {
				if (details.open && !rendered) {
					holder.appendChild(tab.containerEl);
					tab.containerEl.addClass("my-embedded-setting-tab");
					tab.display();
					rendered = true;
				} else if (!details.open) {
					tab.hide?.();
				}
			});
		}

		// 内层子插件实例的设置页（addTab 垫片截获的 inner: 键）：没有对应的
		// descriptor 行，统一挂在末尾的「其他」区。
		for (const [key, tab] of this.host.capturedTabs) {
			if (!key.startsWith("inner:")) continue;
			const t = tab as {
				containerEl: HTMLElement;
				display(): void;
				hide?(): void;
			};
			const details = containerEl.createEl("details", {
				cls: "my-module-settings",
			});
			details.createEl("summary", { text: `其他模块设置（${key.split(":")[2] ?? key}）` });
			const holder = details.createDiv({ cls: "my-module-settings-holder" });
			let rendered = false;
			details.addEventListener("toggle", () => {
				if (details.open && !rendered) {
					holder.appendChild(t.containerEl);
					t.containerEl.addClass("my-embedded-setting-tab");
					t.display();
					rendered = true;
				} else if (!details.open) {
					t.hide?.();
				}
			});
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

