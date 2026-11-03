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
import { bindWebRequestPipeline } from "./browser/webRequestPipeline";
import { UserJsChain } from "./browser/userJsInstall";
import { evalInSwBridge } from "./extensions/cs-runtime";
import { applyProxyToSession } from "./browser/proxy";
import { dnrBlocker } from "./browser/dnrEngine";
import { bindSessionDownloads } from "./browser/downloads";
import { ExtensionHost } from "./extensions/extensionHost";
import { buildEdgeStoreHelperScript, isEdgeAddonsSiteUrl } from "./extensions/edgeStoreHelper";
import { EDGE_ADDONS_HOME } from "./extensions/edgeStore";
import { setClipBridge } from "./extensions/cs-runtime";
import { UserscriptInjector } from "./extensions/userscriptInjector";
import { htmlToMarkdown } from "./utils/markdown";
import { PopupLayer } from "./extensions/popup";
import { BrowserSettingTab } from "./settings/SettingsTab";
import { downloadToVault } from "./utils/download";
import { isUrlExcluded, normalizeUrl, safeFilename } from "./utils/url";
import { nodeRequire, openExternal, sessionFromPartition, vaultBasePath } from "./utils/electron";

export default class BrowserPlugin extends Plugin {
  private store = new DataStore(this);
  private bookmarks!: BookmarksStore;
  private history!: HistoryStore;
  private downloads!: DownloadsStore;
  private extHost!: ExtensionHost;
  private usInjector = new UserscriptInjector();
  private usChain!: UserJsChain;
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
      () => void this.store.saveNow(),
    );

    // 思源内核 API 的 Obsidian 对应：扩展剪藏流程（cs-runtime）经这个桥落库。
    // extract ← 思源 /api/extension/copy；save ← 思源 createDocWithMd + renderSprig
    // + netImg2LocalAssets 的组合（Obsidian 侧 = vault.create + clipFolder 设置）。
    setClipBridge({
      extract: async (data: Record<string, any>) => {
        const html = String(data.html || "");
        const md = html ? htmlToMarkdown(html) : String(data.excerpt || "");
        return md ? { md } : { md: "", error: "页面无可用内容" };
      },
      save: async (_data: Record<string, any>, markdown: string, title: string) => {
        const folder = (this.config.clipFolder || "Browser/Clippings").replace(/\/+$/, "");
        const stem = safeFilename(title) || "clipping";
        let path = `${folder}/${stem}.md`;
        for (let i = 1; this.app.vault.getAbstractFileByPath(path) && i < 500; i++) {
          path = `${folder}/${stem} ${i}.md`;
        }
        const file = await this.app.vault.create(path, markdown);
        return { ok: true, path: file.path };
      },
    });

    // .user.js 安装链 + webRequest 阻塞桥 + webNavigation 合成
    this.usChain = new UserJsChain({
      listExts: () =>
        this.store.data.extensions
          .filter((r) => r.enabled && r.electronId)
          .map((r) => ({ electronId: r.electronId!, name: r.name, native: true })),
      getRegistry: () => this.usInjector.registry(),
      evalInSw: (eid, expr) => evalInSwBridge({ electronId: eid } as any, expr),
      openUrl: (u) => void this.openUrl(u, true),
      activeUrl: () => this.activeTab()?.url ?? "",
      ensureCsRuntime: () => {
        const t = this.activeTab();
        if (t) this.extHost.ensureCsRuntime(t.getWebview());
      },
    });

    // 新标签页扩展数据代答（chrome.topSites/bookmarks/history ← 自己的库）
    this.extHost.userDataProvider = async (kind: string, args: any) => {
      const bmNode = (b: (typeof this.store.data.bookmarks)[number], i: number) => ({
        id: "bm" + i,
        parentId: "1",
        title: b.title || b.url,
        url: b.url,
        dateAdded: b.createdAt ?? undefined,
      });
      switch (kind) {
        case "topSites": {
          const count = new Map<string, { url: string; title: string; n: number }>();
          for (const h of this.store.data.history) {
            try {
              const host = new URL(h.url).hostname;
              const cur = count.get(host);
              if (cur) cur.n++;
              else count.set(host, { url: h.url, title: h.title || h.url, n: 1 });
            } catch {
              /* bad url */
            }
          }
          return [...count.values()].sort((a, b) => b.n - a.n).slice(0, 10).map((x) => ({ url: x.url, title: x.title }));
        }
        case "bookmarkTree":
          return [
            {
              id: "0",
              title: "",
              children: [
                {
                  id: "1",
                  parentId: "0",
                  title: "Bookmarks 栏",
                  children: this.store.data.bookmarks.map((b, i) => bmNode(b, i)),
                },
              ],
            },
          ];
        case "bookmarkRecent": {
          const n = Number(args?.n) || 10;
          return this.store.data.bookmarks.slice(0, n).map((b, i) => bmNode(b, i));
        }
        case "bookmarkSearch": {
          const q = String(args?.query || "").toLowerCase();
          return this.store.data.bookmarks
            .filter((b) => !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || (b.tags ?? []).some((t) => t.toLowerCase().includes(q)))
            .map((b, i) => bmNode(b, i));
        }
        case "historySearch": {
          const q = args?.query;
          const list = this.history.search(typeof q === "string" ? q : "");
          return list.map((h) => ({ url: h.url, title: h.title, lastVisitTime: h.visitTime, visitCount: 1 }));
        }
        default:
          return null;
      }
    };

    // 油猴类扩展的 userScripts 注入（宿主侧对账 + GM 前奏），扩展清单由 extHost 提供
    this.usInjector.setNativeIdProvider(() =>
      this.store.data.extensions
        .filter((r) => r.enabled && r.electronId)
        .map((r) => ({
          electronId: r.electronId!,
          path: this.extHost.dirOfPublic(r),
          name: r.name,
          version: r.version,
          defaultLocale: (r as any).defaultLocale ?? "",
          contentScripts: r.contentScripts ?? [],
        })),
    );

    // 插件重启后 session 里的原生扩展已失效，需重新加载以拿回 electronId，
    // 否则 cs-runtime / sw-bridge 拿不到 SW，退回自研注入式。
    void this.extHost.syncNativeOnStartup().then(() => {
      this.wakeDnrEngine();
      // SW 就绪后拉一轮 webRequest filter 快照（阻塞桥冷启动）
      void this.usChain.refreshWrBridge(true);
    });

    await this.writePreloads();
    this.ctx = this.buildContext();

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
        applyProxy: () => applyProxyToSession(this.config),
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.bindDownloads();
      this.bindWebRequestPipeline();
      void applyProxyToSession(this.config);
      if (this.config.restoreSession && this.store.data.session.length) {
        // Nothing to do: BrowserView.onOpen pulls the session from ctx.
      }
    });
  }

  onunload(): void {
    this.unbindDownloads?.();
    this.unbindPipeline?.();
    this.unbindPipeline = null;
    this.popupLayer?.close();
    void this.store.flush();
  }

  // ---------------- 网络层（webRequest 管线 + DNR + 代理）----------------

  private unbindPipeline: (() => void) | null = null;
  private pipelinePartition = "";
  /** 当前活动页签 URL 的弱引用（Referer 兜底用；BrowserView 会刷新它）。 */
  private lastActiveTabUrl = "";

  /**
   * webRequest 三层管线（每 partition 注册一次——Electron 的 webRequest
   * 是单听众语义，重复注册只会覆盖）。partition 改设置后重绑。
   */
  private bindWebRequestPipeline(): void {
    const partition = this.config.partition;
    if (this.unbindPipeline && this.pipelinePartition === partition) return;
    this.unbindPipeline?.();
    this.unbindPipeline = null;
    const session = sessionFromPartition(partition);
    if (!session?.webRequest) return;
    this.lastActiveTabUrl = this.activeTab()?.url ?? "";
    const pipeline = bindWebRequestPipeline(session, {
      getSettings: () => this.config,
      activeTabUrl: () => {
        // 活动页签优先；退化为最近记录的 URL
        const cur = this.activeTab()?.url;
        if (cur) this.lastActiveTabUrl = cur;
        return this.lastActiveTabUrl;
      },
      extBridge: {
        maybeDispatch: (url, rtDnr, details, cb) => this.usChain.maybeDispatchWr(url, rtDnr, details, cb),
      },
      onUserJs: (url) => this.usChain.onUserJsNavigation(url, "mainFrame"),
    });
    this.pipelinePartition = partition;
    this.unbindPipeline = () => pipeline.unbind();
  }

  /** DNR 规则引擎惰性加载（AdGuard 扩展自带 35 万条规则集）。 */
  private wakeDnrEngine(): void {
    const dir = this.extHost.findAdGuardDir();
    if (dir) void dnrBlocker.load(dir);
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
        // 关键：为已原生加载（有 electronId）的扩展创建 isolated world，
        // 让 content script 拿到真实 chrome.* 绑定 —— 不做这步 cs-runtime 等于没接。
        this.extHost.ensureCsRuntime(webview);
        // chrome.userScripts 适配层：命中 URL 的已注册用户脚本注入扩展世界
        if (this.config.extensionsEnabled) void this.usInjector.injectForPage(webview, url);
        void this.extHost.injectDocumentEnd(webview as never, url);
        // chrome-extension:// 整页（popup/options 直开为页签）需要扩展专属世界垫片，
        // 否则页面脚本在受限主世界 sendMessage/storage 全失败（AdGuard 永远 loading）。
        if (/^chrome-extension:\/\//i.test(url)) {
          void this.extHost.injectExtensionPage(webview, url);
        }
        // Edge 加载项商店：注入"安装到 Obsidian"按钮（点击经 ob-edge-install 回传 id）
        if (this.config.extensionsEnabled && isEdgeAddonsSiteUrl(url)) {
          void webview
            .executeJavaScript(
              buildEdgeStoreHelperScript({
                install: "安装到 Obsidian",
                installing: "安装中…",
                installed: "已安装",
              }),
            )
            .catch(() => {
              /* guest gone */
            });
        }
      },

      onEdgeInstall: (id: string, webview: IWebviewTag) => {
        void this.extHost.installFromEdgeAddons(id).then((r) => {
          new Notice(r.ok ? `扩展已安装：${r.ext?.name ?? id}` : `安装失败：${r.error ?? id}`);
          // 回写页面按钮状态（"安装中…" → "已安装"/复位），见 edgeStoreHelper
          try {
            void webview.executeJavaScript(
              `window.__obEdgeStoreSetState && window.__obEdgeStoreSetState(${JSON.stringify(r.ok ? "ok" : "idle")})`,
            );
          } catch {
            /* guest gone */
          }
        });
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
      startUrl: () => this.resolveStartUrl(),
    };
  }

  private buildPopupLayer(): void {
    if (this.popupLayer) return;
    this.popupLayer = new PopupLayer(
      this.extHost,
      () => this.activeTab()?.getWebview() ?? null,
      (msg) => new Notice(msg),
    );
    // 扩展 popup 设置齿轮（chrome.runtime.openOptionsPage → binding 桥 → extHost）→
    // 当前页签打开设置页
    this.extHost.onOpenOptionsPage = (rec) => {
      const url = this.extHost.optionsPageUrl(rec);
      if (!url) {
        new Notice(`扩展「${rec.name}」没有设置页`);
        return;
      }
      void this.openUrl(url, false);
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
  /**
   * 新标签页起点（思源 resolveStartUrl 同款）：配置了新标签页扩展（declare
   * chrome_url_overrides.newtab 且原生加载中）则开其 newtab 页，否则主页。
   */
  resolveStartUrl(): string {
    const id = this.config.newTabExtId;
    if (id) {
      const rec = this.store.data.extensions.find((r) => (r.dir === id || r.id === id) && r.enabled && r.electronId && r.newtab);
      if (rec) {
        return `chrome-extension://${rec.electronId}/${String(rec.newtab).replace(/^\/+/, "")}`;
      }
    }
    return this.config.homePage || "about:blank";
  }

  private activeBrowserView(): BrowserView | null {
    const active = this.app.workspace.activeLeaf;
    if (active?.view instanceof BrowserView) return active.view;
    return (this.browserLeaves()[0]?.view as BrowserView) ?? null;
  }

  private activeTab(): BrowserTab | null {
    return this.activeBrowserView()?.activeTab() ?? null;
  }

  private onTabChanged(tab: BrowserTab): void {
    // webNavigation.onCommitted 合成派发（TM 的 .user.js 安装检测依赖导航事件流）
    if (/^https?:\/\//i.test(tab.url)) void this.usChain.emitWebNavCommitted(tab.url);
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
      callback: () => void this.openUrl(this.resolveStartUrl(), true),
    });
    this.addCommand({
      id: "open-edge-addons",
      name: "打开 Edge 扩展集市",
      callback: () => void this.openUrl(EDGE_ADDONS_HOME, true),
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
        this.extPreloadUrl = toFileUrl(pathMod.join(dir, "ext-preload.js")); // 保留写盘：页面直开路径的兜底
        void this.extPreloadUrl;
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
