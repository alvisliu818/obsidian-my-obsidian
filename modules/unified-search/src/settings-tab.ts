import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./settings";
import type { UnifiedSearchPlugin } from "./main";

export class UnifiedSearchSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		readonly plugin: UnifiedSearchPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "my Unified Search" });
		containerEl.createEl("p", {
			text: "基于 node:sqlite（FTS5）的磁盘索引搜索。JS 堆不驻留索引；库文件可随时删除重建。语法：词与词 AND、\"短语\"、-排除、title:/tag:/path:/ext: 过滤、uni* 前缀（标题/标签）。",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("索引库存放目录")
			.setDesc("每个库以 vault 路径命名，多库互不踩。改动后需重启 Obsidian 生效。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.sqliteDbDir)
					.setValue(this.plugin.settings.sqliteDbDir)
					.onChange(async (value) => {
						this.plugin.settings.sqliteDbDir = value.trim();
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName("拆分 camelCase")
			.setDesc("把 unifiedIndex 拆出 unified/Index。开关变更会触发全量重建索引。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.splitCamel).onChange(async (value) => {
					this.plugin.settings.splitCamel = value;
					await this.plugin.saveData(this.plugin.settings);
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName("收录库外挂载文件")
			.setDesc(
				"把 logseq 模块挂载的库外文本文件纳入索引（>1MB 只索引头部 1MB；挂载内容无实时监听，改动后用「重建索引」刷新）。",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.indexExt).onChange(async (value) => {
					this.plugin.settings.indexExt = value;
					await this.plugin.saveData(this.plugin.settings);
				}),
			);

		new Setting(containerEl)
			.setName("重建索引")
			.setDesc("清空索引库并重新扫描全库（文件本身不会被改动）。")
			.addButton((btn) =>
				btn.setButtonText("重建").onClick(() => {
					void this.plugin.rebuild();
				}),
			);
	}
}
