/* eslint-disable @typescript-eslint/no-explicit-any */
import type { App } from "obsidian";
import { requestUrl } from "obsidian";
import type { ExtensionContentScript, ExtensionRecord, IWebviewTag } from "../types";
import { nodeRequire, sessionFromPartition, vaultBasePath } from "../utils/electron";
import { extractExtensionArchive } from "./crx";
import { buildShimSource } from "./cs-runtime";
import { EDGE_ADDONS_HOME, downloadEdgeCrx, parseEdgeAddonId, toArrayBuffer } from "./edgeStore";
import {
  disposeCsRuntime as disposeCsRt,
  ensureCsRuntime as ensureCsRt,
  initCsRuntime,
} from "./cs-runtime";

interface RawManifest {
  name?: string;
  version?: string;
  description?: string;
  manifest_version?: number;
  icons?: Record<string, string>;
  permissions?: string[];
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

  async installFromArchive(buffer: ArrayBuffer, fallbackName: string): Promise<ExtensionRecord> {
    const files = await extractExtensionArchive(buffer);
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
  async syncNativeOnStartup(): Promise<void> {
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
    });
    this.csRuntimeInited = true;
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
  async injectDocumentEnd(webview: { insertCSS(css: string): Promise<unknown>; executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }, url: string): Promise<void> {
    if (!this.getEnabled()) return;
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
