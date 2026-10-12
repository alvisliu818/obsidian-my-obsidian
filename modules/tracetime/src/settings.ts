import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type TraceTimePlugin from "./main";
import { DEFAULT_SETTINGS, formatTimestamp, renderDateFormat, TraceTimeSettings } from "./format";

export { DEFAULT_SETTINGS };
export type { TraceTimeSettings };

/** “完整日期格式”的预设项：下拉框里直接渲染成实际效果，不用看懂占位符 */
const DATE_FORMAT_PRESETS = [
	"YYYY-MM-DD HH:mm",
	"YY-MM-DD HH:mm",
	"MM-DD HH:mm",
	"M月D日 HH:mm",
	"M月D日",
	"M月第W周 HH:mm",
	"M月第W周",
	"HH:mm MM/DD YY",
	"HH:mm MM-DD",
	"HH:mm M/D",
	"HH:mm M月D日",
];
const CUSTOM_FORMAT = "__custom__";

function parseNonNegativeInt(value: string, fallback: number): number {
	const n = Number.parseInt(value.trim(), 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class TraceTimeSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TraceTimePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		// 实时预览：一组不同年龄样本按当前规则渲染，改任何选项立即刷新
		const previewEl = containerEl.createDiv({ cls: "tracetime-settings-preview" });
		const updatePreview = () => this.renderPreview(previewEl);
		updatePreview();

		new Setting(containerEl)
			.setName("显示规则")
			.setDesc("按从上到下的顺序匹配，命中即停；关闭某档会落到下一档，最后由完整日期格式兜底。")
			.setHeading();

		this.addThresholdRung(containerEl, updatePreview, {
			name: "1. 刚刚",
			example: "例：2 分钟前编辑的块 → 刚刚",
			unit: "分钟",
			get: () => settings.justNowMinutes,
			fallback: DEFAULT_SETTINGS.justNowMinutes,
			set: (v) => (settings.justNowMinutes = v),
		});

		this.addThresholdRung(containerEl, updatePreview, {
			name: "2. N 分钟前",
			example: "例：45 分钟前编辑的块 → 45 分钟前",
			unit: "分钟",
			get: () => settings.minutesAgoLimit,
			fallback: DEFAULT_SETTINGS.minutesAgoLimit,
			set: (v) => (settings.minutesAgoLimit = v),
		});

		this.addThresholdRung(containerEl, updatePreview, {
			name: "3. N 小时前",
			example: "例：3 小时前编辑的块 → 3 小时前（想在今天显示几点几分就关掉这档、打开下一档）",
			unit: "小时",
			get: () => settings.hoursAgoLimit,
			fallback: DEFAULT_SETTINGS.hoursAgoLimit,
			set: (v) => (settings.hoursAgoLimit = v),
		});

		new Setting(containerEl)
			.setName("4. 今天只显示时间")
			.setDesc("今天编辑的块显示「14:35」。和上一档互斥：都开时“N 小时前”优先")
			.addToggle((toggle) =>
				toggle.setValue(settings.todayTimeOnly).onChange(async (value) => {
					settings.todayTimeOnly = value;
					await this.plugin.saveSettings();
					updatePreview();
				})
			);

		new Setting(containerEl)
			.setName("5. 昨天显示“昨天 HH:mm”")
			.setDesc("昨天编辑的块显示「昨天 18:05」")
			.addToggle((toggle) =>
				toggle.setValue(settings.yesterdayWithTime).onChange(async (value) => {
					settings.yesterdayWithTime = value;
					await this.plugin.saveSettings();
					updatePreview();
				})
			);

		this.addThresholdRung(containerEl, updatePreview, {
			name: "6. N 天前",
			example: "例：5 天前编辑的块 → 5 天前",
			unit: "天",
			get: () => settings.daysAgoLimit,
			fallback: 30,
			set: (v) => (settings.daysAgoLimit = v),
		});

		new Setting(containerEl)
			.setName("7. 今年显示“MM-DD”")
			.setDesc("今年更早的块显示「03-08」，跨年走完整格式")
			.addToggle((toggle) =>
				toggle.setValue(settings.thisYearShort).onChange(async (value) => {
					settings.thisYearShort = value;
					await this.plugin.saveSettings();
					updatePreview();
				})
			);

		new Setting(containerEl)
			.setName("标签字号")
			.setDesc("时间标签的字号（px），默认比正文小一点")
			.addSlider((slider) =>
				slider
					.setLimits(9, 20, 1)
					.setValue(settings.labelFontSize)
					.onChange(async (value) => {
						settings.labelFontSize = value;
						await this.plugin.saveSettings();
						updatePreview();
					})
			);

		new Setting(containerEl)
			.setName("标签垂直位置")
			.setDesc("时间标签显示在块的哪个高度：首行/末行是该行的行内居中，中间是整个块的垂直居中")
			.addDropdown((drop) =>
				drop
					.addOption("start", "块首行")
					.addOption("middle", "块中间")
					.addOption("end", "块末行")
					.setValue(settings.labelVertical)
					.onChange(async (value) => {
						settings.labelVertical = value as TraceTimeSettings["labelVertical"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("紧凑模式")
			.setDesc("关闭「限制行宽」时，标签收起为右缘的小圆点，鼠标悬停才展开完整时间；开启「限制行宽」时始终完整显示")
			.addToggle((toggle) =>
				toggle.setValue(settings.compactLabels).onChange(async (value) => {
					settings.compactLabels = value;
					await this.plugin.saveSettings();
				})
			);

		const formatNow = new Date();
		const isCustomFormat = !DATE_FORMAT_PRESETS.includes(settings.dateFormat);

		let customFormatSetting: Setting;
		new Setting(containerEl)
			.setName("完整日期格式")
			.setDesc("以上档位都没命中时的兜底显示，选项就是实际效果")
			.addDropdown((drop) => {
				for (const p of DATE_FORMAT_PRESETS) drop.addOption(p, renderDateFormat(p, formatNow));
				drop.addOption(CUSTOM_FORMAT, "自定义…");
				drop.setValue(isCustomFormat ? CUSTOM_FORMAT : settings.dateFormat).onChange(async (value) => {
					if (value === CUSTOM_FORMAT) {
						customFormatSetting.settingEl.show();
					} else {
						customFormatSetting.settingEl.hide();
						settings.dateFormat = value;
						await this.plugin.saveSettings();
						updatePreview();
					}
				});
			});

		customFormatSetting = new Setting(containerEl)
			.setName("自定义格式")
			.setDesc(
				"占位符：YYYY=4位年 YY=2位年 MM=月 M=月不补零 DD=日 D=日不补零 HH=时 mm=分 W=当月第几周。" +
					"例：M月D日 → 7月22日；M月第W周 → 7月第4周"
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.dateFormat)
					.setValue(settings.dateFormat)
					.onChange(async (value) => {
						settings.dateFormat = value.trim() || DEFAULT_SETTINGS.dateFormat;
						await this.plugin.saveSettings();
						updatePreview();
					})
			);
		if (!isCustomFormat) customFormatSetting.settingEl.hide();

		new Setting(containerEl)
			.setName("回滚时间戳")
			.setDesc(
				"每次写入前都会自动留一份上一代备份。时间戳被误刷后，可用当前打开文件的备份恢复；回滚本身也会留档，可再次滚回。"
			)
			.addButton((button) =>
				button.setButtonText("恢复当前文件的备份").onClick(async () => {
					const file = this.app.workspace.getActiveFile();
					if (!file || file.extension !== "md") {
						new Notice("TraceTime: 请先打开一个 Markdown 文件");
						return;
					}
					const ok = await this.plugin.tracker.restoreFromBackup(file);
					new Notice(ok ? "TraceTime: 已从备份恢复时间戳" : "TraceTime: 该文件没有可用备份");
				})
			);
	}

	/** 带“开关 + 阈值输入”的档位行；关闭 = 阈值存 0，重新开启时恢复输入框里的值 */
	private addThresholdRung(
		containerEl: HTMLElement,
		updatePreview: () => void,
		rung: {
			name: string;
			example: string;
			unit: string;
			get: () => number;
			fallback: number;
			set: (v: number) => void;
		}
	): void {
		let textInput: TextComponent;
		new Setting(containerEl)
			.setName(rung.name)
			.setDesc(`${rung.example}。阈值单位：${rung.unit}`)
			.addText((text) => {
				textInput = text;
				text
					.setPlaceholder(String(rung.fallback))
					.setValue(String(rung.get() || rung.fallback))
					.setDisabled(rung.get() <= 0)
					.onChange(async (value) => {
						rung.set(parseNonNegativeInt(value, rung.fallback));
						await this.plugin.saveSettings();
						updatePreview();
					});
			})
			.addToggle((toggle) =>
				toggle.setValue(rung.get() > 0).onChange(async (value) => {
					rung.set(value ? parseNonNegativeInt(textInput.getValue(), rung.fallback) : 0);
					textInput.setDisabled(!value);
					await this.plugin.saveSettings();
					updatePreview();
				})
			);
	}

	private renderPreview(el: HTMLElement): void {
		el.empty();
		el.createDiv({ cls: "tracetime-preview-title", text: "实时预览" });
		const now = new Date();
		const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 0);
		const samples: [string, Date][] = [
			["30 秒前编辑", new Date(now.getTime() - 30 * 1000)],
			["2 分钟前编辑", new Date(now.getTime() - 2 * 60000)],
			["45 分钟前编辑", new Date(now.getTime() - 45 * 60000)],
			["3 小时前编辑", new Date(now.getTime() - 3 * 3600000)],
			["10 小时前编辑", new Date(now.getTime() - 10 * 3600000)],
			["昨天 18:00 编辑", yesterday],
			["5 天前编辑", new Date(now.getTime() - 5 * 86400000)],
			["40 天前编辑", new Date(now.getTime() - 40 * 86400000)],
			["200 天前编辑", new Date(now.getTime() - 200 * 86400000)],
		];
		for (const [label, at] of samples) {
			const row = el.createDiv({ cls: "tracetime-preview-row" });
			row.createSpan({ cls: "tracetime-preview-sample", text: label });
			const result = row.createSpan({
				cls: "tracetime-preview-result",
				text: formatTimestamp(Math.floor(at.getTime() / 60000), this.plugin.settings, now),
			});
			result.style.fontSize = `${this.plugin.settings.labelFontSize}px`;
		}
	}
}
