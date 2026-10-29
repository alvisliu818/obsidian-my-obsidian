/* eslint-disable @typescript-eslint/no-explicit-any */
import { Notice, requestUrl } from "obsidian";
import type { App, TFile } from "obsidian";
import type { BrowserSettings } from "../types";
import { DEFAULT_CLIP_TEMPLATE } from "../constants";
import { htmlToMarkdown } from "../utils/markdown";
import { formatDateKey, normalizeVaultPath, safeFilename, titleToFilename } from "../utils/url";
import { copyText } from "../utils/dom";

export interface ClipPayload {
  ok: boolean;
  title?: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  href?: string;
  html?: string;
  images?: string[];
  error?: string;
}

const MAX_IMAGES = 60;
const IMAGE_CONCURRENCY = 4;

/**
 * Web clipper: page -> Markdown -> note.
 *
 * The extraction runs INSIDE the guest (it needs the live DOM), while image
 * downloading and note creation happen on the host — a cross-origin fetch in
 * the page usually fails, and only the host can write into the vault.
 */
export async function clipPage(
  app: App,
  settings: BrowserSettings,
  runInPage: (code: string) => Promise<unknown>,
  mode: "article" | "selection",
  pageUrl: string,
): Promise<TFile | null> {
  const notice = new Notice("正在摘录…", 0);
  try {
    // Readability must run first: the collector reads window.Readability.
    // Both blobs are idempotent, so re-injecting on every clip is harmless.
    const script =
      __READABILITY_SOURCE__ +
      ";\n" +
      __CLIP_SOURCE__ +
      ";\n" +
      `window.__obsidianClipRun(${JSON.stringify({ mode, assets: settings.clipAssets })})`;
    const raw = await runInPage(script);
    const payload = parsePayload(raw);

    if (!payload.ok || !payload.html) {
      notice.setMessage("摘录失败：" + (payload.error || "页面内容为空"));
      setTimeout(() => notice.hide(), 4000);
      return null;
    }

    const title = (payload.title || payload.href || pageUrl || "未命名").trim();
    const body = await buildMarkdown(app, settings, payload, pageUrl, notice);

    const folder = normalizeVaultPath(settings.clipFolder || "Browser/Clippings");
    const filename = uniquePath(app, folder, titleToFilename(title) + ".md");
    const file = await app.vault.create(filename, body);

    if (settings.clipAlsoCopy) await copyText(body);
    notice.setMessage("已摘录：" + file.basename);
    setTimeout(() => notice.hide(), 4000);
    return file;
  } catch (e: any) {
    notice.setMessage("摘录失败：" + String(e?.message ?? e));
    setTimeout(() => notice.hide(), 6000);
    return null;
  }
}

function parsePayload(raw: unknown): ClipPayload {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ClipPayload;
    } catch {
      return { ok: false, error: "无法解析页面返回内容" };
    }
  }
  return (raw ?? { ok: false }) as ClipPayload;
}

async function buildMarkdown(
  app: App,
  settings: BrowserSettings,
  payload: ClipPayload,
  pageUrl: string,
  notice: Notice,
): Promise<string> {
  const doc = new DOMParser().parseFromString(payload.html || "", "text/html");
  const url = payload.href || pageUrl || "";

  // Code languages (clipScript leaves a hint on <pre>, Turndown reads the class).
  doc.querySelectorAll("pre").forEach((pre) => {
    const lang = pre.getAttribute("data-language");
    const code = pre.querySelector("code") ?? doc.createElement("code");
    if (lang && code && !/language-/.test(code.className)) {
      code.className = (code.className + " language-" + lang).trim();
    }
  });

  const images = (payload.images ?? []).filter((s) => /^https?:/i.test(s)).slice(0, MAX_IMAGES);
  if (settings.clipAssets && images.length) {
    notice.setMessage(`正在下载图片 0/${images.length}…`);
    const folder = normalizeVaultPath(settings.clipFolder || "Browser/Clippings") + "/assets";
    const map = await downloadImages(app, images, folder, url, (done, total) => {
      notice.setMessage(`正在下载图片 ${done}/${total}…`);
    });
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      const local = map.get(src);
      if (local) img.setAttribute("src", local);
    });
  }

  const content = htmlToMarkdown(doc.body.innerHTML);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const tags = (settings.clipTags || "")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const vars: Record<string, string> = {
    title: payload.title || titleToFilename(url),
    url,
    byline: payload.byline || "",
    siteName: payload.siteName || "",
    excerpt: payload.excerpt || "",
    date: formatDateKey(now.getTime()),
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    tags: tags.length ? tags.map((t) => `  - ${t}`).join("\n") : "  - clipping",
    content,
  };

  const template = settings.clipTemplate || DEFAULT_CLIP_TEMPLATE;
  return renderTemplate(settings.clipFrontmatter ? template : stripFrontmatter(template), vars);
}

function stripFrontmatter(template: string): string {
  const m = template.match(/^---\n[\s\S]*?\n---\n*/);
  return m ? template.slice(m[0].length) : template;
}

/** `${var}` substitution only — no expression evaluation in user templates. */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, key) => vars[key] ?? "");
}

async function downloadImages(
  app: App,
  urls: string[],
  folder: string,
  referer: string,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let done = 0;
  const queue = urls.slice();
  const workers = Array.from({ length: Math.min(IMAGE_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const src = queue.shift();
      if (!src) return;
      try {
        const name = safeFilename(decodeURIComponent(src.split("?")[0].split("/").pop() || "image")) || "image.png";
        const path = uniquePath(app, folder, name);
        const resp = await requestUrl({ url: src, headers: { Referer: referer }, throw: false });
        if (resp.status >= 400) continue;
        await app.vault.createBinary(path, resp.arrayBuffer);
        map.set(src, path);
      } catch {
        /* keep the remote URL */
      }
      onProgress(++done, urls.length);
    }
  });
  await Promise.all(workers);
  return map;
}

function uniquePath(app: App, folder: string, filename: string): string {
  const base = folder ? folder.replace(/\/+$/, "") + "/" : "";
  let candidate = base + filename;
  if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  for (let i = 1; i < 500; i++) {
    candidate = `${base}${stem} ${i}${ext}`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  return base + Date.now() + filename;
}
