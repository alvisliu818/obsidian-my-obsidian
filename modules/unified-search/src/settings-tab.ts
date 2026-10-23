import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./settings";
import { searchAnyTxt, searchEverything } from "./providers";
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
				"把 logseq 模块挂载的库外文本文件纳入索引。只收文本/源码类（md、txt、json、ts、py…），跳过二进制与依赖构建目录（node_modules、.git、__pycache__、dist…），单轮最多 5000 个（最近修改优先）、单文件 2MB 封顶。索引按浏览器空闲节奏推进，不与滚动/输入抢主线程。",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.indexExt).onChange(async (value) => {
					this.plugin.settings.indexExt = value;
					await this.plugin.saveData(this.plugin.settings);
					this.plugin.rearmExtRefresh();
				}),
			);

		new Setting(containerEl)
			.setName("挂载文件刷新间隔（分钟）")
			.setDesc("库外挂载文件无实时监听，按此间隔周期重扫（stat 门：未变文件免读）。0 = 关闭周期刷新。")
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.extRefreshMinutes))
					.setValue(String(this.plugin.settings.extRefreshMinutes))
					.onChange(async (value) => {
						const n = Math.max(0, Math.floor(Number(value) || 0));
						this.plugin.settings.extRefreshMinutes = n;
						await this.plugin.saveData(this.plugin.settings);
						this.plugin.rearmExtRefresh();
					}),
			);

		new Setting(containerEl)
			.setName("收录上限：库外挂载文件 / 库内文件 / 附件")
			.setDesc(
				"各类索引的数量上限，一律「最近修改优先」，超出部分不索引（附件的超限旧行会被裁掉，其 embed 链接退回悬空）。0 = 不限。改动后重启 Obsidian 或重建索引生效。",
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.maxExtFiles))
					.setValue(String(this.plugin.settings.maxExtFiles))
					.onChange(async (value) => {
						this.plugin.settings.maxExtFiles = Math.max(0, Math.floor(Number(value) || 0));
						await this.plugin.saveData(this.plugin.settings);
					}),
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.maxVaultFiles))
					.setValue(String(this.plugin.settings.maxVaultFiles))
					.onChange(async (value) => {
						this.plugin.settings.maxVaultFiles = Math.max(0, Math.floor(Number(value) || 0));
						await this.plugin.saveData(this.plugin.settings);
					}),
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.maxAttachments))
					.setValue(String(this.plugin.settings.maxAttachments))
					.onChange(async (value) => {
						this.plugin.settings.maxAttachments = Math.max(0, Math.floor(Number(value) || 0));
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		containerEl.createEl("h3", { text: "外部搜索引擎（文件名 / 全文）" });
		containerEl.createEl("p", {
			text: "磁盘索引之外再挂两个本机引擎：Everything 秒搜全盘文件名，AnyTXT 搜文件内容（含 docx/pdf/图片 OCR）。结果合并进统一搜索面板，可用 ev: 只搜 Everything、at: 只搜 AnyTXT。工具没开或超时都不影响本地索引。",
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
