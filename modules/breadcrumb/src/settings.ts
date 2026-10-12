import { PluginSettingTab, Setting, App, ToggleComponent } from "obsidian";
import type BreadcrumbNavPlugin from "./main";

export class BreadcrumbNavSettingTab extends PluginSettingTab {
	plugin: BreadcrumbNavPlugin;

	constructor(app: App, plugin: BreadcrumbNavPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Breadcrumb Nav（面包屑导航）" });

		new Setting(containerEl)
			.setName("启用面包屑")
			.setDesc("关闭后移除笔记顶部的面包屑栏（也可用左侧功能区图标或命令切换）")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					this.plugin.refreshRibbon();
					this.plugin.scheduleRefresh(0);
				})
			);

		new Setting(containerEl)
			.setName("文本最大长度")
			.setDesc("面包屑与菜单中每项文本的最大长度，超出以 … 截断")
			.addText((text) =>
				text
					.setPlaceholder("50")
					.setValue(String(this.plugin.settings.maxLength))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.maxLength = Number.isFinite(n) && n > 0 ? n : 50;
						await this.plugin.saveSettings();
						this.plugin.scheduleRefresh(0);
					})
			);

		new Setting(containerEl)
			.setName("悬浮查看同级")
			.setDesc("悬浮到面包屑某一级时，弹出同级的其他标题，点击可跳转")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableSiblingsMenu).onChange(async (value) => {
					this.plugin.settings.enableSiblingsMenu = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleRefresh(0);
				})
			);

		new Setting(containerEl)
			.setName("显示下一级图标")
			.setDesc("面包屑末尾显示 ▸，点击或悬浮可继续向下选择下级标题")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableNextLevel).onChange(async (value) => {
					this.plugin.settings.enableNextLevel = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleRefresh(0);
				})
			);

		let onItemToggle: ToggleComponent | null = null;

		new Setting(containerEl)
			.setName("悬浮展开下一级")
			.setDesc("菜单项有下级时，鼠标停在上面即自动铺开下一级（级联子菜单），不用点击；点击 ▸ 仍然是「追加到面包屑末尾」的下钻")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hoverExpandChildren)
					.onChange(async (value) => {
						this.plugin.settings.hoverExpandChildren = value;
						await this.plugin.saveSettings();
						if (onItemToggle) onItemToggle.setDisabled(!value);
					})
			);

		new Setting(containerEl)
			.setName("悬浮条目本体即展开")
			.setDesc("开启：鼠标停在菜单条目的任意位置就展开它的下一级；关闭：必须精确停在右侧的 ▸ 上才展开")
			.addToggle((toggle) => {
				onItemToggle = toggle;
				toggle
					.setDisabled(!this.plugin.settings.hoverExpandChildren)
					.setValue(this.plugin.settings.hoverExpandOnItem)
					.onChange(async (value) => {
						this.plugin.settings.hoverExpandOnItem = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("页面悬浮显示同标签页面")
			.setDesc("悬浮面包屑最前面的文件名时，列出与当前笔记有相同标签（frontmatter tags 或正文 #标签）的其他笔记")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableRelatedPages).onChange(async (value) => {
					this.plugin.settings.enableRelatedPages = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleRefresh(0);
				})
			);

		new Setting(containerEl)
			.setName("包含当前标题")
			.setDesc("把光标/滚动位置所在的标题本身也算作面包屑的最后一级")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeCurrentHeading).onChange(async (value) => {
					this.plugin.settings.includeCurrentHeading = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleRefresh(0);
				})
			);

		new Setting(containerEl)
			.setName("吸顶显示")
			.setDesc("滚动时面包屑固定在笔记顶部；关闭后随内容一起滚走")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.sticky).onChange(async (value) => {
					this.plugin.settings.sticky = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleRefresh(0);
				})
			);

		new Setting(containerEl)
			.setName("跟随光标")
			.setDesc("在编辑器里移动光标或滚动页面时，面包屑自动更新到当前所在标题")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.followCursor).onChange(async (value) => {
					this.plugin.settings.followCursor = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("菜单最多显示项数")
			.setDesc("悬浮菜单一次最多显示多少个条目")
			.addText((text) =>
				text
					.setPlaceholder("20")
					.setValue(String(this.plugin.settings.maxMenuItems))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.maxMenuItems = Number.isFinite(n) && n > 0 ? n : 20;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("p", {
			text: "面包屑显示在笔记顶部、文件路径（视图头部）的下方；点击某一级可跳转，列表项右侧的 ▸ 悬浮即展开下一级、点击则继续下钻。",
			cls: "setting-item-description",
		});
	}
}
