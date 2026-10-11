import type { BrowserSettings, PluginData } from "./types";

export const VIEW_TYPE_BROWSER = "obsidian-browser-view";
export const VIEW_TYPE_BOOKMARKS = "obsidian-browser-bookmarks";
export const VIEW_TYPE_HISTORY = "obsidian-browser-history";
export const VIEW_TYPE_DOWNLOADS = "obsidian-browser-downloads";

export const PLUGIN_ID = "obsidian-browser";
export const BROWSER_ICON = "globe";

/** History entries are merged (not duplicated) inside this window. */
export const HISTORY_DEDUP_WINDOW = 10 * 60 * 1000;
export const HISTORY_HARD_LIMIT = 50000;
/** Same URL opened as a new tab from several signals inside this window = once. */
export const NEW_TAB_DEDUP_WINDOW = 2000;
/** How often we ping the guest to see whether it is still alive. */
export const HEALTH_CHECK_INTERVAL = 2000;
export const HEALTH_FAIL_STREAK = 2;

export const SEARCH_ENGINES: { id: string; name: string; url: string }[] = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q={q}" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q={q}" },
  { id: "baidu", name: "百度", url: "https://www.baidu.com/s?wd={q}" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}" },
];

export const DEFAULT_CLIP_TEMPLATE =
  "---\n" +
  "title: ${title}\n" +
  "source: ${url}\n" +
  "author: ${byline}\n" +
  "site: ${siteName}\n" +
  "clipped: ${date} ${time}\n" +
  "tags:\n" +
  "${tags}\n" +
  "---\n\n" +
  "# ${title}\n\n" +
  "> [${url}](${url})\n\n" +
  "${content}\n";

export const DEFAULT_SETTINGS: BrowserSettings = {
  homePage: "https://www.bing.com",
  searchEngine: "bing",
  customSearchUrl: "",
  partition: "persist:obsidian-browser",
  userAgent: "",

  recordHistory: true,
  historyLimit: 5000,
  restoreSession: true,

  interceptAllLinks: true,
  excludedSites: "",

  adBlockEnabled: true,
  adBlockRules: "",

  downloadDir: "Browser/Downloads",

  clipFolder: "Browser/Clippings",
  clipTemplate: DEFAULT_CLIP_TEMPLATE,
  clipAssets: true,
  clipTags: "clipping",
  clipFrontmatter: true,
  clipAlsoCopy: false,

  extensionsEnabled: true,
};

export const DEFAULT_DATA: PluginData = {
  settings: { ...DEFAULT_SETTINGS },
  bookmarks: [],
  history: [],
  downloads: [],
  extensions: [],
  session: [],
};
