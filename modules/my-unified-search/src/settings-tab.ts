import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./settings";
import { searchAnyTxt, searchEverything, syncAnyTxtIndex } from "./providers";
import type { UnifiedSearchPlugin } from "./main";

/** 自检：Everything 用一次极小查询验证端口与鉴权 */
async function probeEverything(cfg: UnifiedSearchPlugin["settings"]["everything"]): Promise<boolean> {
	try {
		const hits: unknown[] = await searchEverything("a", {
			baseUrl: cfg.baseUrl,
			limit: 1,
			username: cfg.username,
			password: cfg.password,
			timeoutMs: 3000,
		});
		// 拿到数组（哪怕 0 条）就说明服务端活着；连不上会 throw
		return Array.isArray(hits);
	} catch {
		return false;
	}
}

/** 自检：AnyTXT 发一次 GetResult，顺带回命中数 */
async function probeAnyTxt(
	cfg: UnifiedSearchPlugin["settings"]["anytxt"],
): Promise<{ ok: boolean; count: number }> {
	try {
		const hits = await searchAnyTxt("the", {
			url: cfg.url,
			limit: 1,
			filterDir: cfg.filterDir,
			filterExt: cfg.filterExt,
			timeoutMs: 3000,
		});
		return { ok: true, count: hits.length };
	} catch {
		return { ok: false, count: 0 };
	}
}

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
			text: "统一搜索 = 索引守护进程（logseq 模块拉起,better-sqlite3 + FTS5,库文件在 E:\\HOME\\Runtime\\unified-index）。守护进程没运行时无本地结果。语法：词与词 AND、\"短语\"、-排除、tag:/path:/ext:/backlink: 过滤。本地索引的重建/开关在 logseq 模块设置里。",
			cls: "setting-item-description",
		});

		containerEl.createEl("h3", { text: "外部搜索引擎（文件名 / 全文）" });
		containerEl.createEl("p", {
			text: "守护进程索引之外再挂两个本机引擎：Everything 秒搜全盘文件名，AnyTXT 搜文件内容（含 docx/pdf/图片 OCR）。结果合并进统一搜索面板，可用 ev: 只搜 Everything、at: 只搜 AnyTXT。工具没开或超时都不影响本地搜索。",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Everything（文件名）")
			.setDesc("需要先在 Everything 里启用 HTTP 服务器：工具 → 选项 → HTTP 服务器，记下端口填这里。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.everything.enabled).onChange(async (v) => {
					this.plugin.settings.everything.enabled = v;
					await this.plugin.saveData(this.plugin.settings);
					this.display();
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.everything.baseUrl)
					.setValue(this.plugin.settings.everything.baseUrl)
					.onChange(async (v) => {
						this.plugin.settings.everything.baseUrl = v.trim();
						await this.plugin.saveData(this.plugin.settings);
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("连通性自检")
					.onClick(async () => {
						const ok = await probeEverything(this.plugin.settings.everything);
						new Notice(
							ok
								? "Everything 已连通"
								: "Everything 连不上：确认已启用 HTTP 服务器且端口一致（工具→选项→HTTP 服务器）",
						);
					}),
			);

		new Setting(containerEl)
			.setName("AnyTXT（全文内容）")
			.setDesc("ATGUI 运行时自带 JSON-RPC（默认 9920）。目录过滤填盘符或路径，如 E: ；留空则用服务端默认（实测默认 C:）。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.anytxt.enabled).onChange(async (v) => {
					this.plugin.settings.anytxt.enabled = v;
					await this.plugin.saveData(this.plugin.settings);
					this.display();
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.anytxt.url)
					.setValue(this.plugin.settings.anytxt.url)
					.onChange(async (v) => {
						this.plugin.settings.anytxt.url = v.trim();
						await this.plugin.saveData(this.plugin.settings);
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("连通性自检")
					.onClick(async () => {
						const r = await probeAnyTxt(this.plugin.settings.anytxt);
						new Notice(
							r.ok
								? `AnyTXT 已连通（试搜命中 ${r.count} 条）`
								: "AnyTXT 连不上：确认 ATGUI 正在运行（RPC 在 ATGUI 进程内）",
						);
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("同步索引")
					.setTooltip("新文件或目录刚加进索引范围时，先同步一次才搜得到（等价 AnyTXT 的「立即更新索引」）")
					.onClick(async () => {
						const ok = await syncAnyTxtIndex(
							this.plugin.settings.anytxt.url,
							this.plugin.settings.anytxt.filterDir,
						);
						new Notice(ok ? "AnyTXT 索引同步已触发" : "同步失败：ATGUI 未运行？");
					}),
			);

		new Setting(containerEl)
			.setName("AnyTXT 目录过滤 / 扩展名过滤 / 取内容片段")
			.setDesc("片段会逐条再请求一次，只对前 5 条做，开启后会明显变慢。")
			.addText((text) =>
				text
					.setPlaceholder("E:")
					.setValue(this.plugin.settings.anytxt.filterDir)
					.onChange(async (v) => {
						this.plugin.settings.anytxt.filterDir = v.trim();
						await this.plugin.saveData(this.plugin.settings);
					}),
			)
			.addText((text) =>
				text
					.setPlaceholder("*")
					.setValue(this.plugin.settings.anytxt.filterExt)
					.onChange(async (v) => {
						this.plugin.settings.anytxt.filterExt = v.trim();
						await this.plugin.saveData(this.plugin.settings);
					}),
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.anytxt.snippet).onChange(async (v) => {
					this.plugin.settings.anytxt.snippet = v;
					await this.plugin.saveData(this.plugin.settings);
				}),
			);
	}
}
