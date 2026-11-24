/**
 * Life 模块设置页(2026-11-22 用户)。
 *
 * 宿主把模块 addSettingTab 截获进 capturedTabs,在设置页「Life」的齿轮下
 * 作为二级页内嵌渲染。本页承载:
 *  - 启动行为(HOME 自动打开);
 *  - HOME 组件排序(↑/↓,持久化到 settings.homeSectionOrder);
 *  - 库记录设置(复用 HOME 折叠面板的共享渲染层,行为完全一致)。
 */
import { App, PluginSettingTab, Setting } from 'obsidian';
import type LifePlugin from '../main';
import { HOME_SECTIONS, normalizeHomeSectionOrder, type HomeSectionId } from '../homeSections';
import { renderVaultLogSettingsInto } from '../views/vaultLogRender';

export class LifeSettingTab extends PluginSettingTab {
	plugin: LifePlugin;

	constructor(app: App, plugin: LifePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.store.settings;

		containerEl.createEl('h3', { text: '启动' });
		new Setting(containerEl)
			.setName('启动时打开 HOME')
			.setDesc('Obsidian 启动完成后自动打开 HOME 标签页。')
			.addToggle((t) =>
				t.setValue(s.homeOpenOnStartup !== false).onChange((v) => {
					s.homeOpenOnStartup = v;
					this.plugin.store.scheduleSave();
				}),
			);

		containerEl.createEl('h3', { text: 'HOME 大日历' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: '点 HOME 大日历里的日期可切换当日明细;文件变化来自库记录(今天为实时对比)。',
		});
		new Setting(containerEl)
			.setName('显示新增文件')
			.setDesc('在当日明细中列出当天新增的库内文件。')
			.addToggle((t) =>
				t.setValue(s.homeCalendarShowAdded !== false).onChange((v) => {
					s.homeCalendarShowAdded = v;
					this.plugin.store.scheduleSave();
					this.plugin.refreshHomeViews();
				}),
			);
		new Setting(containerEl)
			.setName('显示修改文件')
			.setDesc('在当日明细中列出当天修改的库内文件。')
			.addToggle((t) =>
				t.setValue(s.homeCalendarShowModified !== false).onChange((v) => {
					s.homeCalendarShowModified = v;
					this.plugin.store.scheduleSave();
					this.plugin.refreshHomeViews();
				}),
			);

		containerEl.createEl('h3', { text: 'HOME 组件排序' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'HOME 页各区块的展示顺序。用 ↑/↓ 调整,修改立即生效并保存。',
		});
		const orderHost = containerEl.createDiv();
		this.renderOrderRows(orderHost);

		containerEl.createEl('h3', { text: '库记录' });
		renderVaultLogSettingsInto(containerEl, s.vaultLog, () => {
			this.plugin.store.scheduleSave();
			void this.plugin.refreshEditorDiffs();
		});
	}

	/** 排序列表:每次调整后就地重建本区(不整页 display,保住滚动位置)。 */
	private renderOrderRows(host: HTMLElement): void {
		host.empty();
		const s = this.plugin.store.settings;
		const order = normalizeHomeSectionOrder(s.homeSectionOrder);
		const save = (next: HomeSectionId[]): void => {
			s.homeSectionOrder = next;
			this.plugin.store.scheduleSave();
			this.plugin.refreshHomeViews();
			this.renderOrderRows(host);
		};
		order.forEach((id, i) => {
			const def = HOME_SECTIONS.find((x) => x.id === id);
			const row = new Setting(host).setName(def?.name ?? id);
			row.settingEl.dataset.homeSection = id;
			if (i > 0) {
				row.addExtraButton((b) =>
					b.setIcon('arrow-up').setTooltip('上移').onClick(() => {
						const next = [...order];
						[next[i - 1], next[i]] = [next[i], next[i - 1]];
						save(next);
					}),
				);
			}
			if (i < order.length - 1) {
				row.addExtraButton((b) =>
					b.setIcon('arrow-down').setTooltip('下移').onClick(() => {
						const next = [...order];
						[next[i + 1], next[i]] = [next[i], next[i + 1]];
						save(next);
					}),
				);
			}
		});
		new Setting(host).setName('恢复默认顺序').addButton((b) =>
			b.setButtonText('恢复').onClick(() => save(normalizeHomeSectionOrder(null))),
		);
	}
}
