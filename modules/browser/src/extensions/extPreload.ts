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
  // preload 作用域里 require 是 Electron 原生绑定（沙箱下也有受限版），但**不在
  // window 上**——webview 没有 nodeIntegration 时页面世界读 window.require 是
  // undefined，此前 extPreload 因此拿不到 ipcRenderer 直接 return，popup shim
  // 从未交付过（window.chrome 一直是 AdGuard 自带 polyfill 的空壳）。
  const nodeRequire: ((name: string) => any) | undefined = (() => {
    try {
      // @ts-ignore —— require 由 Electron 注入 preload 作用域
      if (typeof require === "function") return require;
    } catch {
      /* fallthrough */
    }
    return (window as any).require;
  })();
  const ipcRenderer = nodeRequire?.("electron")?.ipcRenderer;
  if (!ipcRenderer) return;
  // 页面世界的 shim 用它回传宿主（页面没有 window.require，见上）
  (window as any).__obHostSend = (channel: string, ...args: unknown[]) => {
    try {
      ipcRenderer.sendToHost(channel, ...args);
    } catch {
      /* guest gone */
    }
  };
  (window as any).__obExtPreloadOk = true;

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
