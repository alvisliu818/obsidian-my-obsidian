/* eslint-disable @typescript-eslint/no-explicit-any */
import { Menu, Notice, Plugin, requestUrl, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import {
  BROWSER_ICON,
  PLUGIN_ID,
  VIEW_TYPE_BOOKMARKS,
  VIEW_TYPE_BROWSER,
  VIEW_TYPE_DOWNLOADS,
  VIEW_TYPE_HISTORY,
} from "./constants";
import type { BrowserSettings, IWebviewTag, PersistedTab } from "./types";
import { applyProxyEverywhere } from "./browser/proxy";
import { DataStore } from "./storage/dataStore";
import { BookmarksStore } from "./storage/bookmarksStore";
import { HistoryStore } from "./storage/historyStore";
import { DownloadsStore } from "./storage/downloadsStore";
import { BrowserView } from "./views/BrowserView";
import { BookmarksView } from "./views/BookmarksView";
import { HistoryView } from "./views/HistoryView";
import { DownloadsView } from "./views/DownloadsView";
import { BrowserTab } from "./browser/BrowserTab";
import type { BrowserContext } from "./browser/context";
import { clipPage } from "./browser/excerpt";
import { AnnotationController } from "./browser/annotation";
import { bindSessionDownloads } from "./browser/downloads";
import { dnrBlocker } from "./browser/dnrEngine";
import { applyNetFilters } from "./browser/netFilter";
import { buildEdgeStoreHelperScript, isEdgeAddonsSiteUrl } from "./extensions/edgeStoreHelper";
import { ExtensionHost } from "./extensions/extensionHost";
import { UserscriptHost } from "./userscripts/userscriptHost";
import { InstallUserScriptModal } from "./userscripts/install-modal";
import { PopupLayer } from "./extensions/popup";
import { evalInServiceWorker } from "./extensions/swBridge";
import type { UserScriptRecord } from "./types";
import { BrowserSettingTab } from "./settings/SettingsTab";
import { downloadToVault } from "./utils/download";
import { isUrlExcluded, normalizeUrl, safeFilename, formatDateKey } from "./utils/url";
import { nodeRequire, openExternal, vaultBasePath } from "./utils/electron";
import { copyText } from "./utils/dom";
import { SavePageModal } from "./browser/savePageModal";

export default class BrowserPlugin extends Plugin {
  private store = new DataStore(this);
  private bookmarks!: BookmarksStore;
  private history!: HistoryStore;
  private downloads!: DownloadsStore;
  private extHost!: ExtensionHost;
	private usHost!: UserscriptHost;
  private popupLayer: PopupLayer | null = null;
  /** 保存网页上次目录(会话内记忆,自选位置的默认值)。 */
  private lastSavePageDir: string | null = null;
  private ctx!: BrowserContext;
  private annotation!: AnnotationController;
  /** DNR 拦截器单例（调试/探针可达）。 */
  dnrBlocker = dnrBlocker;

  private preloadUrl = "";
  private extPreloadUrl = "";
  private annPopupUrl = "";
  private unbindDownloads: (() => void) | null = null;
  /** Edge 商店按钮状态去抖（页内按钮 2s 内不重复写状态）。 */
  private lastEdgeStateWrite = 0;
  private lastRightClickedUrl = "";
  /** URL for the next browser leaf we are about to create (native mode). */
  private pendingLeafUrl = "";

  /** Plugin base class owns `settings`; this is our own accessor. */
  get config(): BrowserSettings {
    return this.store.data.settings;
  }

  async onload(): Promise<void> {
    await this.store.load();
    this.bookmarks = new BookmarksStore(this.store);
    this.history = new HistoryStore(this.store);
    this.downloads = new DownloadsStore(this.store);

    this.extHost = new ExtensionHost(
      this.app,
      () => this.store.data.extensions,
      () => this.config.extensionsEnabled,
      () => {
        this.store.save();
        this.applyNetFilters();
        this.syncNativeExtensionLoads();
      },
    );

    this.usHost = new UserscriptHost(
      () => this.store.data.userscripts,
      () => this.store.save(),
    );

    await this.writePreloads();
    this.annotation = new AnnotationController(this.app, () => this.config, {
      popupFileUrl: () => this.annPopupUrl,
      openLink: (url, newTab) => void this.openUrl(url, newTab ?? false),
      saveIndex: () => this.store.save(),
      pages: () => this.store.data.annPages,
    });
    this.ctx = this.buildContext();

    this.registerView(VIEW_TYPE_BROWSER, (leaf) => {
      const view = new BrowserView(leaf, this.ctx);
      // Hand the URL to the view directly: for a brand-new leaf Obsidian does
      // not always route the state through setState() before onOpen().
      if (this.pendingLeafUrl) {
        view.pendingUrl = this.pendingLeafUrl;
        this.pendingLeafUrl = "";
      }
      return view;
    });
    this.registerView(VIEW_TYPE_BOOKMARKS, (leaf) => new BookmarksView(leaf, this.ctx));
    this.registerView(VIEW_TYPE_HISTORY, (leaf) => new HistoryView(leaf, this.ctx));
    this.registerView(VIEW_TYPE_DOWNLOADS, (leaf) => new DownloadsView(leaf, this.ctx));

    this.registerCommands();
    this.registerLinkHandlers();

    this.addRibbonIcon(BROWSER_ICON, "打开浏览器", () => void this.openBrowser());
    // 代理设置铺到相关会话(含 scope=app 时的 Obsidian 默认会话)。
    void this.applyBrowserProxy();
    this.addSettingTab(
      new BrowserSettingTab(this.app, this, {
        settings: this.config,
        save: () => {
          this.store.save();
          this.applyNetFilters();
          this.syncNativeExtensionLoads();
        },
        applyNetFilters: () => this.applyNetFilters(),
        applyProxy: () => void this.applyBrowserProxy(),
        usHost: () => this.usHost,
        extHost: this.extHost,
        extensions: () => this.store.data.extensions,
        refreshExtensionIcons: () => this.refreshExtensionIcons(),
        clearHistory: () => this.history.clear(),
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.bindDownloads();
      this.applyNetFilters();
      this.syncNativeExtensionLoads();
      if (this.config.restoreSession && this.store.data.session.length) {
        // Nothing to do: BrowserView.onOpen pulls the session from ctx.
      }
    });
  }

  /** 跨模块入口（virtual-tree bmarks:// 挂载/打开用）：全量书签 + 浏览器内打开。 */
  bookmarksAll(): { title: string; url: string; tags: string[] }[] {
    return this.store.data.bookmarks.map((b) => ({ title: b.title, url: b.url, tags: b.tags ?? [] }));
  }

  openExternalInBrowser(url: string, newTab = false): void {
    void this.openUrl(url, newTab);
  }

  onunload(): void {
    this.unbindDownloads?.();
    this.popupLayer?.close();
    this.annotation?.closeAllFloats();
    void this.store.flush();
  }

  // ---------------- context ----------------

  /** 当前代理设置铺到默认分区 + 打开过的浏览器分区(+scope=app 的默认会话)。 */
  applyBrowserProxy(): Promise<void> {
    return applyProxyEverywhere(this.config.partition || "persist:obsidian-browser", this.config);
  }

  private buildContext(): BrowserContext {
    return {
      app: this.app,
      getSettings: () => this.config,
      bookmarks: this.bookmarks,
      history: this.history,
      downloads: this.downloads,
      annotation: this.annotation,
      preloadUrl: () => this.preloadUrl,

      openInNewTab: (url) => void this.openUrl(url, true),
      openUrl: (url, newTab) => void this.openUrl(url, newTab ?? false),
      openInSystemBrowser: (url) => openExternal(url),

      saveUrlToVault: async (url, suggestedName) => {
        const item = this.downloads.create({ url, filename: suggestedName || "" });
        try {
          const res = await downloadToVault(this.app, url, {
            dir: this.config.downloadDir,
            filename: suggestedName,
            onProgress: (received, total) => this.downloads.progress(item.id, received, total),
          });
          this.downloads.setSavePath(item.id, res.path);
          this.downloads.setState(item.id, "completed");
          new Notice("已保存到仓库：" + res.path);
        } catch (e: any) {
          this.downloads.setState(item.id, "interrupted", String(e?.message ?? e));
          new Notice("保存失败：" + String(e?.message ?? e));
        }
      },

      excerpt: async (tab, mode) => {
        const file = await clipPage(
          this.app,
          this.config,
          (code) => tab.execJs(code),
          mode,
          tab.url,
        );
        if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      },

      // 保存网页 MHTML(用户 2026-11-20:保存网页+自选保存位置):标题+日期
      // 建议名,上次目录会话内记忆;成功后 Notice 落点。
      savePageMhtml: async (tab) => {
        const title = (tab.title || "page").slice(0, 60);
        const name = safeFilename(`${title}-${formatDateKey(Date.now())}`) + ".mhtml";
        const dir = this.lastSavePageDir ?? "";
        const suggested = dir ? `${dir.replace(/[\\/]+$/, "")}\\${name}` : name;
        new SavePageModal(this.app, suggested, (p) => {
          const abs = p.trim().replace(/^"+|"+$/g, "");
          if (!abs) return;
          if (abs.includes("\\")) this.lastSavePageDir = abs.slice(0, abs.lastIndexOf("\\") + 1);
          void tab.controller.savePageMhtml(abs).then((ok) => {
            new Notice(ok ? "网页已保存:" + abs : "保存失败(savePage 不可用或路径无效)");
          });
        }).open();
      },

      // 复制右键命中元素为带样式 HTML(用户 2026-11-20):guest 内联计算样式
      // +保留 script;空串/失败 Notice,成功进剪贴板。
      copyElementHtml: async (tab, x, y) => {
        const html = await tab.controller.copyElementHtml(x, y);
        if (!html) {
          new Notice("未取到元素(页面未就绪或命中空点)");
          return;
        }
        await copyText(html);
        new Notice(`已复制元素 HTML(${html.length} 字符,含内联样式)`);
      },

      onDomReady: (webview: IWebviewTag, url: string) => {
        void this.extHost.injectDocumentEnd(webview as never, url);
        void this.injectEdgeStoreHelper(webview as never, url);
        for (const code of this.usHost.documentEndScripts(url)) void this.usHost.injectScript(webview as never, code);
        void this.annotation.onPageReady(webview, url, String(webview.getTitle?.() ?? ""));
      },
      extensionStartPayload: (url: string) => {
        const p = this.extHost.documentStartPayload(url);
        const u = this.usHost.documentStartPayload(url);
        return { css: [...p.css, ...u.css], js: [...p.js, ...u.js] };
      },
      onEdgeInstall: (id: string) => void this.installEdgeAddon(id),
      onUserScriptNavigate: (url: string) => this.openUserScriptInstall(url),
      onUserScriptRequest: async (req: { rid: string; params: { method: string; url: string; headers: Record<string, string> | null; body: string | null } }, webview: unknown) => {
        const deliver = (payload: string): void => {
          void (webview as { executeJavaScript(code: string): Promise<unknown> })
            .executeJavaScript(`window.__obUsDeliver(${JSON.stringify(req.rid)}, ${payload})`)
            .catch(() => undefined);
        };
        try {
          const resp = await requestUrl({
            url: req.params.url,
            method: req.params.method as "GET",
            headers: (req.params.headers ?? {}) as Record<string, string>,
            body: req.params.body ?? undefined,
            throw: false,
          });
          deliver(JSON.stringify({ status: resp.status, headers: resp.headers, body: resp.text }));
        } catch (e) {
          deliver(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
        }
      },
      extensionIcons: () =>
        this.config.extensionsEnabled
          ? this.store.data.extensions
              .filter((r) => r.enabled)
              .map((r) => ({ id: r.id, name: r.name, icon: this.extHost.iconDataUrl(r) }))
          : [],
      onExtensionClick: (id, anchor) => {
        const rec = this.store.data.extensions.find((r) => r.id === id);
        if (!rec) return;
        if (!rec.popup) {
          new Notice(`扩展「${rec.name}」没有 popup 页面`);
          return;
        }
        this.popupLayer?.toggle(rec, anchor);
      },

      notifyTabChanged: (tab) => this.onTabChanged(tab),
      saveSettings: () => { this.store.save(); this.applyNetFilters(); },
      startUrl: () => this.resolveStartUrl(),
      requestNewTab: (url) => {
        if (this.openUserScriptInstall(url)) return;
        void this.openUrl(url, true);
      },
      initialTabs: () => (this.config.restoreSession ? this.store.data.session : []),
      saveSession: (tabs: PersistedTab[]) => {
        this.store.data.session = tabs;
        this.store.save();
      },
      onDataChange: (fn) => this.store.onChange(fn),
      currentUrl: () => this.activeTab()?.url ?? "",
    };
  }

  /** .user.js 链接 → 原生安装对话框；非用户脚本返回 false 走常规打开。 */
  private openUserScriptInstall(url: string): boolean {
    if (!/\.user\.js(\?|#|$)/i.test(url)) return false;
    void this.usHost;
    new InstallUserScriptModal(this.app, this.usHost, url, undefined, (record) => {
      void this.mirrorUserScriptToManagers(record);
    }).open();
    return true;
  }

  /**
   * P7 协作安装收尾：脚本经原生宿主安装/运行后，把注册镜像到已原生装载的
   * 暴力猴（chrome.userScripts 注册表），其管理面板可见可管。篡改猴的存储
   * 格式私有，不镜像（重复安装防护靠 usHost 的同 name+namespace 判定）。
   */
  private async mirrorUserScriptToManagers(record: UserScriptRecord): Promise<void> {
    const vm = this.store.data.extensions.find(
      (r) => r.enabled && r.nativeId && /violentmonkey|暴力猴/i.test(r.name),
    );
    if (!vm?.nativeId) return;
    const matches = record.matches.length ? record.matches : ["*://*/*"];
    const payload = {
      id: "ob-install-" + record.id,
      matches,
      js: [{ code: record.code }],
      world: "USER_SCRIPT",
      runAt: "document_idle",
    };
    const inner = JSON.stringify(payload);
    const expr =
      "new Promise((res) => chrome.userScripts.register([" +
      inner +
      "], (v) => res(!chrome.runtime.lastError)));";
    const r = await evalInServiceWorker(vm.nativeId, expr);
    if (r.ok) new Notice("已同步到暴力猴脚本面板");
    else console.warn("[obsidian-browser] VM mirror failed:", r.err);
  }

  /** 扩展启用/安装后：尝试原生 loadExtension 装进浏览器分区（TM/VM 协作的前提）。 */
  private syncNativeExtensionLoads(): void {
    const partition = this.config.partition || "persist:obsidian-browser";
    this.extHost.lastPartition = partition;
    for (const rec of this.store.data.extensions) {
      if (rec.enabled && !rec.nativeId) void this.extHost.loadNative(rec, partition);
    }
  }


  private buildPopupLayer(): void {
    if (this.popupLayer || !this.extPreloadUrl) return;
    this.popupLayer = new PopupLayer(document.body, this.extHost, this.extPreloadUrl);
    this.popupLayer.onOpenNewTab = (url) => {
      if (this.openUserScriptInstall(url)) return;
      void this.openUrl(url, true);
    };
  }

  // ---------------- views ----------------

  private browserLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_BROWSER);
  }

  private async getBrowserView(create = true): Promise<BrowserView | null> {
    const leaves = this.browserLeaves();
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return (leaves[0].view as BrowserView) ?? null;
    }
    if (!create) return null;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_BROWSER, active: true });
    this.app.workspace.revealLeaf(leaf);
    return (leaf.view as BrowserView) ?? null;
  }

  /** The view the user is looking at (falls back to the first browser leaf). */
  private activeBrowserView(): BrowserView | null {
    const active = this.app.workspace.activeLeaf;
    if (active?.view instanceof BrowserView) return active.view;
    return (this.browserLeaves()[0]?.view as BrowserView) ?? null;
  }

  private activeTab(): BrowserTab | null {
    return this.activeBrowserView()?.activeTab() ?? null;
  }

  private onTabChanged(tab: BrowserTab): void {
    for (const leaf of this.browserLeaves()) {
      const view = leaf.view as BrowserView;
      if (view?.tabs?.includes(tab)) {
        view.renderTabbar();
        view.updateTitle();
      }
    }
  }

  private refreshExtensionIcons(): void {
    for (const leaf of this.browserLeaves()) {
      const view = leaf.view as BrowserView;
      if (!view?.tabs) continue;
      for (const tab of view.tabs) tab.toolbar.setExtensionIcons(this.ctx.extensionIcons());
    }
  }

  private async openBrowser(): Promise<void> {
    await this.getBrowserView();
  }

  /**
   * Native mode = one Obsidian leaf per page, so "open in a new tab" is a new
   * leaf whose view state carries the URL (restored by workspace.json).
   */
  private async openUrl(url: string, newTab = false): Promise<void> {
    // 地址栏/编程式导航也要走 .user.js 检测——programmaticNav 会绕过
    // will-navigate 拦截,这里是唯一能兜住全部入口的位置
    if (this.openUserScriptInstall(url)) return;
    if (this.config.tabMode === "native") {
      if (newTab || !this.browserLeaves().length) {
        this.pendingLeafUrl = url;
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: VIEW_TYPE_BROWSER, state: { url }, active: true });
        this.app.workspace.revealLeaf(leaf);
        return;
      }
      const view = this.activeBrowserView();
      if (!view) return;
      await view.activeTab()?.loadUrl(url);
      this.app.workspace.revealLeaf(view.leaf);
      return;
    }
    const view = await this.getBrowserView();
    view?.openUrl(url, newTab);
  }

  private async openDock(type: string): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(type);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("split");
    await leaf.setViewState({ type, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // ---------------- commands ----------------

  private registerCommands(): void {
    this.addCommand({
      id: "open-browser",
      name: "打开浏览器",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "B" }],
      callback: () => void this.openBrowser(),
    });
    this.addCommand({
      id: "new-tab",
      name: "新建标签页",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "T" }],
      callback: () => void this.openUrl(this.config.homePage || "about:blank", true),
    });
    this.addCommand({
      id: "close-tab",
      name: "关闭当前标签页",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "W" }],
      callback: () => {
        const view = this.activeBrowserView();
        if (!view) return;
        // Native mode: the whole leaf is the tab.
        if (view.isNative) view.leaf.detach();
        else if (view.activeId) view.closeTab(view.activeId);
      },
    });
    this.addCommand({
      id: "reload",
      name: "刷新页面",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "R" }],
      callback: () => this.activeTab()?.reload(false),
    });
    this.addCommand({
      id: "force-reload",
      name: "强制刷新（忽略缓存）",
      hotkeys: [{ modifiers: ["Mod", "Alt", "Shift"], key: "R" }],
      callback: () => this.activeTab()?.reload(true),
    });
    this.addCommand({
      id: "go-back",
      name: "后退",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "ArrowLeft" }],
      callback: () => this.activeTab()?.goBack(),
    });
    this.addCommand({
      id: "go-forward",
      name: "前进",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "ArrowRight" }],
      callback: () => this.activeTab()?.goForward(),
    });
    this.addCommand({
      id: "focus-url",
      name: "聚焦地址栏",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "L" }],
      callback: () => this.activeTab()?.focusUrl(),
    });
    this.addCommand({
      id: "find-in-page",
      name: "在页面中查找",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "F" }],
      callback: () => this.activeTab()?.toggleFindBar(true),
    });
    this.addCommand({
      id: "clip-article",
      name: "摘录当前页面为笔记",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "S" }],
      callback: () => {
        const tab = this.activeTab();
        if (tab) void this.ctx.excerpt(tab, "article");
      },
    });
    this.addCommand({
      id: "annotate-page",
      name: "标注当前页面（无选区）",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "A" }],
      callback: () => {
        const tab = this.activeTab();
        if (!tab || !this.annotation) return;
        void this.annotation.create(tab.webviewElement, tab.url, tab.title, {});
      },
    });
    this.addCommand({
      id: "zoom-reset",
      name: "页面缩放重置",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "0" }],
      callback: () => this.activeTab()?.controllerRef.resetZoom(),
    });
    this.addCommand({
      id: "zoom-in",
      name: "页面放大",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "=" }],
      callback: () => this.activeTab()?.controllerRef.applyZoomStep(1.1),
    });
    this.addCommand({
      id: "zoom-out",
      name: "页面缩小",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "-" }],
      callback: () => this.activeTab()?.controllerRef.applyZoomStep(1 / 1.1),
    });
    this.addCommand({
      id: "open-url-from-clipboard",
      name: "打开剪贴板中的网址",
      callback: async () => {
        const text = await navigator.clipboard.readText().catch(() => "");
        if (!text) {
          new Notice("剪贴板为空");
          return;
        }
        await this.openUrl(normalizeUrl(text.trim(), this.config), false);
      },
    });
    this.addCommand({
      id: "open-bookmarks",
      name: "显示书签",
      callback: () => void this.openDock(VIEW_TYPE_BOOKMARKS),
    });
    this.addCommand({
      id: "open-history",
      name: "显示历史",
      callback: () => void this.openDock(VIEW_TYPE_HISTORY),
    });
    this.addCommand({
      id: "open-downloads",
      name: "显示下载",
      callback: () => void this.openDock(VIEW_TYPE_DOWNLOADS),
    });
  }

  // ---------------- links ----------------

  private registerLinkHandlers(): void {
    // Click: open http(s) links in the plugin instead of the system browser.
    this.registerDomEvent(
      document,
      "click",
      (e: MouseEvent) => {
        if (!this.config.interceptAllLinks) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest?.(".ob-browser-root")) return; // our own UI
        const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!/^https?:/i.test(href)) return;
        if (isUrlExcluded(href, this.config.excludedSites)) return;
        e.preventDefault();
        e.stopPropagation();
        void this.openUrl(href, e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1);
      },
      true,
    );

    // Right-click: remember the link so the editor menu can offer our entry.
    this.registerDomEvent(
      document,
      "contextmenu",
      (e: MouseEvent) => {
        const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        const href = anchor?.getAttribute("href") || "";
        this.lastRightClickedUrl = /^https?:/i.test(href) ? href : "";
      },
      true,
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu) => {
        const url = this.lastRightClickedUrl;
        if (!url) return;
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("在浏览器中打开").setIcon("globe").onClick(() => void this.openUrl(url, false)),
        );
        menu.addItem((i) =>
          i.setTitle("在新标签页中打开").setIcon("external-link").onClick(() => void this.openUrl(url, true)),
        );
      }),
    );
  }

  // ---------------- preload ----------------

  /**
   * The preload must be a real file on disk (Electron loads it by path), so the
   * source is inlined in main.js and written out on load. One artifact to
   * deploy, and it self-heals when the plugin is updated.
   */
  private async writePreloads(): Promise<void> {
    const base = vaultBasePath(this.app);
    const sources: [string, string][] = [
      ["preload.js", __PRELOAD_SOURCE__],
      ["ext-preload.js", __EXT_PRELOAD_SOURCE__],
      ["annotation-popup.html", __ANN_POPUP_HTML__],
    ];
    const rel = `.obsidian/plugins/${PLUGIN_ID}`;

    const fs = nodeRequire<any>("fs");
    const pathMod = nodeRequire<any>("path");
    if (base && fs && pathMod) {
      const dir = pathMod.join(base, ".obsidian", "plugins", PLUGIN_ID);
      try {
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, src] of sources) fs.writeFileSync(pathMod.join(dir, name), src, "utf8");
        this.preloadUrl = toFileUrl(pathMod.join(dir, "preload.js"));
        this.extPreloadUrl = toFileUrl(pathMod.join(dir, "ext-preload.js"));
        this.annPopupUrl = toFileUrl(pathMod.join(dir, "annotation-popup.html"));
      } catch (e) {
        console.warn("[obsidian-browser] preload write failed", e);
      }
    }

    if (!this.preloadUrl) {
      // Without node integration: still write through the vault adapter so the
      // path exists, even though Electron will likely refuse to load it.
      for (const [name, src] of sources) {
        try {
          await this.app.vault.adapter.write(`${rel}/${name}`, src);
        } catch {
          /* ignore */
        }
      }
    }
    this.buildPopupLayer();
  }

  /** DNR 网络过滤 + Edge 商店 UA：设置变更/扩展装卸后全量重放。 */
  applyNetFilters(): void {
    if (!this.config.dnrEnabled) return;
    const adguard = this.store.data.extensions.find((r) => r.enabled && /adguard/i.test(r.name));
    const dir = adguard && this.extHost.available ? this.extHost.dirOf(adguard) : null;
    applyNetFilters({
      defaultPartition: this.config.partition || "persist:obsidian-browser",
      dnrEnabled: true,
      adguardExtDir: dir,
    });
  }

  /** 页内 Edge 安装按钮状态回写（2s 去抖）。 */
  private async writeEdgeStoreState(state: "installing" | "ok" | "idle"): Promise<void> {
    const now = Date.now();
    if (now - this.lastEdgeStateWrite < 2000) return;
    this.lastEdgeStateWrite = now;
    const tab = this.activeTab();
    if (!tab) return;
    await tab.execJs(`window.__obEdgeStoreSetState && window.__obEdgeStoreSetState(${JSON.stringify(state)})`);
  }

  /** Edge 加载项安装（商店页按钮 / microsoft-edge: 协议 / CRX 直链）。 */
  private async installEdgeAddon(idOrUrl: string): Promise<void> {
    new Notice("正在从 Edge 加载项商店获取扩展…");
    void this.writeEdgeStoreState("installing");
    try {
      const rec = await this.extHost.installFromEdgeAddons(idOrUrl);
      this.refreshExtensionIcons();
      this.applyNetFilters();
      void this.writeEdgeStoreState("ok");
      new Notice("已安装扩展：" + rec.name);
    } catch (e: any) {
      console.warn("[obsidian-browser] edge install failed", e);
      new Notice("安装失败：" + String(e?.message || e));
    }
  }

  /** Edge 商店详情页注入「安装到 Obsidian」浮动按钮 + 回写状态通道。 */
  private async injectEdgeStoreHelper(webview: IWebviewTag, url: string): Promise<void> {
    if (!isEdgeAddonsSiteUrl(url)) return;
    try {
      await webview.executeJavaScript(
        buildEdgeStoreHelperScript({ install: "安装到 Obsidian", installing: "安装中…", installed: "已安装" }),
        false,
      );
    } catch {
      /* guest gone */
    }
  }

  /** 新标签页起始 URL：新标签页扩展（设置）优先，回落主页。 */
  private resolveStartUrl(): string {
    if (this.config.newTabExtId) {
      const page = this.extHost.newtabExtensions().find((x) => x.id === this.config.newTabExtId);
      if (page) return page.page;
    }
    return this.config.homePage || "about:blank";
  }

  private bindDownloads(): void {
    this.unbindDownloads?.();
    this.unbindDownloads = bindSessionDownloads({
      app: this.app,
      partition: this.config.partition || "persist:obsidian-browser",
      store: this.downloads,
      getDir: () => this.config.downloadDir,
      getExcluded: () => this.config.excludedSites,
    });
  }
}

/** file:// URL that survives spaces and '#' in the vault path. */
function toFileUrl(abs: string): string {
  const p = abs.replace(/\\/g, "/");
  return "file:///" + p.replace(/[%#?]/g, (c) => encodeURIComponent(c)).replace(/ /g, "%20");
}
