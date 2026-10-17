/* eslint-disable @typescript-eslint/no-explicit-any */
import { Menu } from "obsidian";
import { HEALTH_CHECK_INTERVAL, HEALTH_FAIL_STREAK } from "../constants";
import type { IWebviewTag, WebViewContextMenuParams } from "../types";
import { Toolbar } from "./Toolbar";
import { WebviewController, createWebview } from "./WebviewController";
import { showWebViewContextMenu } from "./contextMenu";
import type { BrowserContext } from "./context";
import { buildAdBlockCss, BUILTIN_ADBLOCK_RULES } from "./adblock";
import { isValidHttpUrl } from "../utils/url";
import { EDGE_ADDONS_HOME } from "../extensions/edgeStore";

/**
 * One browser tab: toolbar + a single <webview> guest, plus the defensive
 * machinery that keeps it usable.
 *
 * Two failure modes this guards against, both learned the hard way in the
 * SiYuan plugin: a webview whose guest dies silently (Obsidian re-parents the
 * DOM when a leaf is moved between splits), and pages that re-assign
 * window.open so new-tab links escape to the system browser.
 */
export class BrowserTab {
  readonly id: string;
  readonly element: HTMLDivElement;

  url = "about:blank";
  title = "新标签页";
  favicon = "";

  private wrap: HTMLDivElement;
  private webview: IWebviewTag;
  private controller: WebviewController;
  readonly toolbar: Toolbar;

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private failStreak = 0;
  private disposed = false;

  constructor(
    private ctx: BrowserContext,
    initialUrl?: string,
    /** false = the view owns the toolbar (e.g. mounted in the native view header). */
    private embedToolbar = true,
  ) {
    this.id = "tab" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.element = document.createElement("div");
    this.element.className = "ob-browser-tab";

    this.wrap = document.createElement("div");
    this.wrap.className = "ob-browser-webview-wrap";
    this.element.appendChild(this.wrap);

    this.toolbar = new Toolbar(
      () => this.ctx.getSettings(),
      {
        onBack: () => this.goBack(),
        onForward: () => this.goForward(),
        onReload: (force) => this.reload(force),
        onStop: () => this.controller.stop(),
        onHome: () => void this.loadUrl(this.ctx.getSettings().homePage || "about:blank"),
        onNavigate: (url) => void this.loadUrl(url),
        onToggleBookmark: () => this.toggleBookmark(),
        onFind: (text, forward, next) => this.controller.findInPage(text, forward, next),
        onFindClose: () => this.controller.stopFind(),
        onOpenExternal: () => this.ctx.openInSystemBrowser(this.url),
        onOpenExtensionStore: () => void this.loadUrl(EDGE_ADDONS_HOME),
        onMenu: (e) => this.showMenu(e),
        onExtensionClick: (id, anchor) => this.ctx.onExtensionClick(id, anchor),
      },
    );
    if (this.embedToolbar) this.element.insertBefore(this.toolbar.element, this.wrap);

    this.webview = this.createWebviewElement();
    this.wrap.appendChild(this.webview as unknown as HTMLElement);
    this.controller = new WebviewController(this.webview, () => this.ctx.getSettings(), this.callbacks());

    if (initialUrl) void this.loadUrl(initialUrl);
    this.startHealthCheck();
  }

  // ---------------- construction helpers ----------------

  private createWebviewElement(): IWebviewTag {
    const s = this.ctx.getSettings();
    return createWebview(s.partition || "persist:obsidian-browser", this.ctx.preloadUrl(), s.userAgent || "");
  }

  private callbacks() {
    return {
      onUrlChange: (url: string) => {
        this.url = url || "about:blank";
        this.toolbar.setUrl(this.url);
        this.toolbar.setBookmarked(this.ctx.bookmarks.has(this.url));
        if (isValidHttpUrl(this.url)) {
          this.ctx.history.record(this.url, this.title || this.url, this.favicon || undefined);
        }
        this.ctx.notifyTabChanged(this);
      },
      onTitleChange: (title: string) => {
        this.title = title || this.url || "新标签页";
        if (isValidHttpUrl(this.url)) this.ctx.history.record(this.url, this.title, this.favicon || undefined);
        this.ctx.notifyTabChanged(this);
      },
      onLoadingChange: (loading: boolean) => {
        this.toolbar.setLoading(loading);
        if (!loading) this.toolbar.setNavState(this.controller.canGoBack(), this.controller.canGoForward());
      },
      onFaviconChange: (dataUrl: string) => {
        this.favicon = dataUrl;
        this.ctx.notifyTabChanged(this);
      },
      onOpenNewTab: (url: string) => this.ctx.requestNewTab(url),
      onFindResult: (active: number, matches: number) => this.toolbar.setFindResult(active, matches),
      onDomReady: (webview: IWebviewTag, url: string) => {
        void this.injectAdFilter(webview, url);
        this.ctx.onDomReady(webview, url);
        this.toolbar.setExtensionIcons(this.ctx.extensionIcons());
      },
      onExtensionRequest: (url: string) => this.ctx.extensionStartPayload(url),
      onEdgeInstall: (id: string, webview: IWebviewTag) => this.ctx.onEdgeInstall?.(id, webview),
      onContextMenu: (params: WebViewContextMenuParams) => {
        showWebViewContextMenu(params, this.wrap.getBoundingClientRect(), {
          goBack: () => this.goBack(),
          goForward: () => this.goForward(),
          reload: () => this.reload(false),
          openInNewTab: (url) => this.ctx.requestNewTab(url),
          saveAs: (url, name) => void this.ctx.saveUrlToVault(url, name),
          excerpt: (mode) => void this.ctx.excerpt(this, mode),
          copyImage: (src) => void this.copyImage(src),
          openSource: (url) => this.ctx.requestNewTab(url),
          inspect: () => this.controller.openDevTools(),
        });
      },
    };
  }

  private async injectAdFilter(webview: IWebviewTag, url: string): Promise<void> {
    const s = this.ctx.getSettings();
    if (!s.adBlockEnabled) return;
    const css = buildAdBlockCss(url, s.adBlockRules || "", BUILTIN_ADBLOCK_RULES);
    if (!css) return;
    try {
      await webview.insertCSS(css);
    } catch {
      /* guest gone */
    }
  }

  // ---------------- public API ----------------

  /** 主 webview（PopupLayer 页内渲染 popup 用） */
  getWebview(): IWebviewTag {
    return this.webview;
  }

  async loadUrl(url: string): Promise<void> {
    if (this.disposed) return;
    const target = url || "about:blank";
    this.url = target;
    this.title = target === "about:blank" ? "新标签页" : target;
    this.toolbar.setUrl(target);
    await this.controller.loadURL(target);
    this.ctx.notifyTabChanged(this);
  }

  reload(force = false): void {
    this.controller.reload(force);
  }

  goBack(): void {
    this.controller.goBack();
  }

  goForward(): void {
    this.controller.goForward();
  }

  focusUrl(): void {
    this.toolbar.focusUrl();
  }

  toggleFindBar(show?: boolean): void {
    this.toolbar.toggleFind(show);
  }

  get webviewElement(): IWebviewTag {
    return this.webview;
  }

  get controllerRef(): WebviewController {
    return this.controller;
  }

  async execJs<T = unknown>(code: string): Promise<T | null> {
    return this.controller.execJs<T>(code);
  }

  private toggleBookmark(): void {
    if (!isValidHttpUrl(this.url)) return;
    const added = this.ctx.bookmarks.toggle({ title: this.title, url: this.url, favicon: this.favicon || undefined });
    this.toolbar.setBookmarked(added);
  }

  /** Copy the image itself (not its URL) via the in-page clipboard API. */
  private async copyImage(srcUrl: string): Promise<void> {
    const code =
      `(async()=>{try{const r=await fetch(${JSON.stringify(srcUrl)},{mode:"cors",credentials:"omit"});` +
      `const b=await r.blob();` +
      `await navigator.clipboard.write([new ClipboardItem({[b.type||"image/png"]:b})]);return "ok";}` +
      `catch(e){return String(e)}})()`;
    const res = await this.execJs<string>(code);
    if (res !== "ok") {
      // Best effort: at least give them the URL.
      const { copyText } = await import("../utils/dom");
      await copyText(srcUrl);
    }
  }

  private showMenu(e: MouseEvent): void {
    // Menu 必须静态导入：esbuild target es2021 下动态 import("obsidian") 会
    // 以原生 import 保留进 cjs 产物，渲染进程解析不了裸模块名（jupyter 模块
    // notebookView.ts 同坑先例），点击后菜单静默不出现。
    {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("刷新").setIcon("refresh-cw").onClick(() => this.reload(false)));
      menu.addItem((i) => i.setTitle("在系统中打开").setIcon("external-link").onClick(() => this.ctx.openInSystemBrowser(this.url)));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("摘录整页为笔记").setIcon("scissors").onClick(() => void this.ctx.excerpt(this, "article")));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("检查元素").setIcon("terminal").onClick(() => this.controller.openDevTools()));
      menu.showAtMouseEvent(e);
    }
  }

  // ---------------- health ----------------

  /**
   * Obsidian moves DOM around when a leaf is re-parented (drag to another
   * split, workspace layout restore) and Electron destroys the guest on
   * detach — the tab then looks fine but is permanently blank. Detect and
   * rebuild. Never probe during a load: that produces false negatives.
   */
  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      if (this.disposed) return;
      if (!this.element.isConnected) return;
      if (!this.controller.hasCompletedInitialLoad || this.controller.isLoading) return;
      void (async () => {
        const ok = await this.controller.isHealthy();
        if (this.disposed) return;
        if (ok) {
          this.failStreak = 0;
          return;
        }
        this.failStreak++;
        if (this.failStreak >= HEALTH_FAIL_STREAK) {
          this.failStreak = 0;
          await this.rebuildWebview();
        }
      })();
    }, HEALTH_CHECK_INTERVAL);
  }

  private async rebuildWebview(): Promise<void> {
    const saved = this.controller.getCurrentUrl() || this.url;
    const fresh = this.createWebviewElement();
    (this.webview as unknown as HTMLElement).replaceWith(fresh as unknown as HTMLElement);
    this.webview = fresh;
    this.controller.reattach(fresh);
    const ua = this.ctx.getSettings().userAgent;
    if (ua) this.controller.setUserAgent(ua);
    if (saved && saved !== "about:blank") await this.controller.loadURL(saved);
  }

  dispose(): void {
    this.disposed = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.controller.dispose();
    this.element.remove();
  }
}
