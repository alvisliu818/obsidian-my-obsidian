/* eslint-disable @typescript-eslint/no-explicit-any */
import type { App } from "obsidian";
import { requestUrl } from "obsidian";
import type { ExtensionContentScript, ExtensionRecord, IWebviewTag } from "../types";
import { nodeRequire, sessionFromPartition, vaultBasePath } from "../utils/electron";
import { dnrBlocker } from "../browser/dnrEngine";
import { SHIM_BODY, SHIM_END_MARK, shimMark } from "./backgroundShim";
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
    private flushStore: () => unknown = () => {},
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
  /**
   * 智能来源安装（源侧 installFromInput 同款）：输入可以是 Edge 扩展 id /
   * 商店详情页 URL / http(s) CRX 直链 / 本地 .crx|.zip 包路径 / 本地扩展目录。
   * 按形态分流到对应安装通道。
   */
  async installFromInput(raw: string): Promise<ExtensionRecord> {
    const v = String(raw || "").trim();
    if (!v) throw new Error("输入为空");
    // Edge 加载项商店输入优先识别（32 位 [a-p] id 或商店详情页链接，与本地路径形态不冲突）
    if (parseEdgeAddonId(v)) {
      await this.installFromEdgeAddons(v);
      const rec = this.getRecords().find((r) => r.electronId);
      if (!rec) throw new Error("Edge 扩展安装后未找到记录");
      return rec;
    }
    // http(s) 直链
    if (/^https?:\/\//i.test(v)) return await this.installFromUrl(v);
    // 本地路径：文件（.crx/.zip 包）或目录（未打包扩展）
    const fs = this.fs;
    const p = v.replace(/^file:\/\//i, "").replace(/^"|"$/g, "");
    let st: any = null;
    try {
      st = fs.existsSync(p) ? fs.statSync(p) : null;
    } catch {
      /* not a local path */
    }
    if (st?.isFile()) {
      const buf = fs.readFileSync(p);
      return await this.installFromArchive(buf, this.pathMod.basename(p));
    }
    if (st?.isDirectory()) {
      const files: { path: string; data: Uint8Array | ArrayBuffer }[] = [];
      const walk = (dir: string, rel: string): void => {
        for (const name of fs.readdirSync(dir)) {
          const abs = this.pathMod.join(dir, name);
          const r = rel ? rel + "/" + name : name;
          const s2 = fs.statSync(abs);
          if (s2.isDirectory()) walk(abs, r);
          else files.push({ path: r, data: fs.readFileSync(abs) });
        }
      };
      walk(p, "");
      return await this.installFromFiles(files);
    }
    throw new Error("无法识别的来源：填 Edge 扩展 id/详情页链接、http(s) CRX 直链，或本地包/目录路径");
  }

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

  /** 扩展磁盘目录的公开访问（userscriptInjector 读 {file} 注册的脚本代码用） */
  dirOfPublic(rec: ExtensionRecord): string {
    return this.dirOf(rec);
  }

  /** webview 用的 partition 上的 session：loadExtension / removeExtension / serviceWorkers 都在它上面 */
  private session(): any | null {
    return sessionFromPartition(BROWSER_PARTITION);
  }

  /** 原生加载并写回 electronId；失败返回 null（退回自研注入式） */
  async loadNative(rec: ExtensionRecord): Promise<string | null> {
    const ses = this.session();
    if (!ses?.loadExtension) return null;
    // AdGuard 装好/启用即挂 DNR 规则引擎（惰性，幂等）：网络层拦截的规则来源
    if (/adguard/i.test(rec.name)) void dnrBlocker.load(this.dirOf(rec));
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
  // SW 垫片：v23 全量移植自 siyuan-plugin-browser（__sy* → __ob*），垫片体
  // 在 backgroundShim.ts（DNR 虚拟存储 / chrome.userScripts 适配器 / tabs
  // / windows / permissions / webRequest·webNavigation·downloads 真实事件面
  // / TM extdb 守卫等）。此前只带了 cs-runtime 的读取端（__obOnMessageHandlers
  // || []），收集端（本文件 SW 垫片）漏了 —— 导致 routeSendMessage 恒
  // __noHandlers、AdGuard popup React boot 挂死。
  // =====================================================================

    /**
     * 单扩展版 SW 垫片：把兼容垫片拼接到该扩展 background 源文件头部并写回磁盘。
     * 返回是否修改了文件 —— 调用方必须卸掉重载该扩展（Electron 才会从磁盘拉新脚本）。
     * 幂等：文件头有标记就跳过；扩展更新（文件重写）后标记消失会重新注入。
     */
    private async shimBackgroundFile(rec: ExtensionRecord): Promise<boolean> {
        const fs = this.fs;
        const path = this.pathMod;
        const SHIM_MARK = shimMark();
        const extPath = this.dirOf(rec);
        const attempt = (): boolean => {
            const manifest = JSON.parse(fs.readFileSync(path.join(extPath, "manifest.json"), "utf8"));
            const swPath = manifest.background?.service_worker;
            if (!swPath) return false;
            const abs = path.join(extPath, swPath);
            let src = fs.readFileSync(abs, "utf8");
            if (src.startsWith(SHIM_MARK)) return false;
            // ★ 与源侧不同：无条件垫（源侧只垫用到缺失 API 的扩展）。
            //   实测：Liner 这类"没问题"的扩展不垫时，其 SW 里 __obOnMessageHandlers
            //   缺失 → content script 的 runtime.sendMessage 恒 __noHandlers（重试
            //   16s 耗尽报错）。v23 垫片是防御性空壳 + handler 收集，对正常扩展无害。
            // 换版剥离：文件头是旧版垫片且含尾标记 → 截掉旧垫片段只留原源码再前置
            // 新垫片（lastIndexOf：多层堆叠时以最新一代尾标记为准）。无尾标记的
            // 更老版本走守卫幂等堆叠（各节都有 __ob* 守卫，双跑无害）。
            let original = src;
            if (/^\/\* ob-bg-shim:v\d+[^*]*\*\//.test(original)) {
                const ei = original.lastIndexOf(SHIM_END_MARK);
                if (ei >= 0) original = original.slice(ei + SHIM_END_MARK.length).replace(/^\s*\n/, "");
            }
            const shim = SHIM_MARK + SHIM_BODY;
            fs.writeFileSync(abs, shim + original, "utf8");
            return true;
        };
        try {
            return attempt();
        } catch (e) {
            // 单个扩展垫片失败不影响其它 —— 但必须留痕：静默吞掉会让扩展以无垫片
            // 状态长期运行（源侧教训：TM 三周无垫片、油猴消息全挂而无感知）。
            console.warn("[ob-browser] injectBackgroundShims failed for", rec.name || rec.dir, ":", e instanceof Error ? e.message : e);
            // 大文件瞬时锁（Defender/索引服务）常亚秒级消失：延迟重试一次
            try {
                await new Promise((r) => setTimeout(r, 500));
                const ok = attempt();
                if (ok) console.warn("[ob-browser] injectBackgroundShims retry ok:", rec.name || rec.dir);
                return ok;
            } catch (e2) {
                console.warn("[ob-browser] injectBackgroundShims retry failed for", rec.name || rec.dir, ":", e2 instanceof Error ? e2.message : e2);
                return false;
            }
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

  /** 新标签页扩展数据代答（topSites/bookmarks/history，main.ts 用自己的库注入） */
  userDataProvider?: (kind: string, args: any) => Promise<any>;

  /** AdGuard 扩展的磁盘目录（DNR 规则引擎的规则集来源）；无原生 AdGuard 返回 null。 */
  findAdGuardDir(): string | null {
    const rec = this.getRecords().find(
      (r) => r.enabled && r.electronId && /adguard/i.test(r.name),
    );
    return rec ? this.dirOf(rec) : null;
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
      userData: (kind: string, args: any) =>
        this.userDataProvider ? this.userDataProvider(kind, args) : Promise.reject(new Error("userData provider missing")),
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
      newtab: (m as any).chrome_url_overrides?.newtab ?? undefined,
      permissions: m.permissions ?? [],
    };
  }

  private upsert(rec: ExtensionRecord): void {
    // 记录变更立即落盘：扩展记录珍贵，防抖窗口内插件重载会整条丢失
    // （实测：装 Violentmonkey 后模块重载，记录蒸发）。records 全量替换写。
    const records = this.getRecords();
    const i = records.findIndex((r) => r.id === rec.id);
    if (i >= 0) records[i] = rec;
    else records.push(rec);
    this.scriptCache.clear();
    this.iconCache.clear();
    this.onChange();
    this.flushStore();
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
import { matchPattern } from "./matchPattern";
export { matchPattern };
