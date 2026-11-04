/**
 * 扩展 webRequest 阻塞桥 + webNavigation 合成（架构：从 userJsInstall.ts 拆出
 * ——它与安装链是两个关注点：这是**基础设施**（任何扩展的 webRequest/
 * webNavigation 监听器都靠它 reach 得到），安装链只是它的一个消费者）。
 *
 *  1. webRequest 阻塞桥：拉取各扩展 SW 暴露的监听器 filter 快照
 *     （__obWebRequestFilters，垫片 v23 暴露），webRequest 层 filter 命中的
 *     扩展 SW 合成派发 onBeforeRequest，收 {cancel/redirectUrl}；派发后排空
 *     tabs.create 出箱（VM confirm 页等由宿主真实开页签）。
 *  2. webNavigation.onCommitted 合成派发：VM 的 .user.js 安装检测依赖导航
 *     事件流；派发后多点排空 tabs 出箱。
 */

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

export interface WrBridgeOpts {
	/** 已启用且原生加载的扩展清单（name + electronId）。 */
	listExts: () => ExtRef[];
	/** 在扩展 SW 里求值（内部有唤醒/兜底通道）。 */
	evalInSw: (electronId: string, expr: string) => Promise<{ value?: any; err?: string } | null>;
	/** 宿主开新页签（tabs.create 出箱的落点）。 */
	openUrl: (url: string) => void;
	/** 活动页签 URL（派发 details.initiator 用）。 */
	activeUrl: () => string;
	/** 出箱里出现 VM/扩展确认页（confirm/index.html、ask.html）时回调
	 *  （安装链据此判断"扩展自己的确认页已打开"）。可运行期替换
	 *  （安装链每次开链重设）。 */
	onConfirmPage?: (url: string) => void;
}

export class WrBridge {
	/** webRequest filter 快照缓存：electronId → filters[] */
	private wrBridgeCache = new Map<string, WrFilter[]>();
	private wrBridgeCacheAt = 0;

	/** 出箱里出现 VM/扩展确认页（confirm/index.html、ask.html）时回调
	 *  （安装链据此判断"扩展自己的确认页已打开"）。运行期可整体替换。 */
	onConfirmPage?: (url: string) => void;

	constructor(private opts: WrBridgeOpts) {}

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
	async dispatchWrCollect(url: string, rtDnr: string | null, details: any): Promise<{ cancel?: boolean; redirectUrl?: string } | null> {
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
							this.opts.onConfirmPage?.(u);
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
									this.opts.onConfirmPage?.(u);
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
}
