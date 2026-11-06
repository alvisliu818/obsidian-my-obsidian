/**
 * .user.js 安装对话框：解析头部元数据展示 + 确认安装。
 * 来源：点击 .user.js 链接自动弹出，或设置页「从 URL 安装」。
 */
import { App, Modal, Notice, requestUrl, Setting } from "obsidian";
import { parseUserScript } from "./parse";
import type { UserscriptHost } from "./userscriptHost";
import type { UserScriptRecord } from "../types";

export class InstallUserScriptModal extends Modal {
	constructor(
		app: App,
		private usHost: UserscriptHost,
		private sourceUrl: string,
		private prefetched?: string,
		private onInstalled?: (rec: UserScriptRecord) => void,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "安装用户脚本" });

	 let parsed: ReturnType<typeof parseUserScript> | null = null;
		try {
			const source: string = (this.prefetched ?? "") || String((await requestUrl({ url: this.sourceUrl, throw: false }).then((r) => (r.status >= 400 ? Promise.reject(new Error("下载失败：HTTP " + r.status)) : r.text))));
			parsed = parseUserScript(source, this.sourceUrl);
			if (!parsed) {
				contentEl.createDiv({ text: "该地址的内容不是有效的用户脚本（缺少 ==UserScript== 头）。" });
				return;
			}
		} catch (e) {
			contentEl.createDiv({ text: "获取脚本失败：" + String((e as Error)?.message ?? e) });
			return;
		}

		const rows: Array<[string, string]> = [
			["名称", parsed.name],
			["版本", parsed.version],
			["作者", parsed.author || "—"],
			["描述", parsed.description || "—"],
			["生效范围", parsed.matches.join(", ")],
			["注入时机", parsed.runAt === "document_start" ? "document_start" : parsed.runAt === "document_end" ? "document_end" : "document_idle"],
			["来源", this.sourceUrl],
		];
		for (const [k, v] of rows) {
			new Setting(contentEl).setName(k).setDesc(v.length > 120 ? v.slice(0, 120) + "…" : v);
		}

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("安装")
					.setCta()
					.onClick(() => {
						try {
							const rec = this.usHost.installFromSource(parsed!.code, this.sourceUrl);
							new Notice(`已安装用户脚本：${rec.name}`);
							this.close();
							if (this.onInstalled) this.onInstalled(rec);
						} catch (e) {
							contentEl.createDiv({ text: "安装失败：" + String((e as Error)?.message ?? e) });
						}
					}),
			)
			.addExtraButton((b) => b.setIcon("cross").setTooltip("取消").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
