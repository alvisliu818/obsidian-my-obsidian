/**
 * obsidian-doc-assist — 文档加工流水线。
 *
 * 移植自 siyuan-doc-assist(https://github.com/famotime/siyuan-doc-assist)，
 * 六大场景：关键信息提炼 / 剪藏清洗 / 双链整理 / AI 赋能 / 对照写作 / 图片瘦身。
 *
 * 当前为 v0.1.0 工程骨架：生命周期 + 设置(AI 接口) + 路线图锚点。
 * 功能模块按 README.md 的路线图逐块落地；每个模块落地时在对应锚点注册。
 */

import { Plugin, PluginSettingTab, App, Setting } from 'obsidian';

import { registerDocAssistCommands } from './plugin/commands';

export interface DocAssistSettings {
	/** OpenAI 兼容 API 地址(如 https://api.openai.com/v1) */
	aiBaseUrl: string;
	/** API Key(仅存本地 data.json) */
	aiApiKey: string;
	/** 模型名(翻译/摘要/标题/OCR 可分别覆盖，留空用默认) */
	aiModel: string;
	/** 高亮语法标记(==text==，Obsidian Markdown Highlights 风格) */
	highlightMarker: string;
}

const DEFAULT_SETTINGS: DocAssistSettings = {
	aiBaseUrl: 'https://api.openai.com/v1',
	aiApiKey: '',
	aiModel: 'gpt-4o-mini',
	highlightMarker: '==',
};

export default class DocAssistPlugin extends Plugin {
	settings: DocAssistSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		// ---- 路线图锚点(按 README 路线图逐块落地后替换) ----
		// 场景一 关键信息: 侧边栏 View(关键信息聚合/筛选/跳转/导出)
		// 场景二 剪藏清洗: 编辑器命令(断尾求真/AI 报告清理/排版修复) —— v0.2 已落地
		registerDocAssistCommands(this);
		// 场景三 双链整理: 反链/出链列表插入(去重)、链接⇋嵌入互转、死链标示
		// 场景四 AI 赋能: 逐段翻译/图片 OCR/更好标题/摘要与概念地图
		// 场景五 对照写作: 浮动窗(置顶半透明渲染面板)
		// 场景六 图片瘦身: WebP/PNG 批量转换、按显示尺寸重采样、删除本文档图片

		this.addSettingTab(new DocAssistSettingTab(this.app, this));
	}

	onunload(): void {
		// 各模块的注册项(registerView/command/event)由 Obsidian 随卸载统一回收。
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class DocAssistSettingTab extends PluginSettingTab {
	plugin: DocAssistPlugin;

	constructor(app: App, plugin: DocAssistPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Doc Assist 设置' });

		new Setting(containerEl)
			.setName('AI 接口地址')
			.setDesc('OpenAI 兼容格式 API 的 Base URL')
			.addText((text) =>
				text
					.setPlaceholder('https://api.openai.com/v1')
					.setValue(this.plugin.settings.aiBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings.aiBaseUrl = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('仅保存在本地 data.json，不会同步')
			.addText((text) => {
				text.inputEl.type = 'password';
				return text
					.setValue(this.plugin.settings.aiApiKey)
					.onChange(async (v) => {
						this.plugin.settings.aiApiKey = v;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('默认模型')
			.setDesc('翻译 / 摘要 / 标题 / OCR 共用的模型名')
			.addText((text) =>
				text
					.setPlaceholder('gpt-4o-mini')
					.setValue(this.plugin.settings.aiModel)
					.onChange(async (v) => {
						this.plugin.settings.aiModel = v;
						await this.plugin.saveSettings();
					}),
			);
	}
}
