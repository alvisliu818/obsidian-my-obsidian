/* eslint-disable @typescript-eslint/no-explicit-any */
import { Notice } from "obsidian";
import type { DownloadsStore } from "../storage/downloadsStore";
import { isUrlExcluded } from "../utils/url";
import { nodeRequire, sessionFromPartition, vaultBasePath } from "../utils/electron";

export interface SessionDownloadDeps {
  app: unknown;
  partition: string;
  store: DownloadsStore;
  /** Vault-relative folder for downloads. */
  getDir: () => string;
  /** Hosts that must not be intercepted. */
  getExcluded: () => string;
  onFinished?: (item: { path: string; filename: string }) => void;
}

/**
 * Route real download intents into the vault.
 *
 * Without this hook Electron pops its own save dialog and the file lands
 * wherever the user pointed it — invisible to the downloads dock. `@electron/remote`
 * is available in Obsidian's main window, so we can grab the session the
 * webviews share and own the download end to end (path, progress, state).
 */
export function bindSessionDownloads(deps: SessionDownloadDeps): () => void {
  const session = sessionFromPartition(deps.partition);
  if (!session) return () => undefined;

  const fs = nodeRequire<any>("fs");
  const pathMod = nodeRequire<any>("path");

  const handler = (_e: any, item: any, _wc: any) => {
    const url = item.getURL?.() ?? "";
    if (url && isUrlExcluded(url, deps.getExcluded())) return; // let Electron handle it

    const filename = item.getFilename?.() || "download";
    const dir = (deps.getDir() || "Browser/Downloads").replace(/^\/+|\/+$/g, "");
    const base = vaultBasePath(deps.app);
    if (!base || !fs || !pathMod) return;

    const vaultPath = dir ? `${dir}/${filename}` : filename;
    const abs = pathMod.join(base, dir, filename);
    try {
      fs.mkdirSync(pathMod.dirname(abs), { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      item.setSavePath(abs);
    } catch (e) {
      new Notice("无法设置下载路径：" + String(e));
      return;
    }

    const rec = deps.store.create({ url, filename });
    const total = item.getTotalBytes?.() ?? 0;
    if (total) deps.store.progress(rec.id, 0, total);

    item.on?.("updated", (_e2: any, state: string) => {
      const received = item.getReceivedBytes?.() ?? 0;
      deps.store.progress(rec.id, received, item.getTotalBytes?.() ?? total);
      if (state === "interrupted" || state === "cancelled") {
        deps.store.setState(rec.id, state === "cancelled" ? "canceled" : "interrupted");
      }
    });

    item.on?.("done", (_e2: any, state: string) => {
      if (state === "completed") {
        deps.store.setSavePath(rec.id, vaultPath);
        deps.store.setState(rec.id, "completed");
        deps.onFinished?.({ path: vaultPath, filename });
        new Notice(`下载完成：${filename}`);
      } else if (state === "cancelled") {
        deps.store.setState(rec.id, "canceled");
      } else {
        deps.store.setState(rec.id, "interrupted", "下载被中断");
      }
    });
  };

  session.on?.("will-download", handler);
  return () => {
    try {
      session.removeListener?.("will-download", handler);
    } catch {
      /* ignore */
    }
  };
}
