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

  /** file:// URL of the preload script ('' when it is unavailable). */
  preloadUrl(): string;

  openInNewTab(url: string): void;
  /** Open in the currently active browser tab (opening the view if needed). */
  openUrl(url: string, newTab?: boolean): void;
  openInSystemBrowser(url: string): void;
  saveUrlToVault(url: string, suggestedName?: string): Promise<void>;
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

  /** Subscribe to data changes; returns the unsubscribe function. */
  onDataChange(fn: () => void): () => void;
  /** URL of the active browser tab ('' when the view is closed). */
  currentUrl?(): string;
}
