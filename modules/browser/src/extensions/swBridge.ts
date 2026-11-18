/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 扩展 Service Worker 的 eval 通道（思源 sw-bridge 的 flat-session 子集）。
 *
 * Electron 不执行扩展 SW（背景页也不跑），但 SW 目标进程真实存在——经宿主
 * webContents.debugger 的 CDP flat session 可以 attach 上去 evaluate。这是
 * TM/VM 协作安装的基础：ParseScript、chrome.storage 重复检测、userScripts
 * 注册都发生在 SW 上下文里。
 *
 * 思源版还有 HTTP CDP（127.0.0.1/json/list）备用传输——Obsidian 默认不开
 * 调试端口，只保留 flat session；SW 重启会换 targetId，按 electronId 重找。
 * Electron debugger API：wc.debugger.attach()/sendCommand(method, params, sessionId?)，
 * flatten 会话通过 attachToTarget 返回的 sessionId 传入后续 sendCommand。
 */

let debuggerHost: any | null = null;
let sessionsInvalid = false;

/** 任一可用作 debugger 载体的 page webContents（能看到整棵 CDP 目标树）。 */
async function pickDebuggerHost(): Promise<any | null> {
  if (debuggerHost && !debuggerHost.isDestroyed?.()) return debuggerHost;
  try {
    const remote = (window as any).require?.("@electron/remote");
    const wc = remote?.webContents;
    if (!wc?.getAllWebContents) return null;
    const all = wc.getAllWebContents() as any[];
    const pages = all.filter((c) => !c.isDestroyed?.() && String(c.getType?.() ?? "") === "page");
    // 优先主窗口（第一个 page target）
    debuggerHost = pages[0] ?? null;
    return debuggerHost;
  } catch {
    return null;
  }
}

async function ensureAttached(host: any): Promise<boolean> {
  try {
    if (!host.debugger.isAttached?.()) host.debugger.attach();
    return true;
  } catch (e) {
    console.warn("[obsidian-browser] debugger attach failed:", e);
    return false;
  }
}

/**
 * 在指定扩展 id 的 Service Worker 里 evaluate 一个表达式。
 * 返回 { ok, value?, err? }；SW 不可达/无 debugger 权限 → { ok: false }。
 */
export async function evalInServiceWorker(
  electronId: string,
  expression: string,
): Promise<{ ok: boolean; value?: unknown; err?: string }> {
  const host = await pickDebuggerHost();
  if (!host) return { ok: false, err: "no debugger host" };
  if (sessionsInvalid) return { ok: false, err: "sw sessions invalid" };
  if (!(await ensureAttached(host))) return { ok: false, err: "debugger attach failed" };
  try {
    const targets = await host.debugger.sendCommand("Target.getTargets", {});
    const infos: any[] = (targets?.targetInfos ?? []).filter(
      (t: any) => t.type === "service_worker" && String(t.url).includes(electronId),
    );
    if (!infos.length) return { ok: false, err: "sw target not found for " + electronId };
    // 多 worker（VM 常见孤儿 worker）：评分选 active 的那个
    let best: { tid: string; sid?: string; score: number } | null = null;
    for (const t of infos) {
      try {
        const attached = await host.debugger.sendCommand("Target.attachToTarget", {
          targetId: t.targetId,
          flatten: true,
        });
        const sid = String(attached?.sessionId ?? "");
        let score = 0;
        try {
          const probe = await host.debugger.sendCommand(
            "Runtime.evaluate",
            { expression: "registration.active && registration.active.state === 'activated' ? 2 : 0", returnByValue: true },
            sid,
          );
          score += Number(probe?.result?.value ?? 0);
        } catch {
          continue;
        }
        if (!best || score > best.score) best = { tid: t.targetId, sid, score };
      } catch {
        continue;
      }
    }
    if (!best) return { ok: false, err: "no attachable sw" };
    const r = await host.debugger.sendCommand(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      best.sid,
    );
    if (r?.exceptionDetails) {
      return { ok: false, err: String(r.exceptionDetails?.exception?.description ?? "sw exception") };
    }
    return { ok: true, value: r?.result?.value };
  } catch (e: any) {
    sessionsInvalid = true;
    return { ok: false, err: String(e?.message ?? e) };
  }
}

/** 扩展的 chrome.storage.local 全量键值（重复检测用）。 */
export async function getExtensionStorage(
  electronId: string,
): Promise<Record<string, unknown> | null> {
  const r = await evalInServiceWorker(
    electronId,
    "new Promise((res) => chrome.storage.local.get(null, (v) => res(v || {})))",
  );
  if (!r.ok) return null;
  return (r.value as Record<string, unknown>) ?? null;
}

/** 测试钩子：清掉缓存的宿主（页面 reload 后旧 webContents 失效）。 */
export function resetSwBridgeForTest(): void {
  debuggerHost = null;
  sessionsInvalid = false;
}
