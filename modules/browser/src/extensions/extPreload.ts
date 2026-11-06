/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Preload for extension POPUP webviews.
 *
 * Same two jobs as the browser preload (report new-tab intent, install the
 * chrome shim) plus one extra: the popup is a file:// page, so the host has to
 * hand it the shim over IPC before popup.js runs. contextIsolation=no means the
 * preload shares the page's `window`, so evaluating the shim here really does
 * define window.chrome for the popup.
 */
(function () {
  // Electron 20+ 的 webview preload 默认沙箱:window.require 不存在,但沙箱
  // 垫片在 preload 作用域提供 require（含 ipcRenderer）——读 window 会整个
  // preload 早退,扩展注入全灭（2026-11-07 实测根因）。
  const req = typeof require === "function" ? require : (window as any).require;
  const ipcRenderer = req?.("electron")?.ipcRenderer;
  if (!ipcRenderer) return;

  function injectCss(css: string): void {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectJs(code: string): void {
    const script = document.createElement("script");
    script.textContent = code;
    (document.head || document.documentElement).appendChild(script);
  }

  // 1. content scripts that declared run_at=document_start
  ipcRenderer.sendToHost("ob-ext-request", location.href);
  ipcRenderer.on("ob-ext-scripts", (_e: any, payload: any) => {
    if (!payload) return;
    (payload.css || []).forEach(injectCss);
    (payload.js || []).forEach(injectJs);
  });

  // 2. the chrome.* shim for the popup page itself
  ipcRenderer.sendToHost("ob-popup-request", location.href);
  ipcRenderer.on("ob-popup-shim", (_e: any, shim: string) => {
    try {
      // Indirect eval runs in global scope, which is what a shim needs.
      (0, eval)(shim);
    } catch {
      /* popup can still render without it */
    }
  });

  try {
    (window as any).open = function (url: string) {
      if (url) ipcRenderer.sendToHost("obsidian-browser-open-new-tab", String(url));
      return null;
    };
  } catch {
    /* ignore */
  }
})();
