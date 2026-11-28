import type { App } from "obsidian";
import type { BrowserSettings, IWebviewTag } from "../types";
import type { BookmarksStore } from "../storage/bookmarksStore";
import type { HistoryStore } from "../storage/historyStore";
import type { DownloadsStore } from "../storage/downloadsStore";
import type { BrowserTab } from "./BrowserTab";

/**
 * Everything a tab needs from the plugin. Keeps BrowserTab free of Plugin/App
 * plumbing so it stays testable and easy to reason about.
 */
export interface BrowserContext {
  app: App;
  getSettings(): BrowserSettings;
  bookmarks: BookmarksStore;
  history: HistoryStore;
  downloads: DownloadsStore;
  /** 网页标注控制器（标注/还原/浮窗/跳转/框选/改锚/取消显示）。 */
  annotation?: {
    create(webview: IWebviewTag, url: string, title: string, payload: { quote?: string; prefix?: string; suffix?: string; color?: string }): Promise<void>;
    openFloat(webview: IWebviewTag, url: string, payload: { id?: string; x?: number; y?: number; hover?: boolean }): Promise<void>;
    applyMeta(payload: { id?: string; color?: string; tags?: string[] }): Promise<void>;
    notifyMarkLeave(id: string): void;
    openListFloat(webview: IWebviewTag, url: string): Promise<void>;
    openDoc(url: string): Promise<void>;
    applyInlineVisibility(show?: boolean): void;
    /** 隐藏/显示当前页全部标注高亮（仅显示层）。 */
    toggleHighlights(webview: IWebviewTag, show?: boolean): Promise<boolean>;
    /** 取消高亮/取消小字（标注数据保留）。 */
    setDisplayOff(webview: IWebviewTag, url: string, payload: { kind?: string; id?: string; quote?: string; prefix?: string; suffix?: string }): Promise<void>;
    /** 框选完成：截屏落盘并创建/更新框选标注。 */
    onRectCaptured(webview: IWebviewTag, url: string, title: string, payload: { id?: string; rect?: { x: number; y: number; w: number; h: number }; vrect?: { x: number; y: number; w: number; h: number } }): Promise<void>;
    /** 文字改锚（换锚点文字，批注保持对应）。 */
    reanchorText(webview: IWebviewTag, url: string, payload: { id?: string; quote?: string; prefix?: string; suffix?: string }): Promise<void>;
    /** 开始框选（页内遮罩拖拽）。 */
    beginCapture(webview: IWebviewTag, url: string): void;
    /** 改锚模式：下一次选区的气泡出「改锚」按钮。 */
    beginReanchor(webview: IWebviewTag, id: string): void;
  };

  /** file:// URL of the preload script ('' when it is unavailable). */
  preloadUrl(): string;

  openInNewTab(url: string): void;
  /** Open in the currently active browser tab (opening the view if needed). */
  openUrl(url: string, newTab?: boolean): void;
  openInSystemBrowser(url: string): void;
  saveUrlToVault(url: string, suggestedName?: string): Promise<void>;
  /** 保存网页 MHTML 到自选位置(用户 2026-11-20)。 */
  savePageMhtml(tab: BrowserTab): Promise<void>;
  /** 复制右键命中元素为带样式 HTML(内联计算样式;用户 2026-11-20)。 */
  copyElementHtml(tab: BrowserTab, x: number, y: number): Promise<void>;
  excerpt(tab: BrowserTab, mode: "article" | "selection"): Promise<void>;

  /** Injection hook (ad-filter CSS + content scripts). */
  onDomReady(webview: IWebviewTag, url: string): void;
  /** Content scripts that must run before the page's own scripts. */
  extensionStartPayload(url: string): { css: string[]; js: string[] };

  /** 页面把自身导航到一个 .user.js —— 拦下并打开原生安装对话框。 */
  onUserScriptNavigate?(url: string): void;
  /** 用户脚本的 GM_xmlhttpRequest IPC 桥（ob-us-request）。 */
  onUserScriptRequest?(req: { rid: string; params: { method: string; url: string; headers: Record<string, string> | null; body: string | null } }, webview: unknown): void;

  extensionIcons(): { id: string; name: string; icon: string }[];
  onExtensionClick(id: string, anchor: HTMLElement): void;

  /** Tab title/url/favicon changed — the view redraws its tab strip. */
  notifyTabChanged(tab: BrowserTab): void;
  /** The page wants a brand new tab (target=_blank / window.open). */
  requestNewTab(url: string): void;

  /** Tabs persisted from the previous session (empty when restore is off). */
  initialTabs?(): { url: string; title: string; active: boolean }[];
  saveSession(tabs: { url: string; title: string; active: boolean }[]): void;

  /** Persist the settings object after in-place mutation (annotation toggle). */
  saveSettings?(): void;
  /** 新标签页起始 URL（新标签页扩展优先，回落主页）。 */
  startUrl?(): string;
  /** Edge 加载项安装（商店页按钮 / 协议导航 / CRX 直链）。 */
  onEdgeInstall?(id: string): void;

  /** Subscribe to data changes; returns the unsubscribe function. */
  onDataChange(fn: () => void): () => void;
  /** URL of the active browser tab ('' when the view is closed). */
  currentUrl?(): string;
}
