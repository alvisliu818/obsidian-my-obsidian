/** Bookmark entry persisted in the plugin data file. */
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  favicon?: string;
  tags: string[];
  createdAt: number;
}

export interface HistoryEntry {
  url: string;
  title: string;
  favicon?: string;
  visitTime: number;
}

export type DownloadState = "in_progress" | "completed" | "canceled" | "interrupted";

export interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  /** Vault-relative path of the written file (empty until finished). */
  savePath: string;
  total: number;
  received: number;
  state: DownloadState;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export type SearchEngineId = "google" | "bing" | "baidu" | "duckduckgo" | "custom";
export type NewTabMode = "blank" | "home" | "search";
/**
 * `internal` — one Obsidian leaf holding N webviews with our own tab strip.
 * `native`   — one leaf per page, so Obsidian's own tab bar owns the tabs
 *              (drag to splits, Ctrl+W, workspace.json restore all come free).
 */
export type TabMode = "internal" | "native";

export interface BrowserSettings {
  /** URL loaded by the home button / new-tab page. */
  homePage: string;
  searchEngine: SearchEngineId;
  customSearchUrl: string;
  /** Session partition; change = fresh cookies. */
  partition: string;
  /** Empty = Electron default. */
  userAgent: string;

  recordHistory: boolean;
  historyLimit: number;
  /** Restore tabs that were open when Obsidian exited. */
  restoreSession: boolean;
  /** internal = our own strip, native = one Obsidian leaf per page. */
  tabMode: TabMode;

  /** Clicking an http(s) link anywhere in Obsidian opens it in the browser view. */
  interceptAllLinks: boolean;
  /** Newline separated host patterns that must stay in the system browser. */
  excludedSites: string;

  adBlockEnabled: boolean;
  /** Extra Adblock `##` element-hiding rules. */
  adBlockRules: string;

  /** Vault-relative folder for downloads. */
  downloadDir: string;

  /** Vault-relative folder for clipped pages. */
  clipFolder: string;
  clipTemplate: string;
  /** Download remote images into the vault and rewrite links. */
  clipAssets: boolean;
  clipTags: string;
  clipFrontmatter: boolean;
  /** Copy the clip to the clipboard in addition to creating the note. */
  clipAlsoCopy: boolean;

  extensionsEnabled: boolean;
}

/** A single Chrome-extension-shaped add-on installed into the plugin. */
export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Directory name under <pluginData>/extensions. */
  dir: string;
  enabled: boolean;
  installedAt: number;
  /** Parsed content scripts (MV2 + MV3 shapes). */
  contentScripts: ExtensionContentScript[];
  /** Icon path relative to the extension dir (may be empty). */
  icon?: string;
  /** browser_action / action popup html (may be empty). */
  popup?: string;
  permissions: string[];
}

export interface ExtensionContentScript {
  matches: string[];
  excludeMatches: string[];
  js: string[];
  css: string[];
  runAt: "document_start" | "document_end" | "document_idle";
  allFrames: boolean;
}

/** Persisted tab, used by the session restore feature. */
export interface PersistedTab {
  url: string;
  title: string;
  active: boolean;
}

export interface PluginData {
  settings: BrowserSettings;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: DownloadItem[];
  extensions: ExtensionRecord[];
  session: PersistedTab[];
}

/**
 * The subset of the Electron <webview> element API we use. Obsidian's main
 * window is created with `webviewTag: true`, so `document.createElement
 * ("webview")` yields a real guest — verified against Obsidian 1.14.4.
 */
export interface IWebviewTag extends HTMLElement {
  src: string;
  loadURL(url: string, options?: { userAgent?: string; httpReferrer?: string }): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  isLoading(): boolean;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  insertCSS(css: string): Promise<string>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): void;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  openDevTools(): void;
  getWebContentsId(): number;
  setUserAgent(ua: string): void;
  getUserAgent(): string;
  downloadURL(url: string): void;
  capturePage(): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
}

/** Context-menu payload handed to us by the <webview> `context-menu` event. */
export interface WebViewContextMenuParams {
  x: number;
  y: number;
  linkURL?: string;
  linkText?: string;
  srcURL?: string;
  pageURL: string;
  selectionText?: string;
  mediaType?: "image" | "video" | "audio" | "none";
  isEditable: boolean;
  hasImageContents?: boolean;
}
