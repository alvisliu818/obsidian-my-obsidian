/* eslint-disable @typescript-eslint/no-explicit-any */
import { requestUrl } from "obsidian";
import type { App } from "obsidian";
import { getFilenameFromUrl, safeFilename } from "./url";
import { nodeRequire, vaultBasePath } from "./electron";

export interface DownloadOptions {
  /** Vault-relative folder. */
  dir: string;
  /** File name to use (otherwise inferred from the URL / headers). */
  filename?: string;
  referer?: string;
  onProgress?(received: number, total: number): void;
}

export interface DownloadResult {
  path: string;
  bytes: number;
}

/**
 * Download a remote URL into the vault.
 *
 * Node streaming is preferred (real progress, and it works for big files);
 * requestUrl is the fallback because it is the only path that survives a
 * sandboxed build without node integration.
 */
export async function downloadToVault(app: App, url: string, opts: DownloadOptions): Promise<DownloadResult> {
  const filename = safeFilename(opts.filename || getFilenameFromUrl(url));
  const path = joinVaultPath(opts.dir, filename);
  const abs = toAbsolute(app, path);

  const node = abs ? await nodeDownload(app, url, path, abs, opts) : null;
  if (node) {
    return { path, bytes: node.bytes };
  }

  // Fallback: Obsidian's requestUrl (still bypasses CORS, no progress).
  const resp = await requestUrl({
    url,
    method: "GET",
    headers: opts.referer ? { Referer: opts.referer } : undefined,
    throw: false,
  });
  const buf = resp.arrayBuffer;
  await app.vault.adapter.writeBinary(path, buf);
  return { path, bytes: buf.byteLength };
}

/** Node Buffers are views into a pooled ArrayBuffer — hand over an exact copy. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function joinVaultPath(dir: string, filename: string): string {
  const d = (dir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return d ? `${d}/${filename}` : filename;
}

function toAbsolute(app: App, vaultPath: string): string {
  const base = vaultBasePath(app);
  if (!base) return "";
  return base.replace(/[\\/]+$/, "") + "/" + vaultPath;
}

/** Stream straight onto disk, then hand the bytes to the vault API. */
async function nodeDownload(
  app: App,
  url: string,
  vaultPath: string,
  abs: string,
  opts: DownloadOptions,
): Promise<{ bytes: number } | null> {
  const http = nodeRequire<any>("http");
  const https = nodeRequire<any>("https");
  const fs = nodeRequire<any>("fs");
  const pathMod = nodeRequire<any>("path");
  if (!http || !https || !fs || !pathMod) return null;

  // writeBinary needs the bytes anyway; download to a temp file for progress,
  // then import it through the vault API so Obsidian's caches stay correct.
  const tmp = abs + ".obdownload";
  try {
    fs.mkdirSync(pathMod.dirname(abs), { recursive: true });
  } catch {
    /* ignore */
  }

  const mod = url.startsWith("https:") ? https : http;
  const headers: Record<string, string> = { "User-Agent": navigator.userAgent };
  if (opts.referer) headers.Referer = opts.referer;

  await new Promise<void>((resolve, reject) => {
    const doReq = (target: string, hops: number) => {
      if (hops > 8) {
        reject(new Error("too many redirects"));
        return;
      }
      const req = mod.get(target, { headers }, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, target).href;
          doReq(next, hops + 1);
          return;
        }
        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const total = Number(res.headers["content-length"] || 0);
        const file = fs.createWriteStream(tmp);
        let received = 0;
        res.on("data", (c: any) => {
          received += c.length;
          opts.onProgress?.(received, total);
        });
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    };
    doReq(url, 0);
  });

  const buf: Buffer = fs.readFileSync(tmp);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  // Import through the vault API (not a bare fs write) so Obsidian's caches,
  // the file explorer and any sync plugin see the new file immediately.
  await app.vault.adapter.writeBinary(vaultPath, toArrayBuffer(buf));
  return { bytes: buf.length };
}
