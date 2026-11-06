/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Runs as the <webview> `preload`: an isolated-ish script in the guest that
 * still has Node (the guest is created with contextIsolation=no), so it can
 * report new-tab intentions back to the host through ipcRenderer.sendToHost.
 *
 * The host listens on the `ipc-message` event. Pages routinely replace
 * window.open, so WebviewController also injects a fallback interceptor after
 * dom-ready — this file is the early, reliable half of that pair.
 */
(function () {
	try { document.documentElement.dataset.obPreloadRan = "1"; } catch { /* ignore */ }
  // Electron 20+ 的 webview preload 默认沙箱:window.require 不存在,但沙箱
  // 垫片在 preload 作用域提供 require（含 ipcRenderer）——读 window 会整个
  // preload 早退,扩展注入全灭（2026-11-07 实测根因）。
  const req = typeof require === "function" ? require : (window as any).require;
  const ipcRenderer = req?.("electron")?.ipcRenderer;
  if (!ipcRenderer) return;

  const NEW_TAB = "obsidian-browser-open-new-tab";

  /** Would this click/event open a new tab in a real browser? */
  function wantsNewTab(e: any, target: string | null): boolean {
    if (target === "_blank") return true;
    if (e && (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey)) return true;
    return false;
  }

  // 用户脚本 GM 垫片要用 ipcRenderer：页面主世界(nodeIntegration=false)没有
  // require,靠 contextIsolation=no 的共享 window 从 preload 递过去
  try { (window as any).__obIpc = ipcRenderer; } catch { /* ignore */ }

  try {
    (window as any).open = function (url: string) {
      if (url) ipcRenderer.sendToHost(NEW_TAB, String(url));
      return null;
    };
  } catch {
    /* page may freeze window later; the DOM interceptor covers that */
  }

  // Capture phase: we run before the page's own handlers.
  document.addEventListener(
    "click",
    (e: any) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (/^(javascript|mailto|tel|obsidian):/i.test(href)) return;
      if (!wantsNewTab(e, anchor.getAttribute("target"))) return;
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.sendToHost(NEW_TAB, anchor.href);
    },
    true,
  );

  document.addEventListener(
    "auxclick",
    (e: any) => {
      if (e.button !== 1) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      ipcRenderer.sendToHost(NEW_TAB, anchor.href);
    },
    true,
  );

  // Extension content scripts that asked for run_at=document_start: they must
  // be in place before the page's own scripts, so ask the host right away.
  ipcRenderer.sendToHost("ob-ext-request", location.href);
  ipcRenderer.on("ob-ext-scripts", (_e: any, payload: any) => {
    if (!payload) return;
    (payload.css || []).forEach((css: string) => {
      const style = document.createElement("style");
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    });
    (payload.js || []).forEach((code: string) => {
      const script = document.createElement("script");
      script.textContent = code;
      (document.head || document.documentElement).appendChild(script);
    });
  });

  // Tell the host we're alive — the link-interceptor fallback keys off this.
  (window as any).__obsidianBrowserPreload = true;
})();
