/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Runs as the <webview> `preload`: an isolated-ish script in the guest that
 * still has Node (the guest is created with contextIsolation=no), so it can
 * talk to the host through ipcRenderer.sendToHost.
 *
 * 1.15 全量对齐 siyuan-plugin-browser/src/preload.js（通道名 sy-* → ob-*）：
 *   - window.open 假窗口 stub（`var w=window.open(); w.location.href=url` 模式
 *     不再崩，赋值重定向到新页签；属性保持可写——站点会自己改写 window.open，
 *     锁死会让宿主 did-stop-loading 的兜底注入失效）
 *   - 链接点击规则（左键本页导航；Ctrl/Cmd/Shift/中键/_blank 开新页签）
 *   - form target=_blank 序列化为 GET 开新页签
 *   - 页面 → 宿主事件桥（白名单 CustomEvent）
 *   - 扩展页：confirm/alert/prompt 吞掉（Electron 原生对话框同步阻塞 JS 线程，
 *     CDP evaluate/Debugger 全超时）+ 错误收集（__obErrors 供宿主诊断）
 *   - 页面缩放：Ctrl+滚轮 / Ctrl+0 / Ctrl+=/- （webFrame，Chromium page zoom）
 *   - F12 转发宿主（开扩展页 DevTools）
 *   - 扩展页 localStorage 回灌通道（仅 about:blank 主帧暴露，防站点伪造）
 *   - 扩展页 chrome.storage.sync → local 代理（Electron 的 sync 一调就抛，
 *     Clip 等扩展把设置全存 sync —— 属性存在但不可用，必须无条件代理）
 *   - Edge 商店 userAgentData 补 Edge 品牌（商店页面加载时判定一次兼容性，
 *     setUserAgent 改不动 brands —— preload 是唯一时机）
 *   - document_start content scripts 通道（Obsidian 侧原有：ob-ext-request）
 */
(function () {
  // ★ 必须用 preload 作用域的 require（Electron 注入，沙箱/非沙箱都有）；
  //   不能读 window.require —— contextIsolation=no 时页面与 preload 共享 window，
  //   站点自己的模块加载器（实测 tgb.cn 的 webpack require）会骗过它，
  //   require("electron") 失败 → 拦截器静默退出 → target=_blank 点击跳系统浏览器。
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
  const webFrame = nodeRequire?.("electron")?.webFrame;

  const NEW_TAB = "obsidian-browser-open-new-tab";

  /** Would this click/event open a new tab in a real browser? */
  function wantsNewTab(e: any, target: string | null): boolean {
    if (target === "_blank") return true;
    if (e && (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey)) return true;
    return false;
  }

  // === 0a. 扩展页：吞掉原生对话框 + 收集错误 ===
  // Electron 原生 confirm/alert 同步阻塞 JS 线程（页面假死 + 弹
  // "An internal error occurred"，CDP evaluate 全超时）。preload 与页面共享
  // window（contextIsolation=no）且先于页面脚本执行 —— 主世界从这里就挂上抑制。
  if (/^chrome-extension:\/\//i.test(location.href)) {
    try {
      (window as any).__obBlockedDialogs = [];
      (window as any).__obErrors = [];
      window.confirm = function (msg: any) {
        try {
          (window as any).__obBlockedDialogs.push("confirm: " + String(msg).slice(0, 500));
        } catch {}
        return false;
      };
      window.alert = function (msg: any) {
        try {
          (window as any).__obBlockedDialogs.push("alert: " + String(msg).slice(0, 500));
        } catch {}
      };
      window.prompt = function (msg: any, dflt: any) {
        try {
          (window as any).__obBlockedDialogs.push("prompt: " + String(msg).slice(0, 500));
        } catch {}
        return dflt === undefined ? null : dflt;
      };
      self.addEventListener("error", function (e: any) {
        try {
          (window as any).__obErrors.push({
            msg: String((e && e.message) || e).slice(0, 300),
            stack: String((e && e.error && e.error.stack) || "").slice(0, 3000),
            file: e && e.filename,
            line: e && e.lineno,
            col: e && e.colno,
            ts: Date.now(),
          });
        } catch {}
      });
      self.addEventListener("unhandledrejection", function (e: any) {
        try {
          const r = e && e.reason;
          (window as any).__obErrors.push({
            msg: "unhandledrejection: " + String((r && (r.stack || r.message)) || r).slice(0, 800),
            ts: Date.now(),
          });
        } catch {}
      });
    } catch {}
  }

  // === 0b. Ctrl+滚轮 / Ctrl+0 / Ctrl+=/- 页面缩放（Chromium page zoom）===
  try {
    if (webFrame) {
      const ZOOM_MIN = 0.25;
      const ZOOM_MAX = 3;
      window.addEventListener(
        "wheel",
        (e: any) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          const cur = webFrame.getZoomFactor();
          const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
          if (Math.abs(next - cur) > 1e-6) webFrame.setZoomFactor(next);
        },
        { passive: false } as any,
      );
      window.addEventListener(
        "keydown",
        (e: any) => {
          if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
          // Ctrl+0 重置；Ctrl+= / Ctrl+- 步进缩放（对齐 Chrome 快捷键）
          if (e.key === "0" || e.code === "Digit0") {
            e.preventDefault();
            webFrame.setZoomLevel(0); // 0 = 100%
          } else if (e.key === "=" || e.key === "+") {
            e.preventDefault();
            const next = Math.min(ZOOM_MAX, webFrame.getZoomFactor() * 1.1);
            if (Math.abs(next - webFrame.getZoomFactor()) > 1e-6) webFrame.setZoomFactor(next);
          } else if (e.key === "-") {
            e.preventDefault();
            const next2 = Math.max(ZOOM_MIN, webFrame.getZoomFactor() / 1.1);
            if (Math.abs(next2 - webFrame.getZoomFactor()) > 1e-6) webFrame.setZoomFactor(next2);
          }
        },
        { passive: false } as any,
      );
      // F12 转发到宿主：开扩展 popup/options 页的 DevTools
      window.addEventListener("keydown", function (e: any) {
        if (e.key === "F12") {
          e.preventDefault();
          ipcRenderer.sendToHost("ob-open-devtools");
        }
      });
      // 扩展页 localStorage 回灌通道：模拟扩展文档跑在 about:blank（不透明源）
      // 上，localStorage 被原生拒绝 —— guest 垫片写入后经此回灌宿主持久化。
      // 仅 about:blank 主帧暴露；真实站点绝不暴露，防网页伪造扩展存储。
      try {
        if (location.protocol === "about:" && window.top === window) {
          (window as any).__obExtLsSend = function (extId: string, data: any) {
            try {
              ipcRenderer.sendToHost("ob-ext-ls-write", { extId: String(extId || ""), data });
            } catch {}
          };
        }
      } catch {}
    }
  } catch (e) {
    console.warn("[ob-browser preload] zoom init failed:", e);
  }

  const openInNewTab = function (rawUrl: string): void {
    if (!rawUrl) return;
    let absUrl: string;
    try {
      absUrl = new URL(rawUrl, location.href).href;
    } catch {
      absUrl = String(rawUrl);
    }
    if (!/^https?:\/\//i.test(absUrl)) return;
    ipcRenderer.sendToHost(NEW_TAB, absUrl);
  };

  const isHttpUrl = function (rawUrl: string): boolean {
    try {
      return /^https?:\/\//i.test(new URL(rawUrl, location.href).href);
    } catch {
      return false;
    }
  };

  // === 1. window.open：假窗口 stub ===
  // 网页常做 `var w = window.open(); w.location.href = url;`，返回 null 会崩；
  // 返回 stub，对 location 的赋值转发到新页签。
  const createFakeWindow = function (openedUrl: string) {
    const fake: any = {
      closed: false,
      name: "",
      opener: window,
      length: 0,
      focus: function () {
        return fake;
      },
      blur: function () {
        return fake;
      },
      close: function () {
        fake.closed = true;
      },
      postMessage: function () {},
      moveTo: function () {},
      resizeTo: function () {},
      setTimeout: function (fn: any, t: number) {
        return setTimeout(fn, t);
      },
      setInterval: function (fn: any, t: number) {
        return setInterval(fn, t);
      },
      clearTimeout: function (id: any) {
        clearTimeout(id);
      },
      clearInterval: function (id: any) {
        clearInterval(id);
      },
      addEventListener: function () {},
      removeEventListener: function () {},
      document: {
        write: function () {},
        writeln: function () {},
        open: function () {},
        close: function () {},
        createElement: function () {
          return { style: {}, setAttribute: function () {}, appendChild: function () {} };
        },
        getElementsByTagName: function () {
          return [];
        },
        body: { appendChild: function () {} },
        head: { appendChild: function () {} },
        readyState: "complete",
        referrer: location.href,
        domain: location.hostname,
        location: location.href,
      },
      navigator: { userAgent: navigator.userAgent },
    };
    const fakeLocation: any = {
      href: openedUrl || "",
      assign: function (u: string) {
        if (u) openInNewTab(u);
      },
      replace: function (u: string) {
        if (u) openInNewTab(u);
      },
      reload: function () {},
      toString: function () {
        return this.href;
      },
    };
    // w.location.href = url 触发新页签
    try {
      Object.defineProperty(fakeLocation, "href", {
        configurable: true,
        enumerable: true,
        get: function () {
          return openedUrl || "";
        },
        set: function (v: string) {
          openedUrl = String(v);
          openInNewTab(v);
        },
      });
    } catch {
      fakeLocation.href = openedUrl || "";
    }
    // w.location = url（整体赋值）同样触发
    try {
      Object.defineProperty(fake, "location", {
        configurable: true,
        enumerable: true,
        get: function () {
          return fakeLocation;
        },
        set: function (v: any) {
          if (typeof v === "string") {
            openInNewTab(v);
            openedUrl = v;
          }
        },
      });
    } catch {
      fake.location = fakeLocation;
    }
    return fake;
  };
  try {
    (window as any).open = function (url: string) {
      let absUrl = "";
      if (url) {
        try {
          absUrl = new URL(url, location.href).href;
        } catch {
          absUrl = String(url);
        }
        openInNewTab(url);
      }
      // 返回 stub 窗口而非 null，避免网页脚本访问 .location 等属性时崩溃。
      // 属性保持可写：页面想改就让它改（宿主的兜底注入会再夺回拦截）。
      return createFakeWindow(absUrl);
    };
  } catch {
    /* page may freeze window later; the DOM interceptor covers that */
  }

  // === 2. 链接点击拦截：行为与浏览器一致 ===
  document.addEventListener(
    "click",
    (e: any) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.href || anchor.getAttribute("href") || "";
      if (!href || !isHttpUrl(href)) return;
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

  // === 3. form target=_blank：序列化 FormData → GET 开新页签 ===
  document.addEventListener(
    "submit",
    (e: any) => {
      const form = e.target;
      if (!form || form.tagName !== "FORM") return;
      if (form.target !== "_blank") return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const formData = new FormData(form);
        const params = new URLSearchParams();
        formData.forEach(function (v, k) {
          params.append(k, String(v));
        });
        const url = new URL(form.action || location.href);
        url.search = params.toString();
        openInNewTab(url.href);
      } catch {}
    },
    true,
  );

  // === 4. 页面 → 宿主事件桥（白名单通道；注入脚本拿不到 ipcRenderer）===
  window.addEventListener("obsidian-browser-host", function (ev: any) {
    try {
      const d = ev && ev.detail;
      if (!d || typeof d.type !== "string") return;
      if (d.type === "browser-open-new-tab" && d.payload) {
        openInNewTab(typeof d.payload === "string" ? d.payload : d.payload.url);
      } else if (d.type === "browser-edge-install" && d.payload && d.payload.id) {
        ipcRenderer.sendToHost("ob-edge-install", String(d.payload.id));
      }
    } catch {}
  });

  // === 5. 扩展页：chrome.storage.sync 无条件代理到 local ===
  // Electron 的 sync 属性存在但一调就抛（依赖 Google 同步服务）；实测扩展把
  // 设置几乎全存 sync，一读整个设置页渲染中断。不能用 if (!sync) 判断 ——
  // 属性存在，判断永远不成立（源侧踩坑）。
  try {
    if (
      /^chrome-extension:\/\//i.test(location.href) &&
      typeof (window as any).chrome !== "undefined" &&
      (window as any).chrome.storage &&
      (window as any).chrome.storage.local
    ) {
      Object.defineProperty((window as any).chrome.storage, "sync", {
        configurable: true,
        get: function () {
          return (window as any).chrome.storage.local;
        },
      });
    }
  } catch {}

  // === 6. Edge 商店：补 navigator.userAgentData 的 Edge 品牌 ===
  // 商店只在页面加载时判定一次兼容性；setUserAgent 改不动 brands ——
  // preload 是唯一能赶在页面脚本前改 userAgentData 的时机。
  try {
    if (/^https?:\/\/microsoftedge\.microsoft\.com\//i.test(location.href)) {
      const edgeBrands = [
        { brand: "Not?A_Brand", version: "24" },
        { brand: "Chromium", version: "141" },
        { brand: "Microsoft Edge", version: "141" },
      ];
      const fullVersionList = [
        { brand: "Chromium", version: "141.0.0.0" },
        { brand: "Microsoft Edge", version: "141.0.0.0" },
      ];
      const uaData = {
        brands: edgeBrands,
        mobile: false,
        platform: "Windows",
        architecture: "x86",
        bitness: "64",
        getHighEntropyValues: function () {
          return Promise.resolve({
            architecture: "x86",
            bitness: "64",
            model: "",
            platformVersion: "15.0.0",
            uaFullVersion: "141.0.0.0",
            fullVersionList,
          });
        },
        toJSON: function () {
          return { brands: edgeBrands, mobile: false, platform: "Windows" };
        },
      };
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        get: function () {
          return uaData;
        },
      });
    }
  } catch {}

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
