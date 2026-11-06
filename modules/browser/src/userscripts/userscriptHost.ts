/**
 * 原生用户脚本宿主：安装/管理/注入负载。
 *
 * 设计（2026-11-07）：嵌入式 webview 没有真正的扩展宿主，暴力猴这类
 * userscript 管理器扩展的后台 SW 不运行、安装页（chrome-extension://）也
 * 加载不了——装脚本流程是结构性断裂的。本宿主把 .user.js 变成一等公民：
 * 检测 → 原生对话框 → store 持久化 → 注入时补 GM_* 前奏，不再依赖暴力猴。
 */
import { requestUrl } from "obsidian";
import { parseUserScript, userScriptMatches } from "./parse";
import { withGmPrelude } from "./gm-prelude";
import type { UserScriptRecord } from "../types";

export interface UserscriptPayload {
	css: string[];
	js: string[];
}

export class UserscriptHost {
	constructor(
		private getData: () => UserScriptRecord[],
		private save: () => void,
	) {}

	list(): UserScriptRecord[] {
		return this.getData();
	}

	/** 解析并安装（同名同 namespace 视为更新，保留启用状态）。 */
	installFromSource(source: string, sourceUrl: string): UserScriptRecord {
		const parsed = parseUserScript(source, sourceUrl);
		if (!parsed) throw new Error("不是有效的用户脚本（缺少 ==UserScript== 头）");
		const rec: UserScriptRecord = {
			id: "us-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
			...parsed,
			enabled: true,
			installedAt: Date.now(),
			sourceUrl,
		};
		const data = this.getData();
		const i = data.findIndex((r) => r.name === rec.name && (r.namespace ?? "") === (rec.namespace ?? ""));
		if (i >= 0) data[i] = { ...rec, enabled: data[i].enabled, installedAt: data[i].installedAt };
		else data.push(rec);
		this.save();
		return data[i >= 0 ? i : data.length - 1];
	}

	async installFromUrl(url: string): Promise<UserScriptRecord> {
		const resp = await requestUrl({ url, throw: false });
		if (resp.status >= 400) throw new Error("下载失败：HTTP " + resp.status);
		return this.installFromSource(resp.text, url);
	}

	remove(id: string): void {
		const data = this.getData();
		const i = data.findIndex((r) => r.id === id);
		if (i >= 0) {
			data.splice(i, 1);
			this.save();
		}
	}

	setEnabled(id: string, enabled: boolean): void {
		const rec = this.getData().find((r) => r.id === id);
		if (rec) {
			rec.enabled = enabled;
			this.save();
		}
	}

	// ---------------- 注入负载 ----------------

	/** document_start 档（与扩展 content script 负载同形，调用方合并）。 */
	documentStartPayload(url: string): UserscriptPayload {
		const out: UserscriptPayload = { css: [], js: [] };
		for (const rec of this.getData()) {
			if (!rec.enabled) continue;
			if (rec.runAt !== "document_start") continue;
			if (!userScriptMatches(rec.matches, rec.excludeMatches, url)) continue;
			out.js.push(withGmPrelude(rec));
		}
		return out;
	}

	/** document_end / document_idle 档（宿主在 dom-ready 时执行）。 */
	documentEndScripts(url: string): string[] {
		const out: string[] = [];
		for (const rec of this.getData()) {
			if (!rec.enabled) continue;
			if (rec.runAt === "document_start") continue;
			if (!userScriptMatches(rec.matches, rec.excludeMatches, url)) continue;
			out.push(withGmPrelude(rec));
		}
		return out;
	}

	/** 在页面里执行一条用户脚本负载（document_end 路径用）。 */
	async injectScript(webview: { executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }, code: string): Promise<void> {
		await webview.executeJavaScript(code, false).catch(() => undefined);
	}
}
