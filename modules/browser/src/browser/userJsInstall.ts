/**
 * .user.js 安装链（暴力猴/Violentmonkey 版）+ 扩展 webRequest 阻塞桥 +
 * webNavigation 合成 —— 移植自 siyuan-plugin-browser BrowserTab.ts:373-784
 * （__sy* → __ob*；2026-11-04 用户决定：闭源油猴 TM 链路整体移除，只兼容
 * 开源的暴力猴）。
 *
 * 三块能力：
 *  1. webRequest 阻塞桥：拉取各扩展 SW 暴露的监听器 filter 快照
 *     （__obWebRequestFilters），webRequest 层 filter 命中的扩展 SW 合成派发
 *     onBeforeRequest，收 {cancel/redirectUrl}；派发后排空 tabs.create 出箱
 *     （VM confirm 页等由宿主真实开页签）。
 *  2. webNavigation.onCommitted 合成派发：VM 的 .user.js 安装检测依赖导航
 *     事件流；派发后多点排空 tabs 出箱。
 *  3. .user.js 暴力猴安装链：mainFrame 导航命中 .user.js → cancel + 合成
 *     downloads.onCreated（VM 的安装入口）→ 多轮 wr 派发/排空等 VM 自己的
 *     confirm 页弹出；超时且 VM 带 chrome.userScripts（MV3 内核）才回落
 *     宿主确认弹窗直装（注册进 VM 的 userScripts 注册表，垫片持久化，
 *     userscriptInjector 自动在匹配页面执行，GM_* 由注入前奏补齐）。
 */
import { Notice } from "obsidian";

export interface ExtRef {
	electronId?: string;
	name: string;
	native?: boolean;
}

interface WrFilter {
	ev: string;
	urls: string[] | null;
	types: string[] | null;
}

interface PendingUserJs {
	url: string;
	askOpened: boolean;
}

interface PendingInstall {
	url: string;
	code: string;
	name: string;
	version: string;
	author: string;
	description: string;
	matches: string[];
	electronId: string;
	extName: string;
}

export interface UserJsChainOpts {
	/** 已启用且原生加载的扩展清单（name + electronId）。 */
	listExts: () => ExtRef[];
	/** 直装副本比对用（usInjector.registry()）。 */
	getRegistry?: () => Map<string, Map<string, any>> | null;
	/** 在扩展 SW 里求值（内部有唤醒/兜底通道）。 */
	evalInSw: (electronId: string, expr: string) => Promise<{ value?: any; err?: string } | null>;
	/** 宿主开新页签（tabs.create 出箱的落点）。 */
	openUrl: (url: string) => void;
	/** 活动页签 URL（派发 details.initiator 用）。 */
	activeUrl: () => string;
}

export class UserJsChain {
	/** webRequest filter 快照缓存：electronId → filters[] */
	private wrBridgeCache = new Map<string, WrFilter[]>();
	private wrBridgeCacheAt = 0;
	private pendingUserJs: PendingUserJs | null = null;
	private pendingInstalls = new Map<string, PendingInstall>();
	private installDialogShownAt = new Map<string, number>();
	private pendingInstallDialogs = new Set<HTMLElement>();

	constructor(private opts: UserJsChainOpts) {}

	// ------------------------------------------------------------------
	// webRequest 阻塞桥
	// ------------------------------------------------------------------

	/** 刷新阻塞桥缓存：拉取各扩展 SW 里暴露的监听器 filter 快照 */
	async refreshWrBridge(force = false): Promise<void> {
		if (!force && Date.now() - this.wrBridgeCacheAt < 30000) return;
		this.wrBridgeCacheAt = Date.now();
		try {
			const expr =
				"(function () { var f = self.__obWebRequestFilters || {}; var out = []; for (var ev in f) { var fs = f[ev] || []; for (var i = 0; i < fs.length; i++) { out.push({ ev: ev, urls: fs[i] ? fs[i].urls : null, types: fs[i] ? fs[i].types : null }); } } return JSON.stringify(out); })()";
			for (const e of this.opts.listExts()) {
				if (!e.native || !e.electronId) continue;
				const eid = e.electronId;
				const r = await this.opts.evalInSw(eid, expr).catch(() => null);
				try {
					const arr = JSON.parse(String(r?.value || "[]"));
					if (Array.isArray(arr) && arr.length) this.wrBridgeCache.set(eid, arr);
					else this.wrBridgeCache.delete(eid);
				} catch {
					/* bad json */
				}
			}
		} catch {
			/* ignore */
		}
	}

	/** webRequest filter 匹配（urls 通配 + types） */
	private wrFilterMatches(f: WrFilter, url: string, rtDnr: string | null): boolean {
		try {
			if (f.types && f.types.length && (!rtDnr || !f.types.includes(rtDnr))) return false;
			if (f.urls && f.urls.length) {
				const hit = f.urls.some((pat) => {
					try {
						const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
						return re.test(url);
					} catch {
						return false;
					}
				});
				if (!hit) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	/** 阻塞桥派发收集：向 filter 命中的扩展 SW 合成派发，汇总 {cancel/redirectUrl}。 */
	private async dispatchWrCollect(url: string, rtDnr: string | null, details: any): Promise<{ cancel?: boolean; redirectUrl?: string } | null> {
		const tasks: Array<Promise<{ cancel?: boolean; redirectUrl?: string } | null>> = [];
		const initiator = this.opts.activeUrl() || "";
		for (const [eid, entries] of this.wrBridgeCache) {
			const evs = entries.filter((f) => f.ev === "onBeforeRequest" && this.wrFilterMatches(f, url, rtDnr));
			if (!evs.length) continue;
			const d = {
				url,
				method: String(details?.method || "GET"),
				type: rtDnr || "other",
				resourceType: rtDnr || "other",
				frameId: 0,
				parentFrameId: -1,
				requestId: String(details?.requestId || "ob-" + Date.now()),
				tabId: 1,
				timeStamp: Date.now(),
				initiator,
				originUrl: initiator,
				fromCache: !!details?.fromCache,
			};
			const expr =
				"(async function (detailsJson) { var details = JSON.parse(detailsJson); var entries = (self.__obWebRequestFns && self.__obWebRequestFns.onBeforeRequest) || []; var out = null; for (var i = 0; i < entries.length; i++) { try { var r = entries[i](details, function () {}); if (r && typeof r.then === 'function') { r = await Promise.race([r, new Promise(function (res) { setTimeout(function () { res(null); }, 4000); })]); } if (r && typeof r === 'object') { out = r; break; } } catch (e) {} } return out ? JSON.stringify(out) : ''; })(" +
				JSON.stringify(JSON.stringify(d)) +
				")";
			tasks.push(
				this.opts
					.evalInSw(eid, expr)
					.then((r) => {
						try {
							const parsed = JSON.parse(String(r?.value || ""));
							return parsed && typeof parsed === "object" ? parsed : null;
						} catch {
							return null;
						}
					})
					.catch(() => null),
			);
		}
		if (!tasks.length) return null;
		const results = await Promise.all(
			tasks.map((t) => Promise.race([t, new Promise<{ cancel?: boolean; redirectUrl?: string } | null>((res) => setTimeout(() => res(null), 6000))])),
		);
		for (const r of results) {
			if (!r) continue;
			if (r.cancel || r.redirectUrl) return r;
		}
		return null;
	}

	/** 排空各扩展 SW 的 tabs.create 出箱（VM confirm 页等由 openUrl 真实打开） */
	async drainWrOutbox(): Promise<void> {
		try {
			const drExpr = "(() => { const o = self.__obTabCreateOutbox || []; self.__obTabCreateOutbox = []; return JSON.stringify(o); })()";
			for (const eid of this.wrBridgeCache.keys()) {
				try {
					const dr = await this.opts.evalInSw(eid, drExpr);
					const items = dr && !dr.err && dr.value ? JSON.parse(String(dr.value)) : [];
					for (const it of (Array.isArray(items) ? items : [])) {
						const u = String((it && it.url) || "");
						if (!u) continue;
						if (u.includes("ask.html") || u.includes("confirm/index.html")) {
							const pj = this.pendingUserJs;
							if (pj && !pj.askOpened) pj.askOpened = true;
						}
						this.opts.openUrl(u);
					}
				} catch {
					/* sw asleep */
				}
			}
		} catch {
			/* ignore */
		}
	}

	/**
	 * 阻塞桥派发入口（webRequest 管线的 onBeforeRequest 调）：filter 命中的
	 * 扩展 SW 合成派发。返回 true = 已接管（cb 由派发路径回调）；false = 无人
	 * 接管，调用方继续。回调不能拖到 drain 之后：阻塞挂起超时会被 Chromium 以
	 * ERR_ABORTED 中止（实测 .user.js 导航 -3）——cb 只等派发汇总，drain 在
	 * 回调后跑。
	 */
	maybeDispatchWr(url: string, rtDnr: string | null, details: any, cb: (r: any) => void): boolean {
		try {
			if (!this.wrBridgeCache.size) {
				void this.refreshWrBridge(true);
				return false; // 首请求只触发缓存刷新（SW 冷启动期 filter 尚未知）
			}
			let dispatched = false;
			for (const [, entries] of this.wrBridgeCache) {
				if (entries.some((f) => f.ev === "onBeforeRequest" && this.wrFilterMatches(f, url, rtDnr))) {
					dispatched = true;
					break;
				}
			}
			if (!dispatched) return false;
			void (async () => {
				try {
					const r = await this.dispatchWrCollect(url, rtDnr, details);
					if (r) {
						if (r.cancel) {
							cb({ cancel: true });
							return;
						}
						if (r.redirectUrl) {
							cb({ redirectUrl: r.redirectUrl });
							return;
						}
					}
				} catch {
					/* ignore */
				}
				cb({});
				await this.drainWrOutbox();
			})();
			return true;
		} catch {
			return false;
		}
	}

	// ------------------------------------------------------------------
	// webNavigation.onCommitted 合成
	// ------------------------------------------------------------------

	/** webNavigation.onCommitted 合成派发：仅对暴露了真实事件面的扩展派发。 */
	async emitWebNavCommitted(url: string): Promise<void> {
		try {
			const native = this.opts.listExts().filter((e) => e.native && e.electronId).map((e) => ({ ...e, electronId: e.electronId! }));
			if (!native.length) return;
			const probe = "(function () { var f = self.__obWebNavFns || {}; return JSON.stringify({ c: (f.onCommitted || []).length }); })()";
			const dispatchExpr =
				"(function (d) { var fns = (self.__obWebNavFns && self.__obWebNavFns.onCommitted) || []; for (var i = 0; i < fns.length; i++) { try { fns[i](d); } catch (e) {} } return new Promise(function (res) { setTimeout(function () { res(JSON.stringify({ outbox: (self.__obTabCreateOutbox || []).map(function (x) { return String(x.url).slice(0, 90); }) })); }, 3500); }); })(" +
				JSON.stringify(JSON.stringify({ frameId: 0, tabId: 1, url, transitionType: "link", transitionQualifiers: [], timeStamp: Date.now() })) +
				")";
			const drainExpr = "(() => { const o = self.__obTabCreateOutbox || []; self.__obTabCreateOutbox = []; return JSON.stringify(o); })()";
			for (const e of native) {
				try {
					const chk = await this.opts.evalInSw(e.electronId, probe).catch(() => null);
					if (!chk || !String(chk.value || "").includes('"c":')) continue;
					if (String(chk.value).includes('"c":0')) continue; // 该扩展没挂 onCommitted
					await this.opts.evalInSw(e.electronId, dispatchExpr).catch(() => null);
					// 多点排空（VM handler 异步 fetch 后才 tabs.create）
					for (const delay of [1500, 4000, 8000]) {
						await new Promise((r) => setTimeout(r, delay === 1500 ? 1500 : delay === 4000 ? 2500 : 4000));
						try {
							const dr = await this.opts.evalInSw(e.electronId, drainExpr);
							const items = dr && !dr.err && dr.value ? JSON.parse(String(dr.value)) : [];
							for (const it of (Array.isArray(items) ? items : [])) {
								const u = String((it && it.url) || "");
								if (!u) continue;
								if (u.includes("ask.html") || u.includes("confirm/index.html")) {
									const pj = this.pendingUserJs;
									if (pj && !pj.askOpened) pj.askOpened = true;
								}
								this.opts.openUrl(u);
							}
						} catch {
							/* sw asleep */
						}
					}
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
	}

	// ------------------------------------------------------------------
	// .user.js 暴力猴（Violentmonkey）安装链
	// ------------------------------------------------------------------

	/**
	 * mainFrame 导航命中 .user.js（webRequest 管线调，管线已 cb({cancel:true})）：
	 * 合成 downloads.onCreated（VM 的安装入口是请求/下载观察）+ wr 派发 +
	 * 多轮排空，等 VM 自己的确认页（confirm/index.html）弹出；约 13.5s 未弹出
	 * 再探测 VM 是否带 chrome.userScripts（MV3 内核有，MV2 稳定版没有）——
	 * 有才回落宿主确认弹窗直装。闭源油猴（TM）链路已整体移除（2026-11-04）。
	 */
	onUserJsNavigation(url: string, resourceType: string): void {
		void this.runVmInstallChain(url, resourceType).catch(() => {});
	}

	/** 已启用且原生加载的 Violentmonkey（开源用户脚本管理器）。 */
	private findVm(): ExtRef | null {
		return (
			this.opts
				.listExts()
				.find((e) => /violentmonkey|暴力猴/i.test(String(e.name || "")) && e.electronId) ?? null
		);
	}

	private async runVmInstallChain(url: string, resourceType: string): Promise<void> {
		const vm = this.findVm();
		if (!vm?.electronId) {
			new Notice("未安装 Violentmonkey（开源用户脚本管理器），无法安装脚本", 5000);
			return;
		}
		// 1) 合成 downloads.onCreated：真 Chrome 把 .user.js 当下载，VM 观察
		//    请求/下载后自己 fetch/登记/开确认页 —— 缺这步 VM 链条静默超时。
		await this.opts
			.evalInSw(vm.electronId, `try { self.__obEmitDownload && self.__obEmitDownload(${JSON.stringify(url)}); } catch (e) {}`)
			.catch(() => null);
		// 2) wr 派发 + 多轮排空，等 confirm 页出现在 tabs.create 出箱
		this.pendingUserJs = { url, askOpened: false };
		try {
			await this.dispatchWrCollect(url, "main_frame", { url, resourceType: "mainFrame", type: "mainFrame" });
		} catch {
			/* ignore */
		}
		for (let i = 0; i < 8; i++) {
			await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 2000));
			await this.drainWrOutbox();
			if (this.pendingUserJs?.askOpened) {
				console.info("[ob-browser] .user.js VM confirm 已打开:", url.slice(0, 80));
				this.pendingUserJs = null;
				return;
			}
		}
		this.pendingUserJs = null;
		// 3) VM 自有链没走出 confirm → 探测 chrome.userScripts（直装前提），
		//    有才回落宿主确认弹窗；没有（MV2 稳定版）就指引用户在 VM 面板装。
		const probe = await Promise.race([
			this.opts
				.evalInSw(
					vm.electronId,
					"(() => { try { return JSON.stringify({ us: typeof chrome.userScripts?.register === 'function' }); } catch (e) { return JSON.stringify({ us: false }); } })()",
				)
				.catch(() => null),
			new Promise<null>((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 5000)).catch(() => null),
		]);
		const direct = (() => {
			try {
				return JSON.parse(String(probe?.value || "{}")).us === true;
			} catch {
				return false;
			}
		})();
		if (!direct) {
			new Notice("Violentmonkey 安装页未打开（脚本源不可达/代理未开，或该版本不支持直装）——可在 VM 面板手动安装", 6000);
			return;
		}
		console.info("[ob-browser] .user.js VM 链未完成，回落宿主确认直装:", url.slice(0, 80));
		await this.interceptUserScriptInstall(url, resourceType);
	}

	/** .user.js → 宿主直装：下载脚本、解析 ==UserScript== 头、副本比对、防重入、弹确认。 */
	async interceptUserScriptInstall(url: string, _resourceType: string): Promise<void> {
		try {
			const vm = this.findVm();
			if (!vm?.electronId) {
				new Notice("未安装 Violentmonkey（开源用户脚本管理器），无法安装脚本", 5000);
				return;
			}
			// 下载脚本内容：★ 必须走浏览器分区的 session.fetch（代理/cookie 与
			// 页面一致）——主 realm 默认 fetch 走 Obsidian 会话，源侧实测 update
			// 域全部超时而分区网络正常。update 域失败时镜像到主站 code 路径。
			const code = await this.fetchUserJs(url);
			if (!/==\s*UserScript\s*==/.test(code)) throw new Error("内容缺少 ==UserScript== 头，不是用户脚本");
			const meta = (k: string): string => {
				const m = code.match(new RegExp("//\\s*@" + k + "\\s+([^\\r\\n]+)", "i"));
				return m ? m[1].trim() : "";
			};
			const fname = decodeURIComponent(url.split("?")[0].split("/").pop() || "").replace(/\.user\.js$/i, "");
			const name = meta("name") || fname || "userscript";
			const version = meta("version");
			const author = meta("author");
			const description = meta("description");
			const matches: string[] = [];
			const re = new RegExp("//\\s*@(match|include)\\s+([^\\r\\n]+)", "gi");
			let mm: RegExpExecArray | null;
			while ((mm = re.exec(code))) {
				const pat = mm[2].trim();
				if (pat && !matches.includes(pat)) matches.push(pat);
			}
			if (!matches.length) matches.push("*://*/*");
			// 已装比对：只比宿主直装副本（无 SW 依赖）——VM 自装脚本的去重由
			// VM 自己负责（其 confirm 页有重复提示）。
			const normSrc = (s: unknown) => String(s || "").replace(/\r\n/g, "\n").trim();
			try {
				const regs = this.opts.getRegistry?.() ?? null;
				if (regs) {
					for (const [, m] of regs) {
						for (const [, entry] of m) {
							if (!/^ob-install/.test(String(entry?.id || ""))) continue;
							const c0 = (entry.js && entry.js[0] && entry.js[0].code) || "";
							if (c0 && normSrc(c0) === normSrc(code)) {
								new Notice("该脚本已安装，无需重复安装: " + name, 4000);
								return;
							}
						}
					}
				}
			} catch {
				/* ignore */
			}
			// 确认弹窗（对齐 VM confirm 页语义）：展示脚本信息，用户点安装才注册
			const aid = "aid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
			// 防重入：同脚本 3 分钟内不重复弹（文本页留在地址栏，重建/恢复/刷新
			// 会重新触发导航）；已有弹窗打开时也不叠加
			const dkey = url.split("?")[0];
			const lastShown = this.installDialogShownAt.get(dkey) || 0;
			if (Date.now() - lastShown < 3 * 60 * 1000) {
				console.info("[ob-browser] .user.js 确认弹窗 3 分钟内已展示过，跳过:", dkey.slice(0, 80));
				return;
			}
			// 清理已脱离 DOM 的旧弹窗：webview 重建/页签搬移会把 overlay 连带 DOM
			// 一起换掉，残引用会让「已有打开实例」永久为真 —— 后续所有安装确认
			// 被静默跳过（源侧实测弹窗一泄漏就再也装不上）
			for (const ov of [...this.pendingInstallDialogs]) {
				if (!ov.isConnected) this.pendingInstallDialogs.delete(ov);
			}
			if (this.pendingInstallDialogs.size > 0) {
				console.info("[ob-browser] .user.js 确认弹窗已有打开实例，跳过叠加");
				return;
			}
			this.installDialogShownAt.set(dkey, Date.now());
			if (this.installDialogShownAt.size > 50) {
				const oldest = this.installDialogShownAt.keys().next().value;
				if (oldest !== undefined) this.installDialogShownAt.delete(oldest);
			}
			this.pendingInstalls.set(aid, {
				url,
				code,
				name,
				version,
				author,
				description,
				matches,
				electronId: vm.electronId,
				extName: vm.name,
			});
			this.showInstallDialog(aid, { name, version, author, description, matches, from: url });
		} catch (e) {
			console.warn("[ob-browser] .user.js 安装失败:", e);
			new Notice("安装脚本失败: " + (e instanceof Error ? e.message : e), 5000);
		}
	}

	/** 分区 session.fetch 下载脚本（15s 超时；update 域失败镜像主站 code 路径）。 */
	private async fetchUserJs(url: string): Promise<string> {
		const { sessionFromPartition } = await import("../utils/electron");
		const ses = sessionFromPartition("persist:obsidian-browser");
		const fetchVia = async (u: string, ms: number): Promise<string> => {
			// ses.fetch（Electron net）不接受 AbortSignal——用 Promise.race 超时
			// 放弃慢请求（后台连接自行终止即可）
			const doReq = async (): Promise<string> => {
				const r = ses && ses.fetch ? await ses.fetch(u, { credentials: "include" } as any) : await fetch(u, { credentials: "include" });
				if (!r.ok) throw new Error("HTTP " + r.status);
				return await r.text();
			};
			let timer: any = null;
			const timeoutP = new Promise<never>((_, rej) => {
				timer = setTimeout(() => rej(new Error("fetch 超时 " + ms + "ms")), ms);
			});
			try {
				return await Promise.race([doReq(), timeoutP]);
			} finally {
				clearTimeout(timer);
			}
		};
		try {
			const code = await fetchVia(url, 15000);
			console.info("[ob-browser] .user.js fetched:", url.slice(0, 60), "len:", code.length);
			return code;
		} catch (e1) {
			console.warn("[ob-browser] .user.js fetch 失败，尝试镜像:", url.slice(0, 60), String((e1 as any)?.message || e1).slice(0, 80));
			const m = url.match(/^https?:\/\/update\.greasyfork\.org\/scripts\/(\d+)\/([^/?#]+\.user\.js)$/i);
			if (!m) throw e1;
			const code = await fetchVia("https://greasyfork.org/scripts/" + m[1] + "/code/" + m[2], 15000);
			console.info("[ob-browser] .user.js 镜像 fetched: len:", code.length);
			return code;
		}
	}

	/** 安装确认弹窗（宿主侧 DOM，对齐 VM confirm 页的确认语义） */
	private showInstallDialog(aid: string, info: { name: string; version: string; author: string; description: string; matches: string[]; from: string }): void {
		const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const overlay = document.createElement("div");
		overlay.className = "ob-us-install-overlay";
		overlay.style.cssText =
			"position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;";
		const rows: Array<[string, string]> = [
			["名称", info.name],
			["版本", info.version || "（未声明）"],
			["作者", info.author || "（未声明）"],
			["描述", info.description || "（未声明）"],
			["运行于", info.matches.join("、")],
		];
		overlay.innerHTML =
			'<div class="ob-us-install-card" style="background:var(--background-primary,#fff);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.3);width:420px;max-width:92vw;padding:18px 20px;font-size:13px;color:var(--text-normal,#333);">'
			+ '<div style="font-size:15px;font-weight:600;margin-bottom:10px;">安装用户脚本</div>'
			+ rows.map(([k, v]) => '<div style="display:flex;gap:8px;margin:4px 0;"><div style="flex:0 0 52px;color:var(--text-muted,#888);">' + k + '</div><div style="flex:1;word-break:break-all;">' + esc(v) + "</div></div>").join("")
			+ '<div style="margin:10px 0 0;color:var(--text-muted,#888);font-size:12px;">来源: ' + esc(info.from.slice(0, 90)) + "</div>"
			+ '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">'
			+ '<button data-act="cancel" style="padding:6px 16px;border-radius:6px;border:1px solid var(--background-modifier-border,#ddd);background:var(--background-secondary,#f5f5f5);color:var(--text-normal,#333);cursor:pointer;">取消</button>'
			+ '<button data-act="install" style="padding:6px 18px;border-radius:6px;border:none;background:var(--interactive-accent,#1a73e8);color:var(--text-on-accent,#fff);cursor:pointer;font-weight:600;">安装</button>'
			+ "</div></div>";
		const close = () => {
			try {
				overlay.remove();
			} catch {
				/* ignore */
			}
		};
		this.pendingInstallDialogs.add(overlay);
		overlay.addEventListener("click", (ev) => {
			const btn = (ev.target as HTMLElement).closest("button[data-act]");
			if (!btn) {
				if (ev.target === overlay) close(); // 点遮罩 = 取消
				return;
			}
			const act = btn.getAttribute("data-act");
			close();
			this.pendingInstallDialogs.delete(overlay);
			if (act !== "install") return;
			void this.confirmInstall(aid);
		});
		document.body.appendChild(overlay);
		console.info("[ob-browser] .user.js 确认弹窗已展示:", info.name);
	}

	/** 用户确认后的注册（直装进 VM 的 userScripts 注册表，垫片持久化） */
	private async confirmInstall(aid: string): Promise<void> {
		const pending = this.pendingInstalls.get(aid);
		if (!pending) {
			// aid 失联（tab 重建换了实例等）——给用户可见反馈而非静默
			new Notice("安装会话已失效，请重新点击「安装此脚本」", 4000);
			return;
		}
		this.pendingInstalls.delete(aid);
		const { code, name, matches, electronId } = pending;
		try {
			const id = "ob-install-" + Date.now().toString(36);
			const tryRegister = async (m: string[]): Promise<string> => {
				// ★ 归一非标准通配：用户脚本 @match 允许 `*://**/*`（host `**`），
				//   标准 match pattern 不认 —— 存进注册表后 matches 永不命中，
				//   脚本静默不注入（源侧实测 SEJ 直装副本失效）。`**` 视同任意主机。
				const normMatches = m.map((p) => (/:\/\/\*\*(?:[/?#]|$)/.test(p) ? p.replace("://**/", "://*/").replace("://**", "://*") : p));
				const script = { id, matches: normMatches, js: [{ code }], world: "USER_SCRIPT", runAt: "document_idle" };
				// ★ 传参是 JSON 字符串，SW 侧必须先 JSON.parse —— 否则 register
				//   收到 string，s.id undefined 被守卫跳过，还报 "ok"（源侧踩坑）
				const expr =
					"(function (scriptJson) { try { var script = JSON.parse(scriptJson); chrome.userScripts.register(script, function () {}); return 'ok'; } catch (e) { return 'throw:' + e.message; } })(" +
					JSON.stringify(JSON.stringify(script)) +
					")";
				const r = await this.opts.evalInSw(electronId, expr);
				return String(r?.value || "");
			};
			let reg = await tryRegister(matches);
			if (reg !== "ok") {
				// match pattern 不合法（@include 通配等）→ 兜底 <all_urls>
				reg = await tryRegister(["<all_urls>"]);
			}
			if (reg !== "ok") {
				new Notice("安装脚本失败: " + reg.replace("throw:", ""), 5000);
				return;
			}
			console.info("[ob-browser] 用户脚本已安装:", name, "matches:", matches.join(" "));
			new Notice("已安装用户脚本: " + name, 4000);
		} catch (e) {
			console.warn("[ob-browser] .user.js 安装失败:", e);
			new Notice("安装脚本失败: " + (e instanceof Error ? e.message : e), 5000);
		}
	}
}
