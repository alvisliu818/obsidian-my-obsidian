/* eslint-disable @typescript-eslint/no-explicit-any */
import { NEW_TAB_DEDUP_WINDOW } from "../constants";
import type { BrowserSettings, IWebviewTag, WebViewContextMenuParams } from "../types";
import { webContentsFromId } from "../utils/electron";
import { escapeHtml } from "../utils/dom";

export interface WebviewCallbacks {
  onUrlChange?(url: string): void;
  onTitleChange?(title: string): void;
  onLoadingChange?(loading: boolean): void;
  onFaviconChange?(dataUrl: string): void;
  onOpenNewTab?(url: string): void;
  onContextMenu?(params: WebViewContextMenuParams): void;
  /** The preload asks (at document_start) for extension content scripts. */
  onExtensionRequest?(url: string): { css: string[]; js: string[] };
  /**
   * Edge Add-ons store page: the injected helper (edgeStoreHelper) hands back the
   * extension id when the user clicks its "install" button.
   */
  onEdgeInstall?(id: string): void;
  onFindResult?(active: number, matches: number): void;
  /** Injection point for ad-filter CSS and content scripts. */
  onDomReady?(webview: IWebviewTag, url: string): void;
  onSaveAs?(url: string): void;
}

export function createWebview(partition: string, preloadUrl: string, userAgent: string): IWebviewTag {
  const wv = document.createElement("webview") as unknown as IWebviewTag;
  wv.setAttribute("partition", partition);
  // contextIsolation=no is what lets the preload reach `require('electron')`.
  // webSecurity stays ON: disabling it breaks site CSS/CSP in ugly ways.
  wv.setAttribute("webpreferences", "contextIsolation=no,nodeIntegrationInSubFrames=yes");
  wv.setAttribute("allowpopups", "");
  if (preloadUrl) wv.setAttribute("preload", preloadUrl);
  if (userAgent) wv.setAttribute("useragent", userAgent);
  wv.setAttribute("src", "about:blank");
  wv.style.cssText = "width:100%;height:100%;border:0;flex:1 1 auto;display:flex;";
  return wv;
}

/**
 * Owns one <webview>: event routing, navigation, find-in-page. It never touches
 * the surrounding DOM — the tab owns that and reacts through the callbacks.
 */
export class WebviewController {
  private listeners: { type: string; fn: (e: any) => void }[] = [];
  /** Set while WE call loadURL, so will-navigate doesn't fight our own nav. */
  private programmaticNav = false;
  private lastNewTabUrl = "";
  private lastNewTabTime = 0;
  private lastKnownUrl = "";
  private loading = false;
  private hasLoadedOnce = false;
  private faviconEverSet = false;
  private appliedUserAgent = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    public webview: IWebviewTag,
    private getSettings: () => BrowserSettings,
    private callbacks: WebviewCallbacks,
  ) {
    this.attach();
  }

  private on(type: string, fn: (e: any) => void): void {
    this.webview.addEventListener(type, fn as EventListener);
    this.listeners.push({ type, fn });
  }

  private detach(): void {
    for (const l of this.listeners) this.webview.removeEventListener(l.type, l.fn as EventListener);
    this.listeners = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private attach(): void {
    this.on("did-start-loading", () => {
      this.loading = true;
      this.faviconEverSet = false;
      this.callbacks.onLoadingChange?.(true);
    });

    this.on("did-stop-loading", () => {
      this.loading = false;
      this.hasLoadedOnce = true;
      this.callbacks.onLoadingChange?.(false);
      void this.injectLinkInterceptor();
      if (!this.faviconEverSet) void this.tryFallbackFavicon();
    });

    this.on("did-navigate", (e: any) => {
      this.programmaticNav = false;
      if (e?.url && !/^data:/i.test(e.url)) this.lastKnownUrl = e.url;
      this.callbacks.onUrlChange?.(e?.url ?? "");
    });

    // SPAs never fire did-navigate for hash/anchor routing.
    this.on("did-navigate-in-page", (e: any) => {
      this.programmaticNav = false;
      if (e?.url && !/^data:/i.test(e.url)) this.lastKnownUrl = e.url;
      this.callbacks.onUrlChange?.(e?.url ?? "");
    });

    this.on("dom-ready", () => {
      this.syncUserAgent(this.getCurrentUrl());
      void this.injectLinkInterceptor();
      const url = this.getCurrentUrl();
      if (/^(https?:|chrome-extension:)/i.test(url)) this.callbacks.onDomReady?.(this.webview, url);
    });

    this.on("page-title-updated", (e: any) => {
      this.callbacks.onTitleChange?.(e?.title ?? "");
    });

    this.on("page-favicon-updated", (e: any) => {
      const favicons: string[] = e?.favicons ?? [];
      const pick = favicons.find((f) => /\.(png|ico|jpe?g|webp|svg)/i.test(f)) ?? favicons[0];
      if (!pick) return;
      void this.loadFaviconAsDataUrl(pick).then((dataUrl) => {
        if (dataUrl) {
          this.faviconEverSet = true;
          this.callbacks.onFaviconChange?.(dataUrl);
        }
      });
    });

    // Preload reports new-tab intent here.
    this.on("ipc-message", (e: any) => {
      if (e?.channel === "obsidian-browser-open-new-tab" && e.args?.[0]) {
        this.openNewTab(String(e.args[0]), true);
        return;
      }
      // document_start content scripts: the preload asks, we answer over IPC.
      if (e?.channel === "ob-ext-request") {
        const payload = this.callbacks.onExtensionRequest?.(String(e.args?.[0] ?? this.getCurrentUrl()));
        try {
          this.webview.send("ob-ext-scripts", payload ?? { css: [], js: [] });
        } catch {
          /* guest gone */
        }
        return;
      }
      // Edge 商店页助手回传的扩展 id（见 edgeStoreHelper 的 sendInstall）
      if (e?.channel === "ob-edge-install" && e.args?.[0]) {
        this.callbacks.onEdgeInstall?.(String(e.args[0]));
      }
    });

    this.on("will-navigate", (e: any) => {
      if (this.programmaticNav) return;
      const url = e?.url ?? "";
      // Suppress the duplicate that arrives right after we already opened a tab.
      if (url && url === this.lastNewTabUrl && Date.now() - this.lastNewTabTime < NEW_TAB_DEDUP_WINDOW) {
        try {
          (e as any).preventDefault?.();
        } catch {
          /* not preventable */
        }
      }
    });

    this.on("new-window", (e: any) => {
      // Legacy Electron (<22). Prevent and re-route.
      try {
        e.preventDefault?.();
      } catch {
        /* ignore */
      }
      if (e?.url) this.openNewTab(String(e.url), true);
    });

    this.on("did-create-window", (e: any) => {
      // Modern Electron: we cannot veto it, so close the stray window.
      try {
        (e as any).window?.close?.();
      } catch {
        /* ignore */
      }
      if (e?.url) this.openNewTab(String(e.url), true);
    });

    this.on("did-fail-load", (e: any) => {
      const code = e?.errorCode ?? 0;
      // -3 = aborted (redirect/user stop): not a real failure.
      if (code === -3) return;
      this.loading = false;
      this.hasLoadedOnce = true;
      this.callbacks.onLoadingChange?.(false);
      if (e?.isMainFrame !== false && code) this.showLoadFailedPage(e.validatedURL || this.lastKnownUrl, code);
    });

    this.on("found-in-page", (e: any) => {
      const r = e?.result;
      if (!r) return;
      // Only report the settled state; intermediate updates just flicker.
      if (r.finalUpdate === false) return;
      this.callbacks.onFindResult?.(r.activeMatchOrdinal ?? 0, r.matches ?? 0);
    });

    this.on("context-menu", (e: any) => {
      const p = e?.params ?? {};
      const params: WebViewContextMenuParams = {
        x: p.x ?? 0,
        y: p.y ?? 0,
        linkURL: p.linkURL,
        linkText: p.linkText,
        srcURL: p.srcURL,
        pageURL: this.getCurrentUrl(),
        selectionText: p.selectionText,
        mediaType: p.mediaType,
        isEditable: !!p.isEditable,
        hasImageContents: !!p.hasImageContents,
      };
      this.callbacks.onContextMenu?.(params);
    });
  }

  /** Re-point this controller at a fresh webview (after a rebuild). */
  reattach(webview: IWebviewTag): void {
    this.detach();
    this.webview = webview;
    this.programmaticNav = false;
    this.lastNewTabUrl = "";
    this.lastNewTabTime = 0;
    this.loading = false;
    this.hasLoadedOnce = false;
    this.faviconEverSet = false;
    this.appliedUserAgent = "";
    this.disposed = false;
    this.attach();
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  get isLoading(): boolean {
    return this.loading;
  }

  get hasCompletedInitialLoad(): boolean {
    return this.hasLoadedOnce;
  }

  getCurrentUrl(): string {
    let url = "";
    try {
      url = this.webview.getURL?.() ?? "";
    } catch {
      url = "";
    }
    if (!url || url === "about:blank") return this.lastKnownUrl;
    return url;
  }

  async loadURL(rawUrl: string): Promise<void> {
    let url = rawUrl;
    this.programmaticNav = true;

    // <webview> cannot render view-source:; fetch in the host and show text.
    if (/^view-source:/i.test(url)) {
      const target = url.replace(/^view-source:/i, "");
      await this.renderSource(target);
      return;
    }
    if (url === "about:blank") {
      this.webview.setAttribute("src", "about:blank");
      this.lastKnownUrl = "";
      return;
    }

    const ua = this.getSettings().userAgent;
    try {
      // Throws if the guest has not reached dom-ready yet — fall back to src.
      await this.webview.loadURL(url, ua ? { userAgent: ua } : undefined);
      this.lastKnownUrl = url;
    } catch {
      this.webview.setAttribute("src", url);
      this.lastKnownUrl = url;
      this.callbacks.onUrlChange?.(url);
    }
  }

  private async renderSource(target: string): Promise<void> {
    let text = "";
    let note = "";
    try {
      const resp = await fetch(target, { credentials: "include" });
      text = await resp.text();
    } catch (e) {
      note = String((e as Error)?.message ?? e);
      text = "";
    }
    const html =
      `<!doctype html><meta charset="utf-8"><title>view-source ${escapeHtml(target)}</title>` +
      `<body style="margin:0;background:#fff;color:#222;font:12px/1.5 monospace;white-space:pre-wrap;padding:12px">` +
      (note ? `<p style="color:#c00">failed to fetch: ${escapeHtml(note)}</p>` : "") +
      escapeHtml(text) +
      `</body>`;
    try {
      await this.webview.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    } catch {
      this.webview.setAttribute("src", "data:text/html;charset=utf-8," + encodeURIComponent(html));
    }
    this.lastKnownUrl = "view-source:" + target;
    this.callbacks.onUrlChange?.("view-source:" + target);
  }

  private showLoadFailedPage(url: string, code: number): void {
    const html =
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(url || "about:blank")}</title>` +
      `<body style="margin:0;padding:24px;background:#fff;color:#333;font:14px/1.6 -apple-system,Segoe UI,sans-serif">` +
      `<h2 style="font-weight:600;font-size:16px">无法打开页面</h2>` +
      `<p style="word-break:break-all">${escapeHtml(url || "")}</p>` +
      `<p style="color:#888">错误代码 ${code}</p>` +
      `</body>`;
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    try {
      void this.webview.loadURL(dataUrl);
    } catch {
      this.webview.setAttribute("src", dataUrl);
    }
  }

  private openNewTab(url: string, dedup: boolean): void {
    if (!url) return;
    const now = Date.now();
    if (dedup && url === this.lastNewTabUrl && now - this.lastNewTabTime < NEW_TAB_DEDUP_WINDOW) return;
    this.lastNewTabUrl = url;
    this.lastNewTabTime = now;
    this.callbacks.onOpenNewTab?.(url);
  }

  // ---------------- navigation ----------------

  reload(force = false): void {
    try {
      if (force) this.webview.reloadIgnoringCache();
      else this.webview.reload();
    } catch {
      /* ignore */
    }
  }

  goBack(): void {
    try {
      this.webview.goBack();
    } catch {
      /* ignore */
    }
  }

  goForward(): void {
    try {
      this.webview.goForward();
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    try {
      this.webview.stop();
    } catch {
      /* ignore */
    }
  }

  canGoBack(): boolean {
    try {
      return !!this.webview.canGoBack?.();
    } catch {
      return false;
    }
  }

  canGoForward(): boolean {
    try {
      return !!this.webview.canGoForward?.();
    } catch {
      return false;
    }
  }

  // ---------------- find / inspect ----------------

  findInPage(text: string, forward = true, findNext = false): void {
    try {
      this.webview.focus();
      if (!text) {
        this.webview.stopFindInPage("clearSelection");
        this.callbacks.onFindResult?.(0, 0);
        return;
      }
      this.webview.findInPage(text, { forward, findNext, matchCase: false });
    } catch {
      /* ignore */
    }
  }

  stopFind(): void {
    try {
      this.webview.stopFindInPage("clearSelection");
    } catch {
      /* ignore */
    }
  }

  openDevTools(): void {
    try {
      this.webview.openDevTools();
    } catch (e) {
      console.warn("[obsidian-browser] openDevTools failed", e);
    }
  }

  async execJs<T = unknown>(code: string): Promise<T | null> {
    try {
      return (await this.webview.executeJavaScript<T>(code, true)) ?? null;
    } catch {
      return null;
    }
  }

  async insertCSS(css: string): Promise<void> {
    if (!css) return;
    try {
      await this.webview.insertCSS(css);
    } catch {
      /* ignore */
    }
  }

  setUserAgent(ua: string): void {
    this.appliedUserAgent = ua;
    try {
      this.webview.setUserAgent(ua);
    } catch {
      /* ignore */
    }
    // Electron ignores the `useragent` ATTRIBUTE; only webContents takes it.
    const wc = webContentsFromId(this.webviewId());
    if (wc?.setUserAgent && ua) {
      try {
        wc.setUserAgent(ua);
      } catch {
        /* ignore */
      }
    }
  }

  webviewId(): number {
    try {
      return this.webview.getWebContentsId?.() ?? -1;
    } catch {
      return -1;
    }
  }

  private syncUserAgent(url: string): void {
    const ua = this.getSettings().userAgent;
    if (ua && ua !== this.appliedUserAgent) this.setUserAgent(ua);
    void url;
  }

  // ---------------- health ----------------

  /** A guest that stops answering can only be replaced, not repaired. */
  async isHealthy(timeoutMs = 800): Promise<boolean> {
    if (this.disposed || !this.webview.isConnected) return false;
    try {
      const res = await Promise.race([
        this.webview.executeJavaScript("1", false),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
      ]);
      return res === 1;
    } catch {
      return false;
    }
  }

  // ---------------- favicon ----------------

  /** Fetch inside the page: the host realm is often blocked from remote images. */
  private async loadFaviconAsDataUrl(url: string): Promise<string> {
    if (!/^https?:/i.test(url)) return "";
    const code =
      `(async()=>{try{const r=await fetch(${JSON.stringify(url)},{mode:"cors",credentials:"omit"});` +
      `if(!r.ok)return "";const b=await r.blob();if(!b.size)return "";` +
      `return await new Promise((res)=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result));` +
      `fr.onerror=()=>res("");fr.readAsDataURL(b);});}catch(e){return "";}})()`;
    try {
      const out = await this.webview.executeJavaScript<string>(code, false);
      return typeof out === "string" ? out : "";
    } catch {
      return "";
    }
  }

  private async tryFallbackFavicon(): Promise<void> {
    const url = this.getCurrentUrl();
    if (!/^https?:/i.test(url)) return;
    try {
      const host = new URL(url).origin;
      const dataUrl = await this.loadFaviconAsDataUrl(host + "/favicon.ico");
      if (dataUrl) {
        this.faviconEverSet = true;
        this.callbacks.onFaviconChange?.(dataUrl);
      }
    } catch {
      /* ignore */
    }
  }

  // ---------------- link interception fallback ----------------

  /**
   * Pages love to re-assign window.open after the preload ran. When that
   * happened, our preload hook is gone — so install a plain DOM interceptor and
   * poll the result. (Polling instead of IPC because this runs in the guest's
   * main world where ipcRenderer may not be reachable.)
   */
  private async injectLinkInterceptor(): Promise<void> {
    if (this.pollTimer) return;
    const code = `
      (function(){
        if (window.__obsidianLinkInterceptor) return "already";
        window.__obsidianLinkInterceptor = true;
        window.__obsidianHadPreload = !!window.__obsidianBrowserPreload;
        window.__obsidianPendingNewTab = null;
        try { window.open = function(u){ if(u){ window.__obsidianPendingNewTab = String(u); } return null; }; } catch(e){}
        document.addEventListener("click", function(e){
          var a = e.target && e.target.closest && e.target.closest("a[href]");
          if(!a) return;
          if(!(e.button===1||e.metaKey||e.ctrlKey||e.shiftKey||a.getAttribute("target")==="_blank")) return;
          e.preventDefault(); e.stopPropagation();
          window.__obsidianPendingNewTab = a.href;
        }, true);
        return "installed";
      })()`;
    try {
      await this.webview.executeJavaScript(code, false);
    } catch {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (this.disposed) return;
      void (async () => {
        try {
          const v = await this.webview.executeJavaScript<string>(
            "(function(){var u=window.__obsidianPendingNewTab;window.__obsidianPendingNewTab=null;return u})()",
            false,
          );
          if (v) this.openNewTab(String(v), true);
        } catch {
          /* guest gone */
        }
      })();
    }, 400);
  }
}
