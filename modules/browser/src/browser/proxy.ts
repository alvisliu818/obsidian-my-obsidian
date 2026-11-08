/**
 * 内置浏览器的网络代理(2026-11-08 用户需求)。
 *
 * Electron 的 setProxy 按 session 生效:浏览器分区各自一份,Obsidian 本体
 * (插件安装/更新、社区市场目录)走 defaultSession。off → direct(显式清掉
 * 之前的代理,与「从未设置」在 Electron 里等价)。
 */
import type { BrowserSettings } from "../types";
import { getRemote, sessionFromPartition } from "../utils/electron";

type ProxyFields = Pick<BrowserSettings, "proxyMode" | "proxyScope" | "proxyRules" | "proxyBypass">;

/** 打开过的浏览器分区(含每个 tab 可能的覆盖),代理切换时全部重放。 */
const seenPartitions = new Set<string>();

export function rememberBrowserPartition(partition: string): void {
  if (partition) seenPartitions.add(partition);
}

/** mode → Electron ProxyConfig;off = direct(显式清除,幂等)。 */
function toProxyConfig(s: ProxyFields): Record<string, unknown> {
  // 字段名是 Electron 的 proxyRules/proxyBypassRules——Chrome 语法的
  // rules/bypassList 会被静默忽略(实测:配置看似成功,流量仍 DIRECT)。
  if (s.proxyMode === "fixed" && s.proxyRules.trim()) {
    return {
      mode: "fixed_servers",
      proxyRules: s.proxyRules.trim(),
      proxyBypassRules: s.proxyBypass.trim() || undefined,
    };
  }
  if (s.proxyMode === "system") return { mode: "system" };
  return { mode: "direct" };
}

export async function applyProxyToSession(session: unknown, s: ProxyFields): Promise<boolean> {
  const ses = session as {
    setProxy?: (cfg: unknown) => Promise<void>;
    forceReloadProxyConfig?: () => Promise<void>;
  } | null;
  if (!ses?.setProxy) return false;
  try {
    await ses.setProxy(toProxyConfig(s));
    // 反复切换时代理解析器有缓存,resolveProxy 可能读到旧值;强制刷新一次
    // 让新配置立即对解析器生效(真实连接本就即时,这是让状态一致的兜底)。
    await ses.forceReloadProxyConfig?.();
    return true;
  } catch (e) {
    console.warn("[browser] setProxy failed", e);
    return false;
  }
}

export async function applyProxyForPartition(partition: string, s: ProxyFields): Promise<boolean> {
  return applyProxyToSession(sessionFromPartition(partition), s);
}

/**
 * 把当前代理设置铺到所有相关会话:默认分区 + 打开过的浏览器分区;
 * scope = 'app' 时额外覆盖 Obsidian 默认会话(插件安装/更新走它)。
 */
let defaultSessionProxied = false;

export async function applyProxyEverywhere(defaultPartition: string, s: ProxyFields): Promise<void> {
  rememberBrowserPartition(defaultPartition);
  for (const p of [defaultPartition, ...seenPartitions]) {
    await applyProxyForPartition(p, s);
  }
  const ds = getRemote()?.session?.defaultSession;
  if (s.proxyScope === "app") {
    await applyProxyToSession(ds, s);
    defaultSessionProxied = true;
  } else if (defaultSessionProxied) {
    // 曾代管默认会话,切回浏览器作用域时必须显式还原直连,否则代理残留
    // (实测:off+browser 作用域下 defaultSession 仍是 fixed 规则)。
    await applyProxyToSession(ds, { ...s, proxyMode: "off" });
    defaultSessionProxied = false;
  }
}
