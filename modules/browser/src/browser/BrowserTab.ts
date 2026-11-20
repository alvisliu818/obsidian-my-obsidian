/* eslint-disable @typescript-eslint/no-explicit-any */
import { Menu } from "obsidian";
import { HEALTH_CHECK_INTERVAL, HEALTH_FAIL_STREAK } from "../constants";
import type { IWebviewTag, WebViewContextMenuParams } from "../types";
import { Toolbar } from "./Toolbar";
import { WebviewController, createWebview } from "./WebviewController";
import { showWebViewContextMenu } from "./contextMenu";
import type { BrowserContext } from "./context";
import { buildAdBlockCss, BUILTIN_ADBLOCK_RULES } from "./adblock";
import { applyProxyForPartition, rememberBrowserPartition } from "./proxy";
import { isValidHttpUrl } from "../utils/url";

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
  /** WebviewController(保存网页 MHTML/复制元素等 ctx 消费方需要;只读外借)。 */
  readonly controller: WebviewController;
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
        onHome: () => void this.loadUrl(this.ctx.startUrl?.() || this.ctx.getSettings().homePage || "about:blank"),
        onNavigate: (url) => void this.loadUrl(url),
        onToggleBookmark: () => this.toggleBookmark(),
        onFind: (text, forward, next) => this.controller.findInPage(text, forward, next),
        onFindClose: () => this.controller.stopFind(),
        onOpenExternal: () => this.ctx.openInSystemBrowser(this.url),
        onMenu: (e) => this.showMenu(e),
        onAnnotate: (e) => this.showAnnotationMenu(e),
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
    const partition = s.partition || "persist:obsidian-browser";
    // 每个 tab 的分区可能覆盖默认值:代理设置(若启用)对该分区就地生效。
    rememberBrowserPartition(partition);
    void applyProxyForPartition(partition, s);
    return createWebview(partition, this.ctx.preloadUrl(), s.userAgent || "");
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
      onUserScriptNavigate: (url: string) => this.ctx.onUserScriptNavigate?.(url),
      onUserScriptRequest: (req: { rid: string; params: { method: string; url: string; headers: Record<string, string> | null; body: string | null } }, webview: unknown) => this.ctx.onUserScriptRequest?.(req, webview as never),
      onContextMenu: (params: WebViewContextMenuParams) => {
        showWebViewContextMenu(params, this.wrap.getBoundingClientRect(), {
          goBack: () => this.goBack(),
          goForward: () => this.goForward(),
          reload: () => this.reload(false),
          openInNewTab: (url) => this.ctx.requestNewTab(url),
          saveAs: (url, name) => void this.ctx.saveUrlToVault(url, name),
          savePageMhtml: () => void this.ctx.savePageMhtml(this),
          copyElement: (x, y) => void this.ctx.copyElementHtml(this, x, y),
          excerpt: (mode) => void this.ctx.excerpt(this, mode),
          annotate: (selectionText) => void this.annotateSelection(selectionText),
          copyImage: (src) => void this.copyImage(src),
          openSource: (url) => this.ctx.requestNewTab(url),
          inspect: () => this.controller.openDevTools(),
        });
      },
      onAnnCreate: (payload: { quote?: string; prefix?: string; suffix?: string; color?: string }, webview: IWebviewTag) => void this.ctx.annotation?.create(webview, this.url, this.title, payload),
      onAnnOpen: (payload: { id?: string; x?: number; y?: number; hover?: boolean }, webview: IWebviewTag) => void this.ctx.annotation?.openFloat(webview, this.url, payload),
      onAnnMeta: (payload: { id?: string; color?: string; tags?: string[] }) => void this.ctx.annotation?.applyMeta(payload),
      onAnnHoverEnd: (payload: { id?: string }) => this.ctx.annotation?.notifyMarkLeave(String(payload?.id ?? "")),
      onAnnRemove: (payload: { kind?: string; id?: string; quote?: string; prefix?: string; suffix?: string }) =>
        void this.ctx.annotation?.setDisplayOff(this.webview, this.url, payload),
      onAnnRect: (payload: { id?: string; rect?: { x: number; y: number; w: number; h: number }; vrect?: { x: number; y: number; w: number; h: number } }) =>
        void this.ctx.annotation?.onRectCaptured(this.webview, this.url, this.title, payload),
      onAnnReanchor: (payload: { id?: string; quote?: string; prefix?: string; suffix?: string }) =>
        void this.ctx.annotation?.reanchorText(this.webview, this.url, payload),
      onEdgeInstall: (id: string) => this.ctx.onEdgeInstall?.(id),
    };
  }

  /** 地址栏 ✎ 菜单：标注入口族（选中文字 / 整页 / 标注笔记 / 列表 / 小字开关）。 */
  private showAnnotationMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("标注选中文字")
        .setIcon("pen-tool")
        .onClick(() => void this.annotateSelection("")),
    );
    menu.addItem((i) =>
      i
        .setTitle("框选标注（截图区域）")
        .setIcon("crop")
        .onClick(() => this.ctx.annotation?.beginCapture(this.webview, this.url)),
    );
    menu.addItem((i) =>
      i.setTitle("标注此页（无选区）").setIcon("file-text").onClick(() => {
        if (!this.ctx.annotation) return;
        void this.ctx.annotation.create(this.webview, this.url, this.title, {});
      }),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("打开标注文档").setIcon("book-open").onClick(() => void this.ctx.annotation?.openDoc(this.url)),
    );
    menu.addItem((i) =>
      i
        .setTitle("本页标注列表（浮动窗）")
        .setIcon("list")
        .onClick(() => void this.ctx.annotation?.openListFloat(this.webview, this.url)),
    );
    menu.addItem((i) => {
      const show = this.ctx.getSettings().showAnnInline !== false;
      i.setTitle(show ? "隐藏标注小字" : "显示标注小字")
        .setIcon(show ? "eye-off" : "eye")
        .onClick(() => {
          const next = !show;
          const s = this.ctx.getSettings();
          s.showAnnInline = next;
          this.ctx.saveSettings?.();
          this.ctx.annotation?.applyInlineVisibility(next);
        });
    });
    menu.showAtMouseEvent(e);
  }

  /** 页面右键「标注」/菜单「标注选中文字」：从页面读选区与前缀后缀（气泡同款），空回落原始选区 */
  private async annotateSelection(selectionText: string): Promise<void> {
    if (!this.ctx.annotation) return;
    const payload = await this.execJs<{ quote: string; prefix: string; suffix: string }>(
      "(function(){var s=window.getSelection();if(!s||s.isCollapsed)return {quote:'',prefix:'',suffix:''};" +
        "var n=function(v){return String(v||'').replace(/\\s+/g,' ').trim()};" +
        "var r=s.getRangeAt(0);var pre='',suf='';" +
        "try{if(r.startContainer.nodeType===3)pre=n(r.startContainer.nodeValue.slice(0,r.startOffset)).slice(-30);" +
        "if(r.endContainer.nodeType===3)suf=n(r.endContainer.nodeValue.slice(r.endOffset)).slice(0,30);}catch(e){}" +
        "return {quote:n(s.toString()),prefix:pre,suffix:suf}})()",
    );
    const quote = payload?.quote || selectionText || "";
    if (!quote.trim()) return;
    void this.ctx.annotation.create(this.webview, this.url, this.title, {
      quote,
      prefix: payload?.prefix ?? "",
      suffix: payload?.suffix ?? "",
    });
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
