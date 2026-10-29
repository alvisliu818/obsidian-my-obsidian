/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Obsidian's MAIN window runs with nodeIntegration:true / contextIsolation:false
 * and (crucially) webviewTag:true, so a plugin can reach Electron directly.
 * Everything here is optional at runtime: mobile / a future sandboxed build
 * simply returns null and the callers degrade gracefully.
 */

export function nodeRequire<T = any>(name: string): T | null {
  try {
    const r = (window as any).require;
    return typeof r === "function" ? (r(name) as T) : null;
  } catch {
    return null;
  }
}

export function getElectron(): any | null {
  return nodeRequire<any>("electron");
}

export function getRemote(): any | null {
  return nodeRequire<any>("@electron/remote");
}

/** webContents of a guest <webview>, or null without remote. */
export function webContentsFromId(id: number): any | null {
  const remote = getRemote();
  if (!remote?.webContents?.fromId || typeof id !== "number") return null;
  try {
    return remote.webContents.fromId(id);
  } catch {
    return null;
  }
}

export function sessionFromPartition(name: string): any | null {
  const remote = getRemote();
  if (!remote?.session?.fromPartition) return null;
  try {
    return remote.session.fromPartition(name);
  } catch {
    return null;
  }
}

export function openExternal(url: string): boolean {
  const shell = getElectron()?.shell ?? getRemote()?.shell;
  if (shell?.openExternal) {
    try {
      shell.openExternal(url);
      return true;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank");
  return false;
}

export function showItemInFolder(absPath: string): boolean {
  const shell = getElectron()?.shell ?? getRemote()?.shell;
  if (shell?.showItemInFolder) {
    try {
      shell.showItemInFolder(absPath);
      return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

/** Absolute path of the vault on disk (desktop FileSystemAdapter only). */
export function vaultBasePath(app: any): string {
  const adapter = app?.vault?.adapter;
  const base = adapter?.basePath ?? adapter?.getBasePath?.();
  return typeof base === "string" ? base : "";
}
