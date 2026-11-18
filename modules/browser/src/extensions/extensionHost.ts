/* eslint-disable @typescript-eslint/no-explicit-any */
import type { App } from "obsidian";
import { requestUrl } from "obsidian";
import type { ExtensionContentScript, ExtensionRecord } from "../types";
import { nodeRequire, sessionFromPartition, vaultBasePath } from "../utils/electron";
import { extractExtensionArchive } from "./crx";
import { downloadEdgeCrx, fetchEdgeAddonMeta, parseEdgeAddonId } from "./edgeStore";
import { buildShimSource } from "./cs-runtime";

interface RawManifest {
  name?: string;
  version?: string;
  description?: string;
  manifest_version?: number;
  icons?: Record<string, string>;
  permissions?: string[];
  content_scripts?: RawContentScript[];
  chrome_url_overrides?: { newtab?: string };
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

  /** 扩展根目录（Edge 下载/规则集发现用）。 */
  dirOf(rec: ExtensionRecord): string {
    return this.pathMod.join(this.rootDir, rec.dir);
  }

  /** 带 newtab override 的已装扩展（P4 新标签页扩展候选）。 */
  newtabExtensions(): { id: string; name: string; page: string }[] {
    const strip = (s: string): string => s.replace(/^[\\/]+/, "");
    return this.getRecords()
      .filter((r) => r.enabled && r.newtab)
      .map((r) => ({ id: r.id, name: r.name, page: "chrome-extension://" + r.id + "/" + strip(String(r.newtab)) }));
  }

  /** Edge 加载项安装：商店链接/裸 id → 元数据 → CRX 下载 → 安装（按 edge id 去重旧记录）。 */
  async installFromEdgeAddons(idOrUrl: string): Promise<ExtensionRecord> {
    const id = parseEdgeAddonId(idOrUrl);
    if (!id) throw new Error("无法从输入解析 Edge 扩展 id");
    const meta = await fetchEdgeAddonMeta(id);
    const buffer = await downloadEdgeCrx(id);
    // 旧的同源安装先摘掉（SiYuan 同款：dir 含 edge-<id> 的记录）
    const records = this.getRecords();
    for (const old of records.filter((r) => r.dir.includes("edge-" + id))) {
      try {
        this.fs.rmSync(this.pathMod.join(this.rootDir, old.dir), { recursive: true, force: true });
      } catch { /* 已删 */ }
      const i = records.indexOf(old);
      if (i >= 0) records.splice(i, 1);
    }
    const rec = await this.installFromArchive(buffer as unknown as ArrayBuffer, (meta?.name || id) + " (Edge)");
    rec.description = meta?.description || rec.description;
    this.upsert(rec);
    return rec;
  }

  async installFromArchive(buffer: ArrayBuffer, fallbackName: string): Promise<ExtensionRecord> {
    const files = await extractExtensionArchive(buffer);
    if (!files.some((f) => f.path === "manifest.json")) {
      throw new Error("压缩包里没有 manifest.json" + (fallbackName ? "（" + fallbackName + "）" : ""));
    }
    return this.installFromFiles(files);
  }

  async installFromUrl(url: string): Promise<ExtensionRecord> {
    if (parseEdgeAddonId(url)) return this.installFromEdgeAddons(url);
    const resp = await requestUrl({ url, throw: false });
    if (resp.status >= 400) throw new Error("下载失败：HTTP " + resp.status);
    return this.installFromArchive(resp.arrayBuffer, url);
  }

  remove(id: string): void {
    const rec = this.getRecords().find((r) => r.id === id);
    if (rec) {
      this.unloadNative(rec);
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
    if (!enabled) this.unloadNative(rec);
    this.onChange();
  }

  // ---------------- 原生加载（P7，思源「原生/垫片」双模对齐） ----------------

  /**
   * 用 Electron 原生 session.loadExtension 把扩展装载进浏览器分区。
   *
   * 只有原生模式才运行 manifest background / MV3 service worker——TM/VM 的
   * 协作安装链（ParseScript、userScripts 注册）全发生在 SW 里，没有原生加载
   * 这些扩展就是空壳。Obsidian 的 webRequest 面对原生扩展不提供桥接
   * （声明式能力受限），但 SW 自身能跑：VM/TM 的安装确认页、脚本管理、
   * chrome.userScripts 注册都能工作。失败（版本不支持/目录无效）→ 垫片模式
   * 兜底，绝不抛出阻塞安装。
   */
  async loadNative(rec: ExtensionRecord, partition: string): Promise<boolean> {
    try {
      const ses = sessionFromPartition(partition);
      if (!ses?.loadExtension || !this.available) return false;
      if (rec.nativeId) return true; // 已加载
      const info = await ses.loadExtension(this.pathMod.join(this.rootDir, rec.dir), {
        allowFileAccess: false,
      });
      rec.nativeId = String(info?.id ?? "");
      this.onChange();
      return true;
    } catch (e) {
      console.warn("[obsidian-browser] native loadExtension failed for " + rec.name, e);
      return false;
    }
  }

  unloadNative(rec: ExtensionRecord): void {
    if (!rec.nativeId) return;
    try {
      const ses = sessionFromPartition(this.lastPartition ?? "persist:obsidian-browser");
      ses?.removeExtension?.(rec.nativeId);
    } catch {
      /* 已卸载 */
    }
    rec.nativeId = undefined;
    this.onChange();
  }

  /** 扩展 id 的 electron 侧原生 id（SW eval 按 URL 匹配找 worker 用）。 */
  electronIdOf(rec: ExtensionRecord): string {
    return rec.nativeId || rec.id;
  }

  get lastPartition(): string {
    return this._lastPartition;
  }
  set lastPartition(p: string) {
    this._lastPartition = p;
  }
  private _lastPartition = "persist:obsidian-browser";

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
      newtab: m.chrome_url_overrides?.newtab || "",
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
