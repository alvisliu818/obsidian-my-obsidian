/**
 * webview session 的 webRequest 管线（移植自 siyuan-plugin-browser BrowserTab
 * 的 registerWebRequest，改为**每 partition 注册一次**——Electron 的
 * session.webRequest.onXxx 是单听众语义，重复注册只会覆盖；思源版每个页签
 * 重注册实际是"最后一个页签赢"，这里显式化）。
 *
 * 三层（对齐 Chrome 的网络层能力；Electron 无 DNR，用规则引擎等价实现）：
 *   0. onBeforeRequest：chrome-extension/data 直通 → 扩展 webRequest 阻塞桥
 *      （B2 接入）→ .user.js 安装链（B2 接入）→ DNR 规则引擎阻断
 *   1. onHeadersReceived：剥 CSP / CSP-report-only / X-Frame-Options
 *      （Electron 的 responseHeaders 值必须是 string[]——曾因再包一层造成
 *      嵌套数组，Set-Cookie 多值头写坏，cookie 累积后请求头爆掉）
 *   2. onBeforeSendHeaders：请求级 UA（商店域名恒伪装 Edge，其余用自定义
 *      UA 设置）+ Referer 注入（站点 CDN 检测到空 Referer 会 403）
 */
import type { BrowserSettings } from "../types";
import { dnrBlocker } from "./dnrEngine";
import { EDGE_UA } from "../extensions/edgeStore";
import { isEdgeAddonsSiteUrl } from "../extensions/edgeStoreHelper";

export interface WebRequestPipelineOpts {
	getSettings: () => BrowserSettings;
	/** 当前活动页签的 URL（Referer 兜底用；空串则退化为目标 origin）。 */
	activeTabUrl: () => string;
	/** 扩展 webRequest 阻塞桥（wrBridge.ts 实例的 ducks 形状）。 */
	extBridge?: { maybeDispatchWr(url: string, rtDnr: string | null, details: any, cb: (r: any) => void): boolean };
	/** .user.js mainFrame 导航（userJsInstall.ts 的 onUserJsNavigation；管线先 cb cancel）。 */
	onUserJs?: (url: string, resourceType: string) => void;
}

export interface WebRequestPipeline {
	unbind(): void;
}

export function bindWebRequestPipeline(session: any, opts: WebRequestPipelineOpts): WebRequestPipeline {
	const onBeforeRequest = (details: any, cb: (r: any) => void): void => {
		try {
			const url = details?.url || "";
			if (/^chrome-extension:/i.test(url) || /^data:/i.test(url)) {
				cb({});
				return;
			}
			const rt = String(details?.resourceType || "");
			const rtDnr = RT_MAP[rt] || rt || null;
			if (/\.user\.js(?:[?#]|$)/i.test(url) && rt === "mainFrame" && !/script_installation\.php/i.test(url)) {
				// .user.js 导航：管线先 cancel，安装链接管（合成下载事件 + 回落弹窗）
				if (opts.onUserJs) {
					cb({ cancel: true });
					opts.onUserJs(url, rt);
					return;
				}
			}
			if (opts.extBridge?.maybeDispatchWr(url, rtDnr ?? "", details, cb)) {
				return; // cb 由阻塞桥派发路径回调
			}
			const s = opts.getSettings();
			if (s.adBlockEnabled && dnrBlocker.shouldBlock(url, rt, details?.referrer || "")) {
				cb({ cancel: true });
				return;
			}
		} catch {
			/* fail-open */
		}
		cb({});
	};

	const onHeadersReceived = (details: any, cb: (r: any) => void): void => {
		try {
			const out: Record<string, string[]> = {};
			if (details?.responseHeaders) {
				for (const key of Object.keys(details.responseHeaders)) {
					const lower = key.toLowerCase();
					if (lower === "content-security-policy" || lower === "content-security-policy-report-only" || lower === "x-frame-options") {
						continue;
					}
					const v = details.responseHeaders[key];
					out[key] = Array.isArray(v) ? v : [String(v)];
				}
			}
			cb({ responseHeaders: out });
		} catch {
			cb({});
		}
	};

	const onBeforeSendHeaders = (details: any, cb: (r: any) => void): void => {
		const reqUrl = details.url || "";
		if (!/^https?:\/\//i.test(reqUrl)) {
			cb({});
			return;
		}
		try {
			const headers: Record<string, string> = {};
			if (details?.requestHeaders) {
				for (const k of Object.keys(details.requestHeaders)) {
					const v = details.requestHeaders[k];
					headers[k] = Array.isArray(v) ? String(v[0]) : String(v);
				}
			}
			// 2a) 请求级 UA：商店域名伪装 Edge（首导航请求改 UA 只能在这层，
			//     webview 的 setUserAgent 要等 attach+dom-ready）
			const ua = uaForRequest(reqUrl, opts.getSettings());
			if (ua) headers["User-Agent"] = ua;
			// 2b) Referer：已有合法 http(s) referer → 不动；否则用活动页签 URL
			//     （或目标 origin）补上，绕过 CDN 的 EmptyReferer 403
			const referrer = details.referrer || "";
			if (!(referrer && /^https?:\/\//i.test(referrer))) {
				const current = opts.activeTabUrl() || "";
				let refUrl = /^https?:\/\//i.test(current) ? current : "";
				if (!refUrl) {
					try {
						refUrl = new URL(reqUrl).origin + "/";
					} catch {
						/* keep empty */
					}
				}
				if (refUrl) headers["Referer"] = refUrl;
			}
			cb({ requestHeaders: headers });
		} catch {
			cb({});
		}
	};

	session.webRequest.onBeforeRequest(onBeforeRequest);
	session.webRequest.onHeadersReceived(onHeadersReceived);
	session.webRequest.onBeforeSendHeaders(onBeforeSendHeaders);
	console.log("[ob-browser] webRequest pipeline registered (CSP strip + referer inject + DNR)");

	return {
		unbind() {
			try {
				session.webRequest.onBeforeRequest(null);
				session.webRequest.onHeadersReceived(null);
				session.webRequest.onBeforeSendHeaders(null);
			} catch {
				/* session gone */
			}
		},
	};
}

/** Electron webRequest resourceType（camelCase）→ DNR resourceTypes（snake_case） */
const RT_MAP: Record<string, string> = {
	mainFrame: "main_frame",
	subFrame: "sub_frame",
	xhr: "xmlhttprequest",
	cspReport: "csp_report",
	webSocket: "websocket",
	webTransport: "webtransport",
};

/** 请求级 UA（webRequest 层用，不依赖 webview 就绪状态）：商店域名恒伪装
 *  Edge；其余仅在用户自定义 UA 时注入（无自定义时不动，免得污染默认头）。 */
function uaForRequest(reqUrl: string, s: BrowserSettings): string | null {
	try {
		if (isEdgeAddonsSiteUrl(reqUrl)) return EDGE_UA;
		return s.userAgent || null;
	} catch {
		return null;
	}
}
