import type { BrowserSettings } from "../types";
import { SEARCH_ENGINES } from "../constants";

/**
 * Turn whatever the user typed into something loadable.
 *
 * Order matters: a bare `example.com` is a host, while `foo bar` is a search
 * query — and `foo:bar` is a scheme, not a search.
 */
export function normalizeUrl(input: string, settings: Pick<BrowserSettings, "searchEngine" | "customSearchUrl">): string {
  const raw = (input || "").trim();
  if (!raw) return "about:blank";

  // Already has a scheme (http://, https://, file://, obsidian://, …).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  if (/^about:/i.test(raw)) return raw;
  if (/^(data|blob|javascript|chrome-extension|view-source):/i.test(raw)) return raw;

  // Looks like a host: example.com, sub.example.com/path, localhost:3000,
  // 中文域名/中文路径(用户 2026-11-20:地址栏支持中文,不转义)——\p{L}\p{N}
  // 让 `百度百科.com` 这类输入也按主机导航而不是搜索。
  if (/^[\w\p{L}\p{N}-]+(\.[\w\p{L}\p{N}-]+)+(\/.*)?$/u.test(raw) || /^localhost(:\d+)?(\/.*)?$/i.test(raw)) {
    return "https://" + raw;
  }

  return buildSearchUrl(raw, settings);
}

/**
 * 地址栏显示用(用户 2026-11-20:地址栏支持中文,不转义):guest 返回的 URL
 * 是百分号编码形态(%E5%BE%B7%E5%9B%BD),decodeURI 还原可读中文路径,同时
 * 保留 ?&=/ 等结构字符不被误解;解码失败原样返回。
 */
export function displayUrl(url: string): string {
  const raw = url || "";
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

export function buildSearchUrl(query: string, settings: Pick<BrowserSettings, "searchEngine" | "customSearchUrl">): string {
  const engine = settings.searchEngine;
  const template =
    engine === "custom" && settings.customSearchUrl
      ? settings.customSearchUrl
      : (SEARCH_ENGINES.find((e) => e.id === engine) ?? SEARCH_ENGINES[0]).url;
  return template.replace("{q}", encodeURIComponent(query));
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function prettyUrl(url: string): string {
  return (url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const p = new URL(url);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

export function getFilenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return safeFilename(decodeURIComponent(last));
    return u.hostname;
  } catch {
    return "download";
  }
}

/** Strip the characters Windows refuses in a path component. */
export function safeFilename(name: string): string {
  return (name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "download";
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDateKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * `*.weibo.com` matches only subdomains; `weibo.com` matches itself and any
 * subdomain. Kept identical to the SiYuan plugin so rule files are portable.
 */
export function matchHost(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();
  if (!host || !pat) return false;
  if (pat.startsWith("*.")) return host.endsWith("." + pat.slice(2));
  return host === pat || host.endsWith("." + pat);
}

export function isUrlExcluded(url: string, patternsText: string): boolean {
  const host = getDomain(url);
  if (!host) return false;
  return (patternsText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .some((p) => matchHost(host, p));
}

/** Origin of the host (Obsidian) window; "" / "null" when opaque or in Node. */
function hostOrigin(): string {
  try {
    return typeof window !== "undefined" ? window.location?.origin || "" : "";
  } catch {
    return "";
  }
}

/**
 * 是否指向宿主应用自身页面（与 Obsidian 窗口同源）。
 *
 * 对齐思源 f01eaa2：开启「所有链接用插件打开」后，思源的独立设置窗口
 * `window.open(appOrigin + "/settings.html")` 被全局拦截返回 null，宿主判空
 * 抛 "Could not open the settings window"。同源页面必须交回原生逻辑。
 * Obsidian 主窗口多为 app:// / file:// 不透明源，此时恒 false；显式的
 * origin 参数供单测与未来宿主形态使用。
 */
export function isAppInternalUrl(url: string, origin?: string): boolean {
  const base = origin ?? hostOrigin();
  if (!url || !base || base === "null") return false;
  try {
    return new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * 全局链接拦截的唯一判定：http(s) 外链，且不在排除名单、不是宿主自身页面。
 * 与思源 shouldInterceptLink 等价；所有自动拦截入口都必须走这里，避免漏放行。
 */
export function shouldInterceptLink(url: string, patternsText: string, origin?: string): boolean {
  return /^https?:\/\//i.test(url) && !isUrlExcluded(url, patternsText) && !isAppInternalUrl(url, origin);
}

/** Title -> file-name: full-width slashes keep the note path intact. */
export function titleToFilename(title: string): string {
  return safeFilename((title || "untitled").replace(/[\\/]/g, "／").replace(/[[\]#^|]/g, ""));
}

export function normalizeVaultPath(p: string): string {
  let s = (p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+$/, "");
  return s.replace(/^\//, "");
}
