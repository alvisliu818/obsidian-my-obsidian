/**
 * 浏览器 webview session 的网络代理管理（移植自 siyuan-plugin-browser/src/browser/proxy.ts）。
 *
 * 背景：webview 使用独立 partition（persist:obsidian-browser），Electron 的会话级代理
 * 配置互不继承 —— Obsidian 本体 session 的代理不会自动作用到该会话。这里按插件设置
 * 显式调用 session.setProxy()。
 *
 * 与思源版的差异：思源的 proxyMode 有 'siyuan'（读内核 networkProxy）——Obsidian
 * 没有内核代理，只剩 system（Chromium 默认，跟随系统）/ custom 两种。
 */
import type { BrowserSettings } from "../types";
import { sessionFromPartition } from "../utils/electron";

/** session.setProxy 的配置对象（Electron ProxyConfig 子集） */
interface IProxyConfig {
	mode?: "direct" | "system" | "auto_detect" | "pac_script" | "fixed_servers";
	proxyRules?: string;
	proxyBypassRules?: string;
}

/** 按插件设置把代理应用到 webview 会话（persist:obsidian-browser）。 */
export async function applyProxyToSession(settings: BrowserSettings): Promise<boolean> {
	const session = sessionFromPartition(settings.partition);
	if (!session?.setProxy) {
		console.warn("[ob-browser] no session for setProxy (@electron/remote unavailable?)");
		return false;
	}
	const cfg = buildProxyConfig(settings);
	try {
		await session.setProxy(cfg);
		console.log("[ob-browser] webview proxy applied:", JSON.stringify(cfg));
		return true;
	} catch (e) {
		console.warn("[ob-browser] setProxy failed:", e);
		return false;
	}
}

/**
 * 根据设置解析 setProxy 配置：
 * custom 且 URL 非空 → proxyRules（http/https/socks5://host:port，或
 * `http=…;https=…` 多规则串，Electron 原生语义）；空/失败回退 system。
 */
function buildProxyConfig(s: BrowserSettings): IProxyConfig {
	const mode = s.proxyMode || "system";
	if (mode === "custom") {
		const url = (s.proxyCustomUrl || "").trim();
		if (url) return { proxyRules: url };
		console.warn("[ob-browser] custom proxy URL is empty, falls back to system proxy");
		return { mode: "system" };
	}
	// system：跟随系统代理设置（Chromium 默认行为）
	return { mode: "system" };
}
