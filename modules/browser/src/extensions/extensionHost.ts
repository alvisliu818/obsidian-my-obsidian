/* eslint-disable @typescript-eslint/no-explicit-any */
import type { App } from "obsidian";
import { requestUrl } from "obsidian";
import type { ExtensionContentScript, ExtensionRecord, IWebviewTag } from "../types";
import { nodeRequire, sessionFromPartition, vaultBasePath } from "../utils/electron";
import { extractExtensionArchive } from "./crx";
import { buildShimSource } from "./cs-runtime";
import { EDGE_ADDONS_HOME, downloadEdgeCrx, parseEdgeAddonId, toArrayBuffer } from "./edgeStore";
import {
  beginPopupWorld,
  disposeCsRuntime as disposeCsRt,
  ensureCsRuntime as ensureCsRt,
  evalPopupJs,
  initCsRuntime,
  type ICsExtInfo,
} from "./cs-runtime";
import { injectExtensionPageRuntime } from "./extPopup";

interface RawManifest {
  name?: string;
  version?: string;
  description?: string;
  manifest_version?: number;
  icons?: Record<string, string>;
  permissions?: string[];
  options_page?: string;
  options_ui?: { page?: string; open_in_tab?: boolean };
  content_scripts?: RawContentScript[];
  browser_action?: { default_popup?: string; default_icon?: string | Record<string, string> };
  action?: { default_popup?: string; default_icon?: string | Record<string, string> };
  default_locale?: string;
}

interface RawContentScript {
  matches?: string[];
  exclude_matches?: string[];
  js?: string[];
  css?: string[];
  run_at?: string;
  all_frames?: boolean;
}

export interface InjectedScript {
  ext: ExtensionRecord;
  css: string[];
  js: string[];
}

/**
 * Installs, persists and injects Chrome-extension-shaped add-ons.
 *
 * Honest scope: content scripts (with a `chrome.*` shim) and popups work;
 * background pages / service workers never run, so extensions that depend on
 * one will only partially work. Same limitation as the SiYuan plugin.
 */
/** webview 的 session partition（与 constants.ts 里的默认值一致） */
const BROWSER_PARTITION = "persist:obsidian-browser";

export class ExtensionHost {
  private fs: any;
  private pathMod: any;
  private rootDir = "";
  private scriptCache = new Map<string, string>();
  private iconCache = new Map<string, string>();

  constructor(
    private app: App,
    private getRecords: () => ExtensionRecord[],
    private getEnabled: () => boolean,
    private onChange: () => void,
  ) {
    this.fs = nodeRequire<any>("fs");
    this.pathMod = nodeRequire<any>("path");
    const base = vaultBasePath(this.app);
    if (base) this.rootDir = base.replace(/[\\/]+$/, "") + "/.obsidian/plugins/obsidian-browser/extensions";
  }

  get available(): boolean {
    return !!this.fs && !!this.rootDir;
  }

  private ensureRoot(): void {
    if (!this.available) throw new Error("扩展功能需要桌面端（无法访问文件系统）");
    this.fs.mkdirSync(this.rootDir, { recursive: true });
  }

  // ---------------- installation ----------------

  /** files: entries relative to the extension root (manifest.json at root). */
  async installFromFiles(files: { path: string; data: Uint8Array | ArrayBuffer }[]): Promise<ExtensionRecord> {
    this.ensureRoot();
    const manifestEntry = files.find((f) => f.path.replace(/^\/+/, "") === "manifest.json");
    if (!manifestEntry) throw new Error("所选内容里没有 manifest.json（请选择扩展根目录或 CRX/ZIP 包）");

    const manifest = JSON.parse(new TextDecoder().decode(toBytes(manifestEntry.data))) as RawManifest;
    this.resolveManifestI18n(manifest, files);
    const dir = this.sanitizeDir((manifest.name || "extension") + "-" + (manifest.version || "0"));
    const target = this.pathMod.join(this.rootDir, dir);

    this.fs.rmSync(target, { recursive: true, force: true });
    this.fs.mkdirSync(target, { recursive: true });
    for (const f of files) {
      const rel = f.path.replace(/^\/+/, "");
      if (!rel || rel.startsWith("../")) continue;
      const abs = this.pathMod.join(target, rel);
      this.fs.mkdirSync(this.pathMod.dirname(abs), { recursive: true });
      this.fs.writeFileSync(abs, Buffer.from(toBytes(f.data)));
    }

    const rec = this.recordFromManifest(manifest, dir);
    this.upsert(rec);
    return rec;
  }

  /**
   * 解析 manifest 里的 `__MSG_key__` 占位符（Chrome 从 `_locales/<locale>/messages.json`
   * 取值；不解析的话扩展名会显示成 `__MSG_appName__`，且污染目录名/记录 id）。
   * 依次尝试 default_locale → en/en_US/zh_CN → 任意语言目录下的 messages.json。
   */
  private resolveManifestI18n(manifest: RawManifest, files: { path: string; data: Uint8Array | ArrayBuffer }[]): void {
    const placeholder = /__MSG_([A-Za-z0-9@_]+)__/;
    const needs = (v: string | undefined): v is string => typeof v === "string" && placeholder.test(v);
    if (!needs(manifest.name) && !needs(manifest.description)) return;

    const readMessages = (path: string): Record<string, { message?: string }> | null => {
      const entry = files.find((f) => f.path.replace(/^\/+/, "").toLowerCase() === path);
      if (!entry) return null;
      try {
        return JSON.parse(new TextDecoder().decode(toBytes(entry.data))) as Record<string, { message?: string }>;
      } catch {
        return null;
      }
    };

    let messages: Record<string, { message?: string }> | null = null;
    const dl = typeof manifest.default_locale === "string" ? manifest.default_locale : "";
    for (const loc of [dl, "en", "en_US", "zh_CN"]) {
      if (!loc) continue;
      messages = readMessages(`_locales/${loc}/messages.json`);
      if (messages) break;
    }
    if (!messages) {
      const anyEntry = files.find((f) => /^_locales\/[^/]+\/messages\.json$/i.test(f.path.replace(/^\/+/, "")));
      if (anyEntry) {
        try {
          messages = JSON.parse(new TextDecoder().decode(toBytes(anyEntry.data))) as Record<
            string,
            { message?: string }
          >;
        } catch {
          messages = null;
        }
      }
    }
    if (!messages) return;

    const keys = Object.keys(messages);
    const lookup = (key: string): string | null => {
      const hit = messages![key] ?? messages![keys.find((k) => k.toLowerCase() === key.toLowerCase()) ?? ""];
      return hit && typeof hit.message === "string" ? hit.message : null;
    };
    const subst = (v: string): string => v.replace(/__MSG_([A-Za-z0-9@_]+)__/g, (all, key: string) => lookup(key) ?? all);
    if (needs(manifest.name)) manifest.name = subst(manifest.name);
    if (needs(manifest.description)) manifest.description = subst(manifest.description);
  }

  async installFromArchive(buffer: ArrayBuffer, fallbackName: string): Promise<ExtensionRecord> {    const files = await extractExtensionArchive(buffer);
    if (!files.some((f) => f.path === "manifest.json")) {
      throw new Error("压缩包里没有 manifest.json" + (fallbackName ? "（" + fallbackName + "）" : ""));
    }
    const rec = await this.installFromFiles(files);
    // 装完立刻原生加载以拿到 electronId —— 没有它 SW 不存在，cs-runtime/sw-bridge 用不了
    await this.loadNative(rec);
    return rec;
  }

  async installFromUrl(url: string): Promise<ExtensionRecord> {
    const resp = await requestUrl({ url, throw: false });
    if (resp.status >= 400) throw new Error("下载失败：HTTP " + resp.status);
    return this.installFromArchive(resp.arrayBuffer, url);
  }

  /** 从 Edge 加载项商店安装（配 edgeStore）：下载 CRX 后直接走 installFromArchive。
   *  与源侧不同：源侧先落盘成 .crx 再 installFromPackage（因其安装入口只吃文件路径），
   *  本插件的 installFromArchive 直接吃 ArrayBuffer，省掉临时文件。 */
  async installFromEdgeAddons(
    rawInput: string,
  ): Promise<{ ok: boolean; error?: string; ext?: ExtensionRecord }> {
    const id = parseEdgeAddonId(rawInput);
    if (!id) {
      return { ok: false, error: "无效的 Edge 加载项链接或扩展 id: " + String(rawInput).slice(0, 200) };
    }
    try {
      const buf = await downloadEdgeCrx(id);
      const ext = await this.installFromArchive(toArrayBuffer(buf), `edge-${id}`);
      return { ok: true, ext };
    } catch (e: any) {
      return { ok: false, error: `Edge 加载项安装失败: ${String(e?.message || e)}` };
    }
  }

  /** 打开 Edge 加载项商店（与 edgeStoreHelper 注入的页面"安装"按钮配合） */
  openEdgeStore(): void {
    window.open(EDGE_ADDONS_HOME, "_blank");
  }

  // ===== Electron 原生扩展加载 =====
  // 本插件原本是"自研注入式"（自己解压 CRX + 注入内容脚本 + chrome shim），
  // 那样扩展没有真实 background service worker，cs-runtime 的 isolated world
  // 与 sw-bridge 的 SW CDP 通道就无从附着。这里补上原生加载，把
  // session.loadExtension 返回的 id 写回记录的 electronId —— 它是激活那两个
  // 模块的开关。桌面端不可用时静默退回自研注入式，不报错。

  /** 扩展所在磁盘目录（loadExtension 需要真实路径） */
  private dirOf(rec: ExtensionRecord): string {
    return this.pathMod.join(this.rootDir, rec.dir);
  }

  /** webview 用的 partition 上的 session：loadExtension / removeExtension / serviceWorkers 都在它上面 */
  private session(): any | null {
    return sessionFromPartition(BROWSER_PARTITION);
  }

  /** 原生加载并写回 electronId；失败返回 null（退回自研注入式） */
  async loadNative(rec: ExtensionRecord): Promise<string | null> {
    const ses = this.session();
    if (!ses?.loadExtension) return null;
    // 单扩展垫片（install/enable 路径；启动路径由 syncNativeOnStartup 全局做）：
    // SW 文件被垫后必须卸掉重载，Electron 才会从磁盘拉新脚本 —— 否则垫了也白垫。
    let shimmed = false;
    try {
      if (await this.shimBackgroundFile(rec)) {
        shimmed = true;
        try { await this.unloadNative(rec); } catch { /* 此前未加载 */ }
      }
    } catch { /* 垫片失败不阻断加载 */ }
    if (shimmed) {
      // ★ 分区持久化的 SW 注册/脚本缓存不随 loadExtension 更新（实测：垫片已写盘、
      //   重载后 SW 仍执行无垫片旧脚本 → __obOnMessageHandlers 缺失 → AdGuard 设置页
      //   boot 挂死打不开）。安装/启用路径垫片后同样要清 SW 存储，与启动路径
      //   injectBackgroundShims 对齐；仅垫片变更时执行，无感。
      if (ses?.clearStorageData) {
        try { await ses.clearStorageData({ storages: ["serviceworkers"] }); } catch { /* ignore */ }
      }
    }
    try {
      const info = await ses.loadExtension(this.dirOf(rec), { allowFileAccess: true });
      const id = info?.id ? String(info.id) : "";
      if (id) {
        if (rec.electronId !== id) {
          rec.electronId = id;
          this.onChange();
        }
        return id;
      }
    } catch {
      /* 退回自研注入式 */
    }
    return null;
  }

  async unloadNative(rec: ExtensionRecord): Promise<void> {
    const ses = this.session();
    if (!rec.electronId || !ses?.removeExtension) return;
    try {
      ses.removeExtension(rec.electronId);
    } catch {
      /* ignore */
    }
    rec.electronId = undefined;
  }

  /** 无副作用唤醒 SW（startWorkerForScope 只启动 SW，不卸载扩展）。
   *  remove+load 会销毁已打开扩展面板的 isolated world（binding 失效 → hostCall 永挂），
   *  故面板打开前的预热走 startWorkerForScope，失败才回退 remove+load。 */
  async wakeSw(electronId: string): Promise<void> {
    const ses = this.session();
    if (!ses) return;
    try {
      await ses.serviceWorkers?.startWorkerForScope(`chrome-extension://${electronId}/`);
      return;
    } catch {
      /* fall through */
    }
    const rec = this.getRecords().find((r) => r.electronId === electronId);
    if (!rec) return;
    try {
      ses.removeExtension(electronId);
    } catch {
      /* ignore */
    }
    await this.loadNative(rec);
  }

  /** 启动恢复：session 重启后 loadExtension 的状态不保留，必须重新加载才能拿到
   *  electronId（记录里存着上次的 id，但扩展没真的在 session 里）。 */
  // =====================================================================
  // 以下两个方法移植自 siyuan-plugin-browser src/extensions/extensionHost.ts
  // （__sy* 前缀已改为 __ob*）。此前移植只带了 cs-runtime 的读取端
  // （__obOnMessageHandlers || []），收集端（本文件 SW 垫片）漏了 ——
  // 导致 routeSendMessage 恒 __noHandlers、AdGuard popup React boot 挂死。
  // =====================================================================

    /**
     * 单扩展版 SW 垫片：把兼容垫片拼接到该扩展 background 源文件头部并写回磁盘。
     * 返回是否修改了文件 —— 调用方必须卸掉重载该扩展（Electron 才会从磁盘拉新脚本）。
     * 幂等：文件头有标记就跳过；扩展更新（文件重写）后标记消失会重新注入。
     */
    private async shimBackgroundFile(rec: ExtensionRecord): Promise<boolean> {
        const fs = this.fs;
        const path = this.pathMod;
        const SHIM_MARK = "/* ob-bg-shim:v1 */";
        const extPath = this.dirOf(rec);
        try {
 const manifest = JSON.parse(fs.readFileSync(path.join(extPath, "manifest.json"), "utf8"));
            const swPath = manifest.background?.service_worker;
            if (!swPath) return false;
            const abs = path.join(extPath, swPath);
            const src = fs.readFileSync(abs, "utf8");
            if (src.startsWith(SHIM_MARK)) return false;
            // ★ 与源侧不同：无条件垫（源侧只垫用到缺失 API 的扩展）。
            //   实测：Liner 这类"没问题"的扩展不垫时，其 SW 里 __obOnMessageHandlers
            //   缺失 → content script 的 runtime.sendMessage 恒 __noHandlers（重试
            //   16s 耗尽报错）。垫片是防御性空壳 + handler 收集，对正常扩展无害。
            void 0;
            const shim = SHIM_MARK + `
;(function () {
try {
    if (typeof chrome === "undefined") return;
    // 0) onMessage handlers 收集数组：无条件最顶部创建 —— background 顶层的
    //    addListener 稍后 push 进同一数组；宿主 routeSendMessage 据此判断
    //    "handler 已注册（非空）" 还是 "仍在启动期（空 → 重试）"。
    //    （此前数组在 onMessage 包装内创建，若包装条件不满足则数组缺失，
    //    宿主会误报 "垫片未运行" 且无重试依据。）
    self.__obOnMessageHandlers = self.__obOnMessageHandlers || [];
    // 1) 通用存在性垫片：background 里引用到的缺失命名空间统一补空壳，
    //    否则任何一处 undefined 访问都会让 SW 整个崩掉（实测 SiYuan Clip
    //    第一行 contextMenus、中段 commands 各崩一次）。
    var eventHub = function () {
        var fns = [];
        return {
            addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
            removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
            __emit: function () { var a = arguments; fns.forEach(function (fn) { try { fn.apply(null, a); } catch (e) {} }); },
        };
    };
    var MISSING = ["contextMenus", "commands", "action", "browserAction", "pageAction",
        "notifications", "cookies", "downloads", "webNavigation", "webRequest",
        "declarativeNetRequest", "idle", "alarms", "permissions", "sessions",
        "topSites", "bookmarks", "history", "omnibox", "pageCapture"];
    MISSING.forEach(function (ns) {
        if (chrome[ns]) return;
        chrome[ns] = { onChanged: eventHub() };
        // 常见事件口补 addListener（保证注册不抛）
        ["onClicked", "onCommand", "onInstalled", "onStartup", "onChanged"].forEach(function (ev) {
            chrome[ns][ev] = eventHub();
        });
    });
    // 引擎拦截链需要 webRequest/webNavigation 的**全套请求事件**
    // （v4 空壳只补了 5 个通用事件 → AdGuard engine 启动报 .addListener undefined）
    try {
        var REQ_EVENTS = ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived",
            "onAuthRequired", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"];
        var NAV_EVENTS = ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted",
            "onErrorOccurred", "onCreatedNavigationTarget", "onReferenceFragmentUpdated",
            "onTabReplaced", "onHistoryStateUpdated", "onDomainChanged"];
        ["webRequest", "declarativeNetRequest"].forEach(function (ns) {
            if (!chrome[ns]) chrome[ns] = {};
            REQ_EVENTS.forEach(function (ev) {
                if (!chrome[ns][ev] || typeof chrome[ns][ev].addListener !== "function") chrome[ns][ev] = eventHub();
            });
        });
        if (!chrome.webNavigation) chrome.webNavigation = {};
        NAV_EVENTS.forEach(function (ev) {
            if (!chrome.webNavigation[ev] || typeof chrome.webNavigation[ev].addListener !== "function") chrome.webNavigation[ev] = eventHub();
        });
        // privacy 壳（AdGuard StealthService 调 privacy.network.webRTCIPHandlingPolicy）
        if (!chrome.privacy) chrome.privacy = {};
        if (!chrome.privacy.network) chrome.privacy.network = {};
        ["webRTCIPHandlingPolicy", "networkPredictionEnabled"].forEach(function (k) {
            if (!chrome.privacy.network[k]) chrome.privacy.network[k] = {
                get: function (d, cb) { var v = { value: "default" }; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); },
                set: function (d, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
                clear: function (d, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
            };
        });
        if (!chrome.webNavigation.getAllFrames) chrome.webNavigation.getAllFrames = function (opts, cb) { var v = []; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
    } catch (e) {}
    // 6) 给 webextension-polyfill 的 browser 对象补 webNavigation：
    //    polyfill 的 schema 天生不含 webNavigation（AdGuard 代码却引用
    //    browser.webNavigation.*），垫片执行时 polyfill 尚未构建，故延迟一拍
    //    注入 —— 晚于 polyfill 构建、早于 engine.start 的异步流程。
    setTimeout(function () {
        try {
            if (typeof browser !== "undefined" && browser && !browser.webNavigation && chrome.webNavigation) {
                browser.webNavigation = chrome.webNavigation;
            }
        } catch (e) {}
    }, 0);
    // commands 补 API 形态（manifest 里声明的快捷键注册）
    if (chrome.commands && !chrome.commands.getAll) {
        chrome.commands.getAll = function (cb) { cb && cb([]); };
    }
    // 3) onInstalled 补发：Electron 不触发 runtime.onInstalled，而不少扩展
    //    把 contextMenus.create 全放它的回调里（实测 SiYuan Clip）——
    //    不补发则菜单注册永不执行。SW 每次唤醒补发一次正符合
    //    "重启需重新注册内存态菜单"的生命周期语义。
    try {
        if (chrome.runtime && chrome.runtime.onInstalled && !chrome.runtime.onInstalled.__obWrapped) {
            var oiFns = [];
            var wrapped = {
                addListener: function (fn) { if (typeof fn === "function") oiFns.push(fn); },
                removeListener: function (fn) { var i = oiFns.indexOf(fn); if (i >= 0) oiFns.splice(i, 1); },
            };
            Object.defineProperty(chrome.runtime, "onInstalled", {
                configurable: true,
                get: function () { return wrapped; },
            });
            wrapped.__obWrapped = true;
            // Chromium 原生触发在 Electron 下不存在；延迟让扩展先完成顶层注册
            setTimeout(function () {
                oiFns.forEach(function (fn) { try { fn({ reason: "install" }); } catch (e) {} });
            }, 200);
        }
    } catch (e) {}
    // 2) contextMenus 特化：记录注册项，点击经 storage 通道由宿主触发
    if (!chrome.contextMenus.__obStore) {
        var store = { items: {}, click: eventHub() };
        chrome.contextMenus.removeAll = function (cb) { store.items = {}; if (cb) cb(); };
        chrome.contextMenus.create = function (props) { if (props && props.id) store.items[props.id] = props; };
        chrome.contextMenus.onClicked = store.click;
        chrome.contextMenus.__obStore = store;
        self.__obContextMenuStore = store;
        // 宿主点击菜单 → 写 storage → 这里触发 onClicked
        if (chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function (changes, area) {
                try {
                    if (area !== "local" || !changes.__obMenuClick) return;
                    var p = changes.__obMenuClick.newValue;
                    store.click.__emit(p.info, p.tab);
                } catch (e) {}
            });
        }
    }
    // 3) runtime.onMessage 路由（CS→SW 方向的通用替代）：
    //    Electron 没实现 SW↔CS 消息路由（SW 的 tabs.sendMessage 恒报
    //    "Receiving end does not exist"，CS 的 runtime.sendMessage 同理静默丢失）。
    //    这里包装 onMessage.addListener 收集扩展注册的 handlers，
    //    配合 storage 通道（__obRouteIn 请求 / __obRouteResp_<id> 响应）
    //    用官方 chrome.storage 实现两端路由 —— storage 在 CS 和 SW 里
    //    都是真实可用的（实测）。CS 侧的发送端 shim 由 sw-bridge 经 CDP
    //    注入到扩展的 isolated world。
    try {
        if (chrome.runtime && chrome.runtime.onMessage && !chrome.runtime.onMessage.__obWrapped) {
            var omFns = [];
            var omWrapped = {
                addListener: function (fn) { if (typeof fn === "function") omFns.push(fn); },
                removeListener: function (fn) { var i = omFns.indexOf(fn); if (i >= 0) omFns.splice(i, 1); },
            };
            Object.defineProperty(chrome.runtime, "onMessage", {
                configurable: true,
                get: function () { return omWrapped; },
            });
            omWrapped.__obWrapped = true;
            self.__obOnMessageHandlers = omFns;
            if (chrome.storage && chrome.storage.onChanged) {
                chrome.storage.onChanged.addListener(function (changes, area) {
                    try {
                        if (area !== "local" || !changes.__obRouteIn || !changes.__obRouteIn.newValue) return;
                        var env = changes.__obRouteIn.newValue;
                        if (!env || typeof env.reqId === "undefined") return;
                        var responded = false;
                        var sendResponse = function (resp) {
                            if (responded) return;
                            responded = true;
                            var key = "__obRouteResp_" + env.reqId;
                            var item = {};
                            item[key] = { resp: resp === undefined ? null : resp };
                            try { chrome.storage.local.set(item); } catch (e) {}
                        };
                        var anySync = false;
                        omFns.forEach(function (fn) {
                            try {
                                var r = fn(env.msg, env.sender || { id: "ob-host" }, sendResponse);
                                if (r === true) {
                                    // handler 返回 true 表示异步 sendResponse，等待其回调
                                } else if (r !== undefined) {
                                    anySync = true;
                                    sendResponse(r);
                                }
                            } catch (e) {}
                        });
                        if (!anySync && omFns.length === 0) sendResponse(undefined);
                    } catch (e) {}
                });
            }
        }
    } catch (e) {}
    // 4) runtime.onConnect 端口语义（AdGuard 等经 port 与 SW 通信取状态）：
    //    Electron 没实现扩展间 port 路由。这里收集 onConnect listeners；
    //    宿主（cs-runtime routePortMessage）经 CDP 建连时构造 port 对象派发，
    //    port.postMessage 写入 outbox、由宿主轮询带回页面世界。
    try {
        if (chrome.runtime && chrome.runtime.onConnect && !chrome.runtime.onConnect.__obWrapped) {
            var ocFns = [];
            var ocWrapped = {
                addListener: function (fn) { if (typeof fn === "function") ocFns.push(fn); },
                removeListener: function (fn) { var i = ocFns.indexOf(fn); if (i >= 0) ocFns.splice(i, 1); },
            };
            Object.defineProperty(chrome.runtime, "onConnect", {
                configurable: true,
                get: function () { return ocWrapped; },
            });
            ocWrapped.__obWrapped = true;
            self.__obOnConnectFns = ocFns;
            self.__obPorts = self.__obPorts || {};
            self.__obPortOutbox = self.__obPortOutbox || {};
        }
    } catch (e) {}
    // 5) chrome.tabs 事件收集（AdGuard 等靠 onCreated/onUpdated 维护 tabContext，
    //    Electron SW 里这些事件永不触发 → 扩展取 tab 状态时 getTabContext 恒
    //    undefined → popup 卡 loading）。宿主经 "tabevent" 通道手工喂 tab。
    try {
        if (chrome.tabs && !chrome.tabs.__obTabWrapped) {
            // 5a) tabs API 补桩：Electron 原生 tabs 缺 create/update/remove 等，
            //     AdGuard onInstalled 流程调 tabs.create 直接 TypeError →
            //     初始化链中断（tabsApi.start 永不执行 → popup 取状态卡 loading）
            if (!chrome.tabs.create) chrome.tabs.create = function (props, cb) { var t = { id: 1, index: 0, windowId: 1, active: true, url: (props && props.url) || "" }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
            if (!chrome.tabs.update) chrome.tabs.update = function (id, props, cb) { var t = { id: typeof id === "number" ? id : 1, url: (props && props.url) || "" }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
            if (!chrome.tabs.remove) chrome.tabs.remove = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
            if (!chrome.tabs.get) chrome.tabs.get = function (id, cb) { var t = { id: id, index: 0, windowId: 1, active: false, url: "" }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
            if (!chrome.tabs.reload) chrome.tabs.reload = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
            if (chrome.tabs.TAB_ID_NONE === undefined) chrome.tabs.TAB_ID_NONE = -1;
            // 5c) permissions API 补桩：AdGuard 引擎启动链调 permissions.contains
            //     （Electron 原生缺失 → "Cannot be started"）。MV3 所需权限默认放行。
            if (chrome.permissions) {
                if (!chrome.permissions.contains) chrome.permissions.contains = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                if (!chrome.permissions.request) chrome.permissions.request = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                if (!chrome.permissions.remove) chrome.permissions.remove = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                if (!chrome.permissions.getAll) chrome.permissions.getAll = function (cb) { var v = { origins: [], permissions: [] }; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
            }
            // 5b) tabs 事件收集（AdGuard 等靠 onCreated/onUpdated 维护 tabContext，
            //     Electron SW 里这些事件永不触发 → 宿主经 "tabevent" 通道手工喂 tab）
            var tcFns = [], tuFns = [], taFns = [];
            var tabEvFor = function (fns) {
                return {
                    addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                    removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                    hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                };
            };
            try { Object.defineProperty(chrome.tabs, "onCreated", { configurable: true, get: function () { return tabEvFor(tcFns); } }); } catch (e) { chrome.tabs.onCreated = tabEvFor(tcFns); }
            try { Object.defineProperty(chrome.tabs, "onUpdated", { configurable: true, get: function () { return tabEvFor(tuFns); } }); } catch (e) { chrome.tabs.onUpdated = tabEvFor(tuFns); }
            try { Object.defineProperty(chrome.tabs, "onActivated", { configurable: true, get: function () { return tabEvFor(taFns); } }); } catch (e) { chrome.tabs.onActivated = tabEvFor(taFns); }
            chrome.tabs.__obTabWrapped = true;
            self.__obTabCreatedFns = tcFns;
            self.__obTabUpdatedFns = tuFns;
            self.__obTabActivatedFns = taFns;
            // 5d) tabs.sendMessage 回程路由：Electron 原生实现恒报
            //     "Receiving end does not exist"（SW↔CS 消息路由缺失）——
            //     剪藏 tip/结果回不到页面、lastError 刷屏的根因。请求写
            //     __obTabsOutbox，宿主在 routeSendMessage 后的监听窗口内
            //     轮询取走 → 派发到 content 世界 → evalInSw 写回 __obTabsPending。
            try {
                var tsmSeq = 0;
                var tsm = function (tabId, msg, cb, respCb) {
                    var callback = typeof cb === "function" ? cb : (typeof respCb === "function" ? respCb : null);
                    var rid = "t" + (++tsmSeq) + "_" + Date.now().toString(36);
                    self.__obTabsOutbox = self.__obTabsOutbox || [];
                    self.__obTabsOutbox.push({ id: rid, tabId: typeof tabId === "number" ? tabId : null, msg: msg === undefined ? null : msg });
                    if (callback) {
                        self.__obTabsPending = self.__obTabsPending || {};
                        self.__obTabsPending[rid] = function (respJson) {
                            delete self.__obTabsPending[rid];
                            var resp;
                            try { resp = respJson == null ? undefined : JSON.parse(respJson); } catch (e3) { resp = undefined; }
                            try { callback(resp); } catch (e3) {}
                        };
                        setTimeout(function () {
                            if (self.__obTabsPending && self.__obTabsPending[rid]) {
                                delete self.__obTabsPending[rid];
                                try { callback(undefined); } catch (e3) {}
                            }
                        }, 20000);
                    }
                };
                try { Object.defineProperty(chrome.tabs, "sendMessage", { configurable: true, get: function () { return tsm; } }); }
                catch (e2) { chrome.tabs.sendMessage = tsm; }
            } catch (e) {}
        }
    } catch (e) {}
    // 5e) chrome.storage.sync 修复：Electron SW 原生 sync.get 回调 undefined
    //     （实测 SiYuan Clip storageSyncGet 拿到 undefined → 解构抛 TypeError
    //     → article 剪藏流程崩进 catch → tip_siyuan_kernel_unavailable）。
    //     与宿主 CS 代理同策略：sync 代理到 local（CS 世界经宿主代理同样落
    //     在 SW 的 storage.local，数据同源）。
    try {
        if (chrome.storage && (!chrome.storage.sync || !chrome.storage.sync.__obShim)) {
            var syncArea = {
                __obShim: true,
                get: function (keys, cb) {
                    var done = function (v) { if (typeof cb === "function") { try { cb(v == null ? {} : v); } catch (e3) {} } };
                    try {
                        var p = chrome.storage.local.get(keys == null ? {} : keys, done);
                        if (p && typeof p.then === "function") p.then(function (v) { done(v); }, function () { done({}); });
                        return p;
                    } catch (e2) { done({}); }
                },
                set: function (items, cb) { return chrome.storage.local.set(items == null ? {} : items, cb); },
                remove: function (keys, cb) { return chrome.storage.local.remove(keys == null ? [] : keys, cb); },
                clear: function (cb) { return chrome.storage.local.clear(cb); },
                getBytesInUse: function (keys, cb) { var v = 0; if (typeof cb === "function") { try { cb(v); } catch (e3) {} } return Promise.resolve(v); },
            };
            try { Object.defineProperty(chrome.storage, "sync", { configurable: true, get: function () { return syncArea; } }); }
            catch (e2) { chrome.storage.sync = syncArea; }
        }
    } catch (e) {}
} catch (e) {}
})();
`;
            fs.writeFileSync(abs, shim + src, "utf8");
            return true;
            return false;
        } catch {
            // 单个扩展垫片失败不影响其它
            return false;
        }
    }

    private async injectBackgroundShims(): Promise<void> {
        let changedShimCount = 0;
        for (const rec of this.getRecords()) {
            if (await this.shimBackgroundFile(rec)) changedShimCount++;
        }
        if (changedShimCount > 0) {
            // 垫片改了 SW 源码，Electron 侧的已加载扩展需要卸掉重载 ——
            // 紧随其后的逐个 loadNative 发现原生缺席会重新 loadExtension
            const ses = this.session();
            if (ses?.getAllExtensions && ses.unloadExtension) {
                for (const x of ses.getAllExtensions()) {
                    try { ses.unloadExtension(x.id); } catch {}
                }
            }
            // 关键：分区里持久化的 SW 注册/脚本缓存不随 loadExtension 更新
            // （实测：background.js 已重写为新版，重载后 SW 仍执行旧脚本）。
            // 清掉 SW 存储后，重载注册必然从磁盘拉新脚本。仅垫片变更时执行；
            // 网站自身的 SW 被清后下次访问会自动重注册，无感。
            if (ses?.clearStorageData) {
                try {
                    await ses.clearStorageData({ storages: ["serviceworkers"] });
                } catch {}
            }
        }
    }

      private async neutralizeNativeContentScripts(): Promise<void> {
        const fs = this.fs;
        const path = this.pathMod;
        let changed = false;
        for (const rec of this.getRecords()) {
            if (!rec.enabled) continue;
            const extPath = this.dirOf(rec);
            try {
                const manifestPath = path.join(extPath, "manifest.json");
                const origPath = path.join(extPath, "manifest.orig.json");
                const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                const groups = manifest.content_scripts || [];
                if (groups.length === 0) continue;
                // 原始 manifest 只在首次清空时备份（此后 manifest 已无 CS，避免
                // 用清空版覆盖备份）
                if (!fs.existsSync(origPath)) {
                    fs.writeFileSync(origPath, JSON.stringify(manifest, null, 2), "utf8");
                }
                manifest.content_scripts = [];
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
                changed = true;
            } catch {
                // 单个扩展失败不影响其它
            }
        }
        if (changed) {
            // 已加载的原生扩展需要卸掉重载才会按新 manifest 运行；
            // reconcileNative（紧随其后调用）发现原生缺席会重新 loadExtension
            const ses = this.session();
            if (ses?.getAllExtensions && ses.unloadExtension) {
                for (const x of ses.getAllExtensions()) {
                    try { ses.unloadExtension(x.id); } catch {}
                }
            }
        }
    }

  async syncNativeOnStartup(): Promise<void> {
    // 源侧 load() 同序：先垫 SW 文件 / 清原生 CS 副本（有变更会卸掉已加载原生），
    // 再逐个恢复 —— 顺序不能反，否则垫片改了文件而 session 里还是旧 SW。
    await this.injectBackgroundShims();
    await this.neutralizeNativeContentScripts();
    for (const rec of this.getRecords()) {
      if (rec.enabled) await this.loadNative(rec);
      else await this.unloadNative(rec);
    }
  }

  /** dom-ready 时调用：确保该页签的 CDP 会话与各扩展自建世界就绪 */
  ensureCsRuntime(webview: IWebviewTag): void {
    try {
      this.initCsRuntimeOnce();
      ensureCsRt(webview);
    } catch (e) {
      console.warn("[obsidian-browser] ensureCsRuntime failed:", e);
    }
  }

  disposeCsRuntime(webview: IWebviewTag): void {
    try {
      disposeCsRt(webview);
    } catch {
      /* ignore */
    }
  }

  private csRuntimeInited = false;

  private initCsRuntimeOnce(): void {
    if (this.csRuntimeInited) return;
    initCsRuntime({
      listNativeExts: () =>
        this.getRecords()
          .filter((r) => r.enabled && !!r.electronId)
          .map((r) => ({
            electronId: r.electronId!,
            path: this.dirOf(r),
            name: r.name,
            version: r.version,
            // 记录里没有 defaultLocale；messages() 的回退链（defaultLocale → en → zh_CN）会兜住
            defaultLocale: "en",
            contentScripts: r.contentScripts.map((cs) => ({
              matches: cs.matches,
              excludeMatches: cs.excludeMatches,
              js: cs.js,
              css: cs.css,
              runAt: cs.runAt,
              allFrames: cs.allFrames,
            })),
          })),
      readFile: (extPath: string, rel: string) =>
        this.fs.readFileSync(this.pathMod.join(extPath, rel), "utf8"),
      messages: (extPath: string, defaultLocale?: string) => {
        for (const locale of [defaultLocale, "en", "zh_CN"].filter(Boolean)) {
          try {
            return JSON.parse(
              this.fs.readFileSync(this.pathMod.join(extPath, `_locales/${locale}/messages.json`), "utf8"),
            );
          } catch {
            /* try next */
          }
        }
        return {};
      },
      wakeOne: async (electronId: string) => {
        const rec = this.getRecords().find((r) => r.electronId === electronId);
        if (!rec) return null;
        try {
          this.session()?.removeExtension(electronId);
        } catch {
          /* ignore */
        }
        return await this.loadNative(rec);
      },
      wakeSw: async (electronId: string) => {
        await this.wakeSw(electronId);
      },
      openExtensionOptions: (ext) => {
        const rec = this.getRecords().find((r) => r.electronId === ext.electronId);
        if (rec) this.onOpenOptionsPage?.(rec);
      },
    });
    this.csRuntimeInited = true;
  }

  /** 扩展 popup 设置齿轮（openOptionsPage → binding 桥 → 这里）→ 宿主开设置页 */
  onOpenOptionsPage: ((rec: ExtensionRecord) => void) | null = null;

  /** 扩展所在磁盘目录（公开给 PopupLayer/世界注入用） */
  extPathOf(rec: ExtensionRecord): string {
    return this.dirOf(rec);
  }

  /** PopupLayer/整页注入共用的扩展世界信息 */
  extInfoOf(rec: ExtensionRecord): ICsExtInfo {
    return {
      electronId: rec.electronId ?? "",
      path: this.dirOf(rec),
      name: rec.name,
      version: rec.version,
      defaultLocale: "en",
      contentScripts: rec.contentScripts.map((cs) => ({ matches: cs.matches, js: cs.js, css: cs.css })),
    };
  }

  remove(id: string): void {
    const rec = this.getRecords().find((r) => r.id === id);
    if (rec) {
      void this.unloadNative(rec);
      try {
        this.fs?.rmSync(this.pathMod.join(this.rootDir, rec.dir), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    const records = this.getRecords();
    const i = records.findIndex((r) => r.id === id);
    if (i >= 0) records.splice(i, 1);
    this.scriptCache.clear();
    this.iconCache.clear();
    this.onChange();
  }

  setEnabled(id: string, enabled: boolean): void {
    const rec = this.getRecords().find((r) => r.id === id);
    if (!rec) return;
    rec.enabled = enabled;
    if (enabled) void this.loadNative(rec);
    else void this.unloadNative(rec);
    this.onChange();
  }

  // ---------------- injection ----------------

  /** Scripts that must exist before the page's own scripts run. */
  documentStartPayload(url: string): { css: string[]; js: string[] } {
    const out: { css: string[]; js: string[] } = { css: [], js: [] };
    if (!this.getEnabled()) return out;
    for (const rec of this.getRecords()) {
      if (!rec.enabled) continue;
      for (const cs of rec.contentScripts) {
        if (cs.runAt !== "document_start") continue;
        if (!this.matches(url, cs)) continue;
        out.css.push(...this.readAll(rec, cs.css));
        out.js.push(this.shimFor(rec) + "\n" + this.readAll(rec, cs.js).join(";\n"));
      }
    }
    return out;
  }

  /** Everything else, injected once the guest reaches dom-ready. */
  async injectDocumentEnd(webview: { insertCSS(css: string): Promise<unknown>; executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }, url: string): Promise<void> {    if (!this.getEnabled()) return;
    for (const rec of this.getRecords()) {
      if (!rec.enabled) continue;
      for (const cs of rec.contentScripts) {
        if (cs.runAt === "document_start") continue;
        if (!this.matches(url, cs)) continue;
        for (const css of this.readAll(rec, cs.css)) {
          if (css) void webview.insertCSS(css).catch(() => undefined);
        }
        const js = this.readAll(rec, cs.js).filter(Boolean);
        if (js.length) {
          const code = this.shimFor(rec) + "\n" + js.join(";\n");
          void webview.executeJavaScript(code, false).catch(() => undefined);
        }
      }
    }
  }

  /** 设置页 URL：优先 chrome-extension://（原生加载后可直达，整页垫片按 electronId 匹配） */
  optionsPageUrl(rec: ExtensionRecord): string | null {
    if (!rec.options) return null;
    const rel = String(rec.options).replace(/^\.\//, "");
    if (rec.electronId) return "chrome-extension://" + rec.electronId + "/" + rel;
    return this.extensionFileUrl(rec, rel); // 退化路径：未拿到 electronId 时仅尽力打开
  }

  /**
   * chrome-extension:// 整页（popup/options 以页签直开）的垫片注入 —— 与源侧
   * maybeInjectExtensionPage 同语义：这种页面跑在 Electron 受限主世界，
   * sendMessage/storage 全部不可用（AdGuard 会永远停在 loading），必须重建
   * 扩展专属世界并按页面 HTML 重放脚本。仅处理本插件管理的扩展。
   */
  async injectExtensionPage(webview: IWebviewTag, url: string): Promise<void> {
    if (!this.getEnabled()) return;
    const m = String(url || "").match(/^chrome-extension:\/\/([^/?#\s]+)(\/[^?#]*)?/i);
    if (!m) return;
    const electronId = m[1];
    const pagePath = (m[2] || "/").slice(1);
    if (!pagePath) return;
    const rec = this.getRecords().find((r) => r.electronId === electronId && r.enabled);
    if (!rec) return; // 非本插件管理的扩展 —— 交给 Electron 原生行为
    const info: ICsExtInfo = {
      electronId,
      path: this.dirOf(rec),
      name: rec.name,
      version: rec.version,
      defaultLocale: "",
      contentScripts: rec.contentScripts.map((cs) => ({ matches: cs.matches, js: cs.js, css: cs.css })),
    };
    const out = await injectExtensionPageRuntime({
      webview,
      extPath: info.path,
      electronId,
      pagePath,
      begin: () => beginPopupWorld(webview, info),
      evalJs: (src, relPath) => {
        const fakeUrl = "chrome-extension://" + electronId + "/" + String(relPath).replace(/^\.\//, "");
        const prefixed = "self.__obSetCurrentScript && self.__obSetCurrentScript(" + JSON.stringify(fakeUrl) + ");\n" + src;
        return evalPopupJs(webview, info, prefixed).then((rr) => {
          if (!rr.ok) throw new Error(rr.error);
          return rr.value;
        });
      },
    });
    if (!out.ok) console.warn("[obsidian-browser] 扩展页面垫片注入失败(" + pagePath + "):", out.error);
  }

  /** The chrome.* shim source for this extension (popups and content scripts). */
  shimSourceFor(rec: ExtensionRecord): string {
    return this.shimFor(rec);
  }

  private shimFor(rec: ExtensionRecord): string {
    const base = this.extensionFileUrl(rec, "");
    return buildShimSource(rec.id, base);
  }

  private matches(url: string, cs: ExtensionContentScript): boolean {
    if (!cs.matches?.length) return false;
    const hit = cs.matches.some((p) => matchPattern(p, url));
    if (!hit) return false;
    return !cs.excludeMatches.some((p) => matchPattern(p, url));
  }

  // ---------------- files ----------------

  private readAll(rec: ExtensionRecord, rel: string[]): string[] {
    return rel.map((r) => this.readFile(rec, r)).filter((s) => !!s);
  }

  private readFile(rec: ExtensionRecord, relPath: string): string {
    const key = rec.dir + "/" + relPath;
    const cached = this.scriptCache.get(key);
    if (cached !== undefined) return cached;
    let text = "";
    try {
      text = this.fs.readFileSync(this.pathMod.join(this.rootDir, rec.dir, relPath), "utf8");
    } catch {
      text = "";
    }
    this.scriptCache.set(key, text);
    return text;
  }

  /** file:// URL of a file inside the extension directory. */
  extensionFileUrl(rec: ExtensionRecord, relPath: string): string {
    const abs = this.pathMod.join(this.rootDir, rec.dir, relPath || "").replace(/\\/g, "/");
    return "file:///" + abs.replace(/^\/+/, "");
  }

  /** Extension icons must be data URLs: web pages cannot load file:// images. */
  iconDataUrl(rec: ExtensionRecord): string {
    if (!rec.icon) return "";
    const cached = this.iconCache.get(rec.id);
    if (cached !== undefined) return cached;
    let out = "";
    try {
      const abs = this.pathMod.join(this.rootDir, rec.dir, rec.icon);
      const buf: Buffer = this.fs.readFileSync(abs);
      const ext = (rec.icon.split(".").pop() || "png").toLowerCase();
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      out = `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      out = "";
    }
    this.iconCache.set(rec.id, out);
    return out;
  }

  // ---------------- manifest ----------------

  private recordFromManifest(m: RawManifest, dir: string): ExtensionRecord {
    const action = m.action ?? m.browser_action ?? {};
    const icon = pickIcon(action.default_icon ?? m.icons);
    const contentScripts: ExtensionContentScript[] = (m.content_scripts ?? []).map((cs) => ({
      matches: cs.matches ?? [],
      excludeMatches: cs.exclude_matches ?? [],
      js: cs.js ?? [],
      css: cs.css ?? [],
      runAt: (cs.run_at as ExtensionContentScript["runAt"]) ?? "document_idle",
      allFrames: !!cs.all_frames,
    }));

    const id = dir;
    return {
      id,
      name: m.name || dir,
      version: m.version || "0.0.0",
      description: m.description,
      dir,
      enabled: true,
      installedAt: Date.now(),
      contentScripts,
      icon,
      popup: action.default_popup,
      options: m.options_page ?? m.options_ui?.page ?? undefined,
      permissions: m.permissions ?? [],
    };
  }

  private upsert(rec: ExtensionRecord): void {
    const records = this.getRecords();
    const i = records.findIndex((r) => r.id === rec.id);
    if (i >= 0) records[i] = rec;
    else records.push(rec);
    this.scriptCache.clear();
    this.iconCache.clear();
    this.onChange();
  }

  private sanitizeDir(name: string): string {
    return (
      (name || "extension")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, "-")
        .slice(0, 60) +
      "-" +
      Math.random().toString(36).slice(2, 6)
    );
  }
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function pickIcon(icon: string | Record<string, string> | undefined): string {
  if (!icon) return "";
  if (typeof icon === "string") return icon;
  const sizes = Object.keys(icon)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (sizes.length) return icon[String(sizes[sizes.length - 1])];
  return Object.values(icon)[0] ?? "";
}

/** Chrome match patterns: `<all_urls>`, `*://*.host/path`, `https://host/*`. */
export function matchPattern(pattern: string, url: string): boolean {
  if (!pattern) return false;
  if (pattern === "<all_urls>") return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }

  const schemeSep = pattern.indexOf("://");
  if (schemeSep < 0) return false;
  const scheme = pattern.slice(0, schemeSep);
  const rest = pattern.slice(schemeSep + 3);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "/*" : rest.slice(slash);

  if (scheme !== "*") {
    const want = scheme.replace(/:$/, "");
    if (u.protocol.replace(/:$/, "") !== want) return false;
  } else if (!/^https?:$/.test(u.protocol)) {
    return false;
  }

  if (host !== "*") {
    if (host.startsWith("*.")) {
      const base = host.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith("." + base)) return false;
    } else if (u.hostname !== host) {
      return false;
    }
  }

  if (path !== "/*" && path !== "*") {
    // Only leading/trailing wildcards are handled — enough for real manifests.
    const re = new RegExp(
      "^" +
        path
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
    if (!re.test(u.pathname + u.search)) return false;
  }
  return true;
}
