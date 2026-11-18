/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 会话级网络钩子：DNR 广告拦截 + Edge 商店 UA 伪造。
 *
 * 模式对齐 downloads.ts：每个打开过的浏览器分区挂一次钩子，返回拆钩闭包；
 * 设置变更时全部重放（幂等——先 removeListener 再挂）。
 */
import { getRemote, sessionFromPartition } from "../utils/electron";
import { rememberBrowserPartition } from "./proxy";
import { dnrBlocker } from "./dnrEngine";
import { EDGE_UA } from "../extensions/edgeStore";
import { isEdgeAddonsSiteUrl } from "../extensions/edgeStoreHelper";

interface SessionWebRequest {
  onBeforeRequest(filter: { urls?: string[] }, cb: (details: any, callback: (r: { cancel?: boolean }) => void) => void): void;
  onBeforeSendHeaders(
    filter: { urls?: string[] },
    cb: (details: any, callback: (r: { requestHeaders?: Record<string, string> }) => void) => void,
  ): void;
}

/** 打开过的浏览器分区（BrowserTab 创建 webview 时注册；proxy 同源集合）。 */
const seenPartitions = new Set<string>();
const unbinds: Array<() => void> = [];
let edgeUaBound = false;

export function rememberPartitionForFilters(partition: string): void {
  if (!partition) return;
  seenPartitions.add(partition);
  if (unbinds.length) void 0;
}

function sessionWebRequest(partition: string): { ses: any; wr: SessionWebRequest | null } | null {
  const ses = sessionFromPartition(partition);
  const wr = (ses?.webRequest ?? null) as SessionWebRequest | null;
  if (!ses || !wr?.onBeforeRequest) return null;
  return { ses, wr };
}

/** DNR 拦截钩子：每个分区一份，判定走 dnrBlocker.shouldBlock。 */
function bindDnrForPartition(partition: string, logLabel: string): () => void {
  const entry = sessionWebRequest(partition);
  if (!entry) return () => {};
  const handler = (details: any, callback: (r: { cancel?: boolean }) => void): void => {
    try {
      const blocked = dnrBlocker.shouldBlock(
        String(details?.url ?? ""),
        String(details?.resourceType ?? ""),
        String(details?.referrer ?? details?.originUrl ?? details?.documentUrl ?? ""),
      );
      callback({ cancel: blocked });
    } catch {
      callback({});
    }
  };
  try {
    entry.wr!.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, handler);
  } catch (e) {
    console.warn(`[obsidian-browser] DNR bind failed (${logLabel})`, e);
    return () => {};
  }
  return () => {
    try {
      // Electron 没有按引用摘除的 API——重挂时靠换新 session 分区兜底；
      // 实际使用里设置变更走 rebind（整个分区集合重建），此处尽力而为。
    } catch {
      /* ignore */
    }
  };
}

/** Edge 商店 UA 伪造：商店页会 UA 嗅探（非 Edge 禁用「获取」按钮）。 */
function bindEdgeUaForPartition(partition: string): () => void {
  const entry = sessionWebRequest(partition);
  if (!entry?.wr?.onBeforeSendHeaders) return () => {};
  const handler = (details: any, callback: (r: { requestHeaders?: Record<string, string> }) => void): void => {
    try {
      const url = String(details?.url ?? "");
      if (isEdgeAddonsSiteUrl(url) || /edge\.microsoft\.com/i.test(url)) {
        const headers = { ...(details?.requestHeaders ?? {}), "User-Agent": EDGE_UA };
        callback({ requestHeaders: headers });
        return;
      }
      callback({ requestHeaders: details?.requestHeaders ?? {} });
    } catch {
      callback({});
    }
  };
  try {
    entry.wr.onBeforeSendHeaders({ urls: ["http://*/*", "https://*/*"] }, handler);
  } catch (e) {
    console.warn("[obsidian-browser] Edge UA bind failed", e);
    return () => {};
  }
  return () => {};
}

/**
 * 全量重放：DNR（按设置开关 + AdGuard 在装）+ Edge UA（一次性）。
 * 幂等：全部拆旧再挂新。
 */
export function applyNetFilters(opts: {
  defaultPartition: string;
  dnrEnabled: boolean;
  adguardExtDir: string | null;
}): void {
  rememberBrowserPartition(opts.defaultPartition);
  rememberPartitionForFilters(opts.defaultPartition);
  // 拆旧：闭包列表全部执行（DNR 的拆钩是尽力而为——Electron webRequest
  // 没有按引用移除 API，重挂同 filter 会覆盖前一份 handler，语义仍是新规则）
  for (const u of unbinds.splice(0)) {
    try {
      u();
    } catch {
      /* ignore */
    }
  }
  // DNR：规则集惰性加载（AdGuard 目录存在才 load）
  if (opts.dnrEnabled && opts.adguardExtDir) {
    void dnrBlocker.load(opts.adguardExtDir);
    for (const p of seenPartitions) {
      unbinds.push(bindDnrForPartition(p, p));
    }
  }
  // Edge UA：一次绑定即可（分区集合稳定后不再变化）
  if (!edgeUaBound) {
    for (const p of seenPartitions) {
      unbinds.push(bindEdgeUaForPartition(p));
    }
    const ds = getRemote()?.session?.defaultSession;
    if (ds?.webRequest?.onBeforeSendHeaders) {
      try {
        ds.webRequest.onBeforeSendHeaders({ urls: ["http://*/*", "https://*/*"] }, (details: any, callback: (r: { requestHeaders?: Record<string, string> }) => void) => {
          try {
            const url = String(details?.url ?? "");
            if (isEdgeAddonsSiteUrl(url) || /edge\.microsoft\.com/i.test(url)) {
              callback({ requestHeaders: { ...(details?.requestHeaders ?? {}), "User-Agent": EDGE_UA } });
              return;
            }
            callback({ requestHeaders: details?.requestHeaders ?? {} });
          } catch {
            callback({});
          }
        });
      } catch {
        /* ignore */
      }
    }
    edgeUaBound = true;
  }
}
