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
import type { App } from "obsidian";
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
	/**
	 * The id this plugin had BEFORE the merge.
	 *
	 * Two modules reach for each other through `app.plugins.plugins[...]`:
	 * jupyter reads logseq's `pythonEnvs`, breadcrumb reads logseq's mount
	 * list. Keeping the old id alive as an alias means those lookups — and any
	 * other plugin that integrated with them — keep working untouched.
	 */
	legacyId?: string;
	/** Shown as this module's settings-tab name. */
	name: string;
	summary: string;
	/** Desktop-only modules are refused when Obsidian has no Node/electron. */
	desktopOnly: boolean;
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
	};

	constructor(
		app: App,
		plugin: unknown,
		host: {
			settings: MyObsidianSettings;
			descriptors: ModuleDescriptor[];
			save(): Promise<void>;
			reload(id: string): Promise<void>;
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
			text: "一个插件里装着几个自用功能。关掉的功能在下次启动前不会占用任何资源；改动后需要重启 Obsidian 才能卸载已经载入的模块。",
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
		}

		containerEl.createEl("p", {
			text: "每个模块自己的设置项仍然在各自原来的设置页里（Logseq Editor / Browser / Jupyter Notebook / Breadcrumb Nav）。",
			cls: "setting-item-description",
		});

		containerEl.createEl("h3", { text: "代码文件" });
		containerEl.createEl("p", {
			text: "这些扩展名由本插件打开（Obsidian 原本对它们没有视图，点了只会是一片空白）。带 ▶ 运行的会在运行前自动保存。改动后需要重启 Obsidian。",
			cls: "setting-item-description",
		});
		new SettingCtor(containerEl)
			.setName("接管的扩展名")
			.setDesc("英文逗号分隔。留空则用默认清单；Markdown 与 canvas 永远不会被接管。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_CODE_EXTENSIONS.join(","))
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

