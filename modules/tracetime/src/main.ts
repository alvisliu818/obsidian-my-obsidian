import { MarkdownView, Plugin, TFile } from "obsidian";
import { Tracker } from "./tracker";
import { createEditorExtension } from "./editorExtension";
import { createReadingPostProcessor } from "./readingMode";
import { DEFAULT_SETTINGS, TraceTimeSettings, TraceTimeSettingTab } from "./settings";

export default class TraceTimePlugin extends Plugin {
	settings: TraceTimeSettings = { ...DEFAULT_SETTINGS };
	tracker!: Tracker;

	async onload() {
		const raw = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
		// 旧版设置键迁移
		if (raw && typeof raw["relativeMinutesLimit"] === "number" && typeof raw["minutesAgoLimit"] !== "number") {
			this.settings.minutesAgoLimit = raw["relativeMinutesLimit"];
		}

		this.tracker = new Tracker(this.app, this.manifest.dir!);
		await this.tracker.init();

		const getSettings = () => this.settings;
		this.registerEditorExtension(createEditorExtension(this.tracker, getSettings));
		this.registerMarkdownPostProcessor(createReadingPostProcessor(this.tracker, getSettings));

		this.addSettingTab(new TraceTimeSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (f instanceof TFile && f.extension === "md") void this.tracker.onVaultModify(f);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (f instanceof TFile && f.extension === "md") void this.tracker.onRename(f, oldPath);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (f instanceof TFile) this.tracker.onDelete(f.path);
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (f) => {
				if (f && f.extension === "md") void this.tracker.openFile(f);
				// 切换文件时把上一个文件的脏块落盘
				void this.tracker.flushDirty();
			})
		);

		// 文件关闭即清理内存状态（与编辑器撤销栈生命周期对齐）
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				const open = new Set<string>();
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView && leaf.view.file) {
						open.add(leaf.view.file.path);
					}
				});
				this.tracker.retainOnly(open);
			})
		);

		this.app.workspace.onLayoutReady(() => {
			const f = this.app.workspace.getActiveFile();
			if (f && f.extension === "md") void this.tracker.openFile(f);
		});

		this.applyLabelStyles();
	}

	/** 把字号等显示层设置应用到 CSS 变量，编辑/阅读两种模式共用。 */
	applyLabelStyles(): void {
		document.body.style.setProperty("--tracetime-font-size", `${this.settings.labelFontSize}px`);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// 设置只影响显示层，刷新两种模式的标签即可
		this.applyLabelStyles();
		this.tracker.refreshViews();
	}

	onunload() {
		this.tracker.dispose();
	}
}
