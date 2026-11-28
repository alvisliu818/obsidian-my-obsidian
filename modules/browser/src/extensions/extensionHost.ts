/* eslint-disable @typescript-eslint/no-explicit-any */
import type { App } from "obsidian";
import { requestUrl } from "obsidian";
import type { BrowserSettings, ExtensionContentScript, ExtensionRecord } from "../types";
import { getRemote, nodeRequire, sessionFromPartition, vaultBasePath } from "../utils/electron";
import { extractExtensionArchive } from "./crx";
import { extractCrx3PublicKey, extensionIdFromPublicKey, generateManifestKey, injectManifestKey } from "./crxKey";
import { downloadEdgeCrx, fetchEdgeAddonMeta, parseEdgeAddonId } from "./edgeStore";
import { buildShimSource } from "./cs-runtime";
import {
  EVENT_MARKER_FILE,
  EVENT_MARKER_SOURCE,
  backgroundShimSource,
  needsBackgroundShim,
  stripBackgroundShim,
} from "./backgroundShim";
import { evalInServiceWorker } from "./swBridge";

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
  private scriptCache = new Map<string, string>();
  private iconCache = new Map<string, string>();

  constructor(
    private app: App,
    private getRecords: () => ExtensionRecord[],
    private getEnabled: () => boolean,
    private onChange: () => void,
    private getSettings: () => BrowserSettings,
  ) {
    this.fs = nodeRequire<any>("fs");
    this.pathMod = nodeRequire<any>("path");
  }

  /** 扩展数据根目录：设置里的库外路径优先，留空 = 库内插件数据目录。 */
  get rootDir(): string {
    if (!this.pathMod) return "";
    const custom = String(this.getSettings()?.extensionsDir || "").trim();
    if (custom) {
      const expanded = this.expandPath(custom);
      return expanded ? this.pathMod.resolve(expanded) : "";
    }
    return this.defaultRoot();
  }

  /** 库内默认根目录（可在设置里改到库外）。 */
  private defaultRoot(): string {
    const base = vaultBasePath(this.app);
    return base ? base.replace(/[\\/]+$/, "") + "/.obsidian/plugins/obsidian-browser/extensions" : "";
  }

  /** 供设置页展示/迁移使用的当前根目录。 */
  extensionsRoot(): string {
    return this.rootDir;
  }

  private expandPath(raw: string): string {
    let out = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
    const os = nodeRequire<any>("os");
    if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
      out = String(os?.homedir?.() || "") + out.slice(1);
    }
    return out;
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
  async installFromFiles(
    files: { path: string; data: Uint8Array | ArrayBuffer }[],
    opts?: { crx?: Uint8Array; edgeId?: string },
  ): Promise<ExtensionRecord> {
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
    if (opts?.edgeId) rec.edgeId = opts.edgeId;
    // CRX 原始公钥 → manifest.key：扩展 ID 从此与目录路径解绑，更新/迁移都不换 ID
    //（2026-11-28 对齐思源 1bd4ee8）。原始 CRX 留一份，迁移目录时可再次补齐。
    if (opts?.crx?.length) this.pinCrxKey(target, Buffer.from(opts.crx), dir);
    // 对齐思源：原生加载的扩展不再让 Chromium 自带 CS 副本与宿主注入竞争；
    // userScripts 类扩展保留一行空 marker 完成事件授权登记。rec.contentScripts
    // 仍来自安装时的原始 manifest，宿主注入不受影响。
    this.neutralizeManifest(target);
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
    const olds = records.filter(
      (r) => r.edgeId === id || r.dir.includes("edge-" + id) || (!!meta?.name && r.name === meta.name),
    );
    // 旧安装的 electron id 是脚本数据的落点：装完（ID 已按 CRX 公钥固定）后搬过来
    const oldNativeId = olds.find((r) => !!r.nativeId)?.nativeId || "";
    for (const old of olds) {
      try {
        this.fs.rmSync(this.pathMod.join(this.rootDir, old.dir), { recursive: true, force: true });
      } catch {
        /* 已删 */
      }
      const i = records.indexOf(old);
      if (i >= 0) records.splice(i, 1);
    }
    const rec = await this.installFromArchive(buffer as unknown as ArrayBuffer, (meta?.name || id) + " (Edge)", {
      edgeId: id,
    });
    rec.description = meta?.description || rec.description;
    this.upsert(rec);
    // ID 由 CRX 公钥派生（商店 ID）：把旧 ID 下的 storage 搬过来，暴力猴脚本才不丢
    if (oldNativeId) this.migrateExtensionStorage(oldNativeId, this.pinnedIdOf(rec.dir));
    return rec;
  }

  async installFromArchive(
    buffer: ArrayBuffer,
    fallbackName: string,
    opts?: { edgeId?: string },
  ): Promise<ExtensionRecord> {
    const files = await extractExtensionArchive(buffer);
    if (!files.some((f) => f.path === "manifest.json")) {
      throw new Error("压缩包里没有 manifest.json" + (fallbackName ? "（" + fallbackName + "）" : ""));
    }
    return this.installFromFiles(files, { crx: new Uint8Array(buffer), edgeId: opts?.edgeId });
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

  // ---------------- 扩展 ID 固化 / 目录迁移（2026-11-28 对齐思源 1bd4ee8/4bb164b） ----------------

  /** 从 CRX 提取公钥写进 manifest.key，并留一份原始 CRX 供后续迁移补齐。 */
  private pinCrxKey(dirAbs: string, crx: Buffer, dirName: string): boolean {
    try {
      const pub = extractCrx3PublicKey(crx);
      if (!pub) return false;
      const changed = injectManifestKey(this.fs, this.pathMod, dirAbs, pub.toString("base64"));
      const dl = this.pathMod.join(this.rootDir, "download");
      this.fs.mkdirSync(dl, { recursive: true });
      this.fs.writeFileSync(this.pathMod.join(dl, dirName + ".crx"), crx);
      return changed;
    } catch (e) {
      console.warn("[obsidian-browser] pinCrxKey failed:", e);
      return false;
    }
  }

  /** manifest.key 派生的扩展 ID（没有 key 返回空串）。 */
  pinnedIdOf(dirName: string): string {
    const crypto = nodeRequire<any>("crypto");
    if (!crypto || !this.available) return "";
    try {
      const m = JSON.parse(this.fs.readFileSync(this.pathMod.join(this.rootDir, dirName, "manifest.json"), "utf8"));
      if (typeof m.key !== "string" || !m.key) return "";
      return extensionIdFromPublicKey(Buffer.from(m.key, "base64"), crypto);
    } catch {
      return "";
    }
  }

  /** 把旧扩展 ID 下的 chrome.storage / IndexedDB 复制到新 ID 下。 */
  private migrateExtensionStorage(oldId: string, newId: string): boolean {
    if (!oldId || !newId || oldId === newId) return false;
    const userData = getRemote()?.app?.getPath?.("userData");
    if (!userData) return false;
    const partition = String(this.lastPartition || "persist:obsidian-browser").replace(/^persist:/, "");
    const base = this.pathMod.join(userData, "Partitions", partition);
    const pairs: Array<[string, string]> = [
      [this.pathMod.join(base, "Local Extension Settings", oldId), this.pathMod.join(base, "Local Extension Settings", newId)],
      [
        this.pathMod.join(base, "IndexedDB", `chrome-extension_${oldId}_0.indexeddb.leveldb`),
        this.pathMod.join(base, "IndexedDB", `chrome-extension_${newId}_0.indexeddb.leveldb`),
      ],
    ];
    // 空 LevelDB 也有 CURRENT/MANIFEST/LOG，但只有几百字节；按 >4KB 判"有真实数据"
    const hasData = (dir: string): boolean => {
      try {
        let total = 0;
        for (const name of this.fs.readdirSync(dir)) {
          const st = this.fs.statSync(this.pathMod.join(dir, name));
          if (st.isFile()) total += st.size;
        }
        return total > 4096;
      } catch {
        return false;
      }
    };
    let migrated = false;
    for (const [src, dst] of pairs) {
      try {
        if (!this.fs.existsSync(src)) continue;
        if (this.fs.existsSync(dst) && hasData(dst)) continue;
        this.fs.mkdirSync(this.pathMod.dirname(dst), { recursive: true });
        this.fs.rmSync(dst, { recursive: true, force: true });
        this.fs.cpSync(src, dst, { recursive: true });
        migrated = true;
      } catch (e) {
        console.warn("[obsidian-browser] migrateExtensionStorage failed:", src, "->", dst, e);
      }
    }
    return migrated;
  }

  /**
   * 卸载 session 里全部原生扩展；迁移/换 ID 前必须先卸，否则会复用旧实例。
   * 返回 dir → 卸载前的 electron id：换 ID 后要把旧 ID 的 storage 搬过去，
   * 而 nativeId 清空后这个信息就没了。
   */
  private async unloadAllNativeExtensions(): Promise<Map<string, string>> {
    const oldIds = new Map<string, string>();
    for (const rec of this.getRecords()) {
      if (rec.nativeId) oldIds.set(rec.dir, rec.nativeId);
    }
    const ses = sessionFromPartition(this.lastPartition || "persist:obsidian-browser");
    if (!ses) return oldIds;
    try {
      const all = typeof ses.getAllExtensions === "function" ? ses.getAllExtensions() : [];
      for (const x of all) {
        try {
          if (typeof ses.removeExtension === "function") ses.removeExtension(String(x?.id ?? ""));
          else if (typeof ses.unloadExtension === "function") await ses.unloadExtension(String(x?.id ?? ""));
        } catch {
          /* 已卸载 */
        }
      }
      // removeExtension 是同步返回、异步卸载：不等它真的从 session 消失就
      // loadExtension，Chromium 会复用旧实例（ID 还是路径派生的老值，实测）。
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const left = typeof ses.getAllExtensions === "function" ? ses.getAllExtensions() : [];
        if (!left.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch {
      /* 无枚举能力 */
    }
    // 给 Chromium 一点时间真正释放目录句柄（Windows 下紧接着 rename 会 EPERM）
    await new Promise((r) => setTimeout(r, 50));
    for (const rec of this.getRecords()) rec.nativeId = undefined;
    return oldIds;
  }

  /**
   * 给"还没有 key"的扩展补 manifest.key：优先用 install 时留存的原始 CRX 公钥
   * （与商店 ID 一致），没有 CRX 就生成一对 RSA 公钥（ID 只求稳定、与路径无关）。
   * 换 ID 前把旧 ID 的 storage 搬过来（暴力猴脚本/设置都藏在里面）。
   */
  private ensurePinnedIds(rootOverride?: string, oldIds?: Map<string, string>): boolean {
    const crypto = nodeRequire<any>("crypto");
    const root = rootOverride || this.rootDir;
    if (!crypto || !root) return false;
    let changed = false;
    for (const rec of this.getRecords()) {
      const dirAbs = this.pathMod.join(root, rec.dir);
      try {
        const manifestPath = this.pathMod.join(dirAbs, "manifest.json");
        if (!this.fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(this.fs.readFileSync(manifestPath, "utf8"));
        if (typeof manifest.key === "string" && manifest.key) continue;

        let key = "";
        const crxFile = this.pathMod.join(root, "download", rec.dir + ".crx");
        try {
          if (this.fs.existsSync(crxFile)) {
            const pub = extractCrx3PublicKey(this.fs.readFileSync(crxFile));
            if (pub) key = pub.toString("base64");
          }
        } catch {
          /* 坏缓存：走生成 */
        }
        if (!key) key = generateManifestKey(crypto);
        const newId = extensionIdFromPublicKey(Buffer.from(key, "base64"), crypto);
        const oldId = String(oldIds?.get(rec.dir) || rec.nativeId || "");
        if (oldId && oldId !== newId) this.migrateExtensionStorage(oldId, newId);
        if (injectManifestKey(this.fs, this.pathMod, dirAbs, key)) {
          console.log("[obsidian-browser] pinned extension ID via manifest.key:", newId, rec.name || rec.dir);
          changed = true;
        }
        rec.nativeId = undefined;
      } catch (e) {
        console.warn("[obsidian-browser] ensurePinnedIds failed for " + (rec.name || rec.dir), e);
      }
    }
    if (changed) {
      this.scriptCache.clear();
      this.iconCache.clear();
    }
    return changed;
  }

  /**
   * 把扩展数据迁移到新目录（库外 / 迁回库内）。路径会变，但每个扩展的
   * manifest.key 已按 CRX 公钥（或新生成的密钥）固定，Chromium ID 与路径无关，
   * 旧 ID 的 storage 也会搬到新 ID 下。
   */
  async migrateExtensionsDir(targetRaw: string): Promise<{ ok: boolean; error?: string; moved?: number }> {
    try {
      if (!this.available) return { ok: false, error: "扩展功能需要桌面端" };
      const oldRoot = this.rootDir;
      if (!oldRoot) return { ok: false, error: "无法确定当前扩展目录" };
      const target = String(targetRaw || "").trim();
      const newRoot = target ? this.pathMod.resolve(this.expandPath(target)) : this.defaultRoot();
      if (!newRoot) return { ok: false, error: "目标目录不可用" };
      const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (norm(oldRoot) === norm(newRoot)) return { ok: true, moved: 0 };
      if (norm(newRoot).startsWith(norm(oldRoot) + "/") || norm(oldRoot).startsWith(norm(newRoot) + "/")) {
        return { ok: false, error: "目标目录不能与当前目录互相包含" };
      }
      if (!this.fs.existsSync(oldRoot)) return { ok: true, moved: 0 };

      this.fs.mkdirSync(newRoot, { recursive: true });
      const entries = this.fs.readdirSync(oldRoot) as string[];
      const existing = new Set<string>(this.fs.readdirSync(newRoot) as string[]);
      const conflict = entries.find((name) => existing.has(name));
      if (conflict) return { ok: false, error: `目标目录已存在同名项 ${conflict}，请先清空或换一个目录` };

      // Windows 下 Chromium 会占用扩展目录文件：先全部卸载，结束后从新路径重载
      const oldIds = await this.unloadAllNativeExtensions();

      const movedPairs: Array<[string, string]> = [];
      try {
        for (const name of entries) {
          const src = this.pathMod.join(oldRoot, name);
          const dst = this.pathMod.join(newRoot, name);
          this.moveEntry(src, dst);
          movedPairs.push([src, dst]);
        }
        this.scriptCache.clear();
        this.iconCache.clear();
        // 设置尚未写入，rootDir 还是旧目录，这里显式传新目录
        this.ensurePinnedIds(newRoot, oldIds);
        // 卸载是异步的：清一次原生运行时，避免新旧 ID 两个实例同时挂在 session 里
        await this.clearNativeRuntime(this.lastPartition || "persist:obsidian-browser");
        // 重新加载留给调用方写设置后 save() 触发（此刻改设置前的 root 已被搬空）
        return { ok: true, moved: movedPairs.length };
      } catch (inner) {
        for (const [src, dst] of movedPairs.reverse()) {
          try {
            this.moveEntry(dst, src);
          } catch {
            /* 尽力回滚 */
          }
        }
        for (const rec of this.getRecords()) rec.nativeId = undefined;
        this.onChange();
        return { ok: false, error: String((inner as Error)?.message ?? inner) };
      }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }

  /** 同盘 rename；跨盘（EXDEV）退化复制 + 删除。 */
  private moveEntry(src: string, dst: string): void {
    try {
      this.fs.renameSync(src, dst);
    } catch (e) {
      const code = String((e as NodeJS.ErrnoException)?.code || "");
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw e;
      this.fs.cpSync(src, dst, { recursive: true });
      this.fs.rmSync(src, { recursive: true, force: true });
    }
  }

  // ---------------- 原生加载加固（2026-11-25 bad Mojo 三修） ----------------

  /**
   * 原生扩展清单收敛（对齐思源 neutralizeNativeContentScripts）。
   *
   * Chromium 会把 manifest 的 content_scripts 在原生 isolated world 再注入一份，
   * 与宿主自己的注入竞争（旧副本还会因无授权事件触发 bad Mojo）。这里清空普通
   * 扩展的 CS；带 userScripts 权限的扩展改为一行空 marker（<all_urls>,
   * all_frames）完成 ScriptInjectionTracker 授权登记。宿主侧记录仍来自安装时的
   * 原始 manifest，注入行为不变。备份为 manifest.orig.json，幂等。
   */
  private neutralizeManifest(dir: string): boolean {
    if (!this.available) return false;
    try {
      const manifestPath = this.pathMod.join(dir, "manifest.json");
      const manifest = JSON.parse(this.fs.readFileSync(manifestPath, "utf8"));
      const perms: string[] = Array.isArray(manifest.permissions) ? manifest.permissions : [];
      let desired: any[];
      if (perms.includes("userScripts")) {
        const markerAbs = this.pathMod.join(dir, EVENT_MARKER_FILE);
        let markerOk = false;
        try {
          markerOk = this.fs.readFileSync(markerAbs, "utf8") === EVENT_MARKER_SOURCE;
        } catch { /* 不存在 */ }
        if (!markerOk) this.fs.writeFileSync(markerAbs, EVENT_MARKER_SOURCE, "utf8");
        desired = [
          { matches: ["<all_urls>"], js: [EVENT_MARKER_FILE], run_at: "document_start", all_frames: true },
        ];
      } else {
        desired = [];
      }
      if (JSON.stringify(manifest.content_scripts ?? []) === JSON.stringify(desired)) return false;
      const origPath = this.pathMod.join(dir, "manifest.orig.json");
      if (!this.fs.existsSync(origPath)) {
        this.fs.writeFileSync(origPath, JSON.stringify(manifest, null, 2), "utf8");
      }
      manifest.content_scripts = desired;
      this.fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      return true;
    } catch (e) {
      console.warn("[obsidian-browser] neutralizeManifest failed:", e);
      return false;
    }
  }

  /**
   * 启动/启用扩展前的前置准备：清单收敛 + SW 垫片落盘（幂等，内容哈希换版）。
   * 有变更时卸掉会话里的原生扩展并清 SW 缓存，让 Chromium 重新从磁盘注册，
   * 否则会继续执行旧的 service worker 脚本。
   */
  async prepareNativeExtensions(partition: string, autoFixScriptMatch: boolean): Promise<boolean> {
    if (!this.available) return false;
    const shim = backgroundShimSource(autoFixScriptMatch);
    const markLine = shim.slice(0, shim.indexOf("\n"));
    let changed = false;
    for (const rec of this.getRecords()) {
      if (!rec.enabled) continue;
      const dir = this.dirOf(rec);
      try {
        if (this.neutralizeManifest(dir)) changed = true;
        const manifest = JSON.parse(this.fs.readFileSync(this.pathMod.join(dir, "manifest.json"), "utf8"));
        const sw = manifest.background?.service_worker;
        if (!sw) continue;
        const abs = this.pathMod.join(dir, String(sw).replace(/^\/+/, ""));
        const src = this.fs.readFileSync(abs, "utf8");
        if (!needsBackgroundShim(src) || src.startsWith(markLine)) continue;
        this.fs.writeFileSync(abs, shim + stripBackgroundShim(src), "utf8");
        changed = true;
      } catch (e) {
        console.warn("[obsidian-browser] prepareNativeExtensions failed for " + rec.name, e);
      }
    }
    if (changed) await this.clearNativeRuntime(partition);
    return changed;
  }

  private async clearNativeRuntime(partition: string): Promise<void> {
    const ses = sessionFromPartition(partition);
    if (ses) {
      try {
        const all = typeof ses.getAllExtensions === "function" ? ses.getAllExtensions() : [];
        for (const x of all) {
          try {
            if (typeof ses.removeExtension === "function") ses.removeExtension(String(x?.id ?? ""));
            else if (typeof ses.unloadExtension === "function") ses.unloadExtension(String(x?.id ?? ""));
          } catch { /* 已卸载 */ }
        }
      } catch { /* 无枚举能力 */ }
      try {
        await ses.clearStorageData?.({ storages: ["serviceworkers"] });
      } catch { /* 无权限 */ }
    }
    // nativeId 是会话级字段：卸掉后必须一起清掉，否则 sync 不会重新装载。
    for (const rec of this.getRecords()) rec.nativeId = undefined;
  }

  /** 从各扩展 SW 取回垫片记录的非法 @match 修复 id（带扩展 id 前缀，宿主去重提醒）。 */
  async collectMatchFixLogs(): Promise<string[]> {
    const out: string[] = [];
    for (const rec of this.getRecords()) {
      if (!rec.enabled || !rec.nativeId) continue;
      try {
        const r = await evalInServiceWorker(rec.nativeId, "JSON.stringify(self.__obUsFixLog || [])");
        if (!r.ok || typeof r.value !== "string") continue;
        const ids: unknown = JSON.parse(r.value);
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === "string") out.push(rec.nativeId + ":" + id);
        }
      } catch { /* 提醒失败不影响注入 */ }
    }
    return out;
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
          // DOMContentLoaded 补发：只在脚本执行窗口内捕获回调，绝不派发到共享 DOM
          // （思源 2026-11-25 知乎白屏根因；详见 cs-runtime.ts buildShimSource）。
          const code =
            this.shimFor(rec) +
            "\ntry{window.__obBeginDomReadyCapture&&window.__obBeginDomReadyCapture();\n" +
            js.join(";\n") +
            "\n}finally{window.__obEndDomReadyCapture&&window.__obEndDomReadyCapture();}";
          void webview.executeJavaScript(code, false).catch(() => undefined);
        }
      }
    }
    // 所有晚注入脚本执行完后再补发；早注入的监听器由原生 DOMContentLoaded 触发，不重复。
    void webview
      .executeJavaScript("window.__obFireDomReady&&window.__obFireDomReady()", false)
      .catch(() => undefined);
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
