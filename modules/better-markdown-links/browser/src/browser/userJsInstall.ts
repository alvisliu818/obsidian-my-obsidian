/**
 * .user.js 安装链（暴力猴/Violentmonkey 版）—— 2026-11-04 用户决定：闭源
 * 油猴 TM 链路整体移除，只兼容开源的暴力猴。
 *
 * 架构（2026-11-04 拆分）：webRequest 阻塞桥/webNavigation 合成在
 * wrBridge.ts（基础设施），==UserScript== 头解析在 userJsMeta.ts（纯函数），
 * 本文件只管**编排**：VM 自有链 → 超时探测 chrome.userScripts → 宿主直装
 * 确认弹窗。
 */
import { Notice } from "obsidian";
import { parseUserScript } from "./userJsMeta";
import type { ExtRef, WrBridge } from "./wrBridge";

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
	/** webRequest 阻塞桥（wrBridge.ts）：派发/排空/确认页探测都走它。 */
	bridge: WrBridge;
	/** 确保 cs-runtime 已初始化（SW eval 通道的地基；.user.js 被 cancel 后
	 *  没有页面成功加载、dom-ready 不触发，必须显式调）。 */
	ensureCsRuntime?: () => void;
}

export class UserJsChain {
	private pendingInstalls = new Map<string, PendingInstall>();
	private installDialogShownAt = new Map<string, number>();
	private pendingInstallDialogs = new Set<HTMLElement>();
	/** VM confirm 页已为此 URL 打开（同 URL 60s 内不再走链/弹宿主窗） */
	private vmConfirmAt = new Map<string, number>();

	constructor(private opts: UserJsChainOpts) {}

	/** 已启用且原生加载的 Violentmonkey（开源用户脚本管理器）。 */
	private findVm(): ExtRef | null {
		return (
			this.opts
				.listExts()
				.find((e) => /violentmonkey|暴力猴/i.test(String(e.name || "")) && e.electronId) ?? null
		);
	}

	/**
	 * mainFrame 导航命中 .user.js（webRequest 管线调，管线已 cb({cancel:true})）。
	 * VM 自有链走出 confirm 即止；超时按 VM 能力回落宿主直装。
	 */
	onUserJsNavigation(url: string, resourceType: string): void {
		void this.runVmInstallChain(url, resourceType).catch(() => {});
	}

	private async runVmInstallChain(url: string, resourceType: string): Promise<void> {
		// VM confirm 已为此 URL 开过（重导航/恢复会重复触发）：安静退出，
		// 不再叠加宿主确认弹窗（实测双确认弹窗的来源）
		const dkey = url.split("?")[0];
		if (Date.now() - (this.vmConfirmAt.get(dkey) || 0) < 60_000) return;

		// .user.js 被取消后没有任何页面成功加载 → dom-ready 不触发 → cs-runtime
		// 可能还没初始化（SW eval 全靠它的通道），显式补一次
		try {
			this.opts.ensureCsRuntime?.();
		} catch {
			/* ignore */
		}

		const vm = this.findVm();
		if (!vm?.electronId) {
			new Notice("未安装 Violentmonkey（开源用户脚本管理器），无法安装脚本", 5000);
			return;
		}
		// 0) 先拉 VM 的 webRequest filter 快照（刚装完/刚启用时缓存里没有它，
		//    排空循环在空缓存上跑 = confirm 永远等不到——实测踩坑）
		await this.opts.bridge.refreshWrBridge(true);
		// 1) 合成 downloads.onCreated：真 Chrome 把 .user.js 当下载，VM 观察
		//    请求/下载后自己 fetch/登记/开确认页 —— 缺这步 VM 链条静默超时。
		//    VM SW 冷启动可能吃掉首发 eval：失败补发一次。
		const emitExpr = `try { self.__obEmitDownload && self.__obEmitDownload(${JSON.stringify(url)}); } catch (e) {}`;
		const emit1 = await this.opts.evalInSw(vm.electronId, emitExpr).catch(() => null);
		if (!emit1 || emit1.err) {
			await new Promise((r) => setTimeout(r, 1200));
			await this.opts.evalInSw(vm.electronId, emitExpr).catch(() => null);
		}
		// 2) wr 派发 + 多轮排空，等 confirm 页出现在 tabs.create 出箱。
		//    confirm 页的识别走 bridge 的 onConfirmPage 回调 → markConfirm。
		let confirmOpened = false;
		const markConfirm = (): void => {
			confirmOpened = true;
			this.vmConfirmAt.set(dkey, Date.now());
			if (this.vmConfirmAt.size > 50) {
				const oldest = this.vmConfirmAt.keys().next().value;
				if (oldest !== undefined) this.vmConfirmAt.delete(oldest);
			}
		};
		this.opts.bridge.onConfirmPage = markConfirm;
		try {
			await this.opts.bridge.dispatchWrCollect(url, "main_frame", {
				url,
				resourceType: "mainFrame",
				type: "mainFrame",
			});
		} catch {
			/* ignore */
		}
		for (let i = 0; i < 8; i++) {
			await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 2000));
			await this.opts.bridge.drainWrOutbox();
			if (confirmOpened) {
				console.info("[ob-browser] .user.js VM confirm 已打开:", url.slice(0, 80));
				return;
			}
			// 中途再刷一次 filter 快照（VM SW 冷启动后 filter 才注册齐）
			if (i === 2) await this.opts.bridge.refreshWrBridge(true);
		}
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
			const parsed = parseUserScript(code, url);
			if (!parsed) throw new Error("内容缺少 ==UserScript== 头或没有 @match/@include，不是可安装的用户脚本");
			const { name, version, author, description, matches } = parsed;
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
