/* eslint-disable @typescript-eslint/no-explicit-any */
import { Menu, Notice, Plugin, TFile } from "obsidian";
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
import { bindSessionDownloads } from "./browser/downloads";
import { ExtensionHost } from "./extensions/extensionHost";
import { PopupLayer } from "./extensions/popup";
import { BrowserSettingTab } from "./settings/SettingsTab";
import { downloadToVault } from "./utils/download";
import { isUrlExcluded, normalizeUrl } from "./utils/url";
import { nodeRequire, openExternal, vaultBasePath } from "./utils/electron";

export default class BrowserPlugin extends Plugin {
  private store = new DataStore(this);
  private bookmarks!: BookmarksStore;
  private history!: HistoryStore;
  private downloads!: DownloadsStore;
  private extHost!: ExtensionHost;
  private popupLayer: PopupLayer | null = null;
  private ctx!: BrowserContext;

  private preloadUrl = "";
  private extPreloadUrl = "";
  private unbindDownloads: (() => void) | null = null;
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
      () => this.store.save(),
    );

    await this.writePreloads();
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
    this.addSettingTab(
      new BrowserSettingTab(this.app, this, {
        settings: this.config,
        save: () => this.store.save(),
        extHost: this.extHost,
        extensions: () => this.store.data.extensions,
        refreshExtensionIcons: () => this.refreshExtensionIcons(),
        clearHistory: () => this.history.clear(),
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.bindDownloads();
      if (this.config.restoreSession && this.store.data.session.length) {
        // Nothing to do: BrowserView.onOpen pulls the session from ctx.
      }
    });
  }

  onunload(): void {
    this.unbindDownloads?.();
    this.popupLayer?.close();
    void this.store.flush();
  }

  // ---------------- context ----------------

  private buildContext(): BrowserContext {
    return {
      app: this.app,
      getSettings: () => this.config,
      bookmarks: this.bookmarks,
      history: this.history,
      downloads: this.downloads,
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

      onDomReady: (webview: IWebviewTag, url: string) => {
        void this.extHost.injectDocumentEnd(webview as never, url);
      },
      extensionStartPayload: (url: string) => this.extHost.documentStartPayload(url),
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
      requestNewTab: (url) => void this.openUrl(url, true),
      initialTabs: () => (this.config.restoreSession ? this.store.data.session : []),
      saveSession: (tabs: PersistedTab[]) => {
        this.store.data.session = tabs;
        this.store.save();
      },
      onDataChange: (fn) => this.store.onChange(fn),
      currentUrl: () => this.activeTab()?.url ?? "",
    };
  }

  private buildPopupLayer(): void {
    if (this.popupLayer || !this.extPreloadUrl) return;
    this.popupLayer = new PopupLayer(document.body, this.extHost, this.extPreloadUrl);
    this.popupLayer.onOpenNewTab = (url) => void this.openUrl(url, true);
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
