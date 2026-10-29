import { ItemView, Menu, setIcon, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_BROWSER } from "../constants";
import { BrowserTab } from "../browser/BrowserTab";
import type { BrowserContext } from "../browser/context";
import { prettyUrl, isValidHttpUrl } from "../utils/url";
import { copyText } from "../utils/dom";

/**
 * The browser view, in two shapes:
 *
 * - **internal** (default): a tab strip we draw ourselves, N webviews in one
 *   leaf, hidden when inactive (unloading them would throw away page state).
 * - **native**: one leaf = one page. The strip is hidden and Obsidian's own tab
 *   bar takes over — drag to splits, Ctrl+W, and workspace.json restore all
 *   come from the host instead of being reimplemented here.
 */
export class BrowserView extends ItemView {
  tabs: BrowserTab[] = [];
  activeId: string | null = null;

  private tabbar!: HTMLDivElement;
  private tabhost!: HTMLDivElement;
  private addBtn!: HTMLButtonElement;
  /**
   * URL handed to us by the plugin when it creates the leaf. Needed because
   * Obsidian does not reliably call setState() before onOpen() for a NEW leaf
   * — so a state-only handoff silently loses the URL.
   */
  pendingUrl = "";

  constructor(leaf: WorkspaceLeaf, private ctx: BrowserContext) {
    super(leaf);
  }

  get isNative(): boolean {
    return this.ctx.getSettings().tabMode === "native";
  }

  getViewType(): string {
    return VIEW_TYPE_BROWSER;
  }

  getDisplayText(): string {
    const tab = this.activeTab();
    if (tab && tab.title && tab.url !== "about:blank") return tab.title.slice(0, 40);
    return "浏览器";
  }

  getIcon(): string {
    return "globe";
  }

  /** The URL stored on this leaf (view state), if Obsidian has set it yet. */
  private readLeafStateUrl(): string {
    const leaf = this.leaf as unknown as {
      getViewState?: () => { state?: { url?: string } };
      state?: { url?: string };
    };
    return leaf.getViewState?.()?.state?.url ?? leaf.state?.url ?? "";
  }

  /**
   * Native mode leans on Obsidian's view state: the URL lands in
   * workspace.json, so a restart restores every browser leaf with its page —
   * no session bookkeeping of our own.
   */
  getState(): Record<string, unknown> {
    return { url: this.tabs[0]?.url ?? "" };
  }

  async setState(state: unknown, _result: unknown): Promise<void> {
    const url = (state as { url?: string } | null)?.url ?? "";
    if (!url) return;
    this.pendingUrl = url;
    if (this.tabs[0]) await this.tabs[0].loadUrl(url);
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ob-browser-root");

    this.tabbar = root.createDiv({ cls: "ob-tabbar" });
    this.tabhost = root.createDiv({ cls: "ob-tabhost" });
    this.addBtn = this.tabbar.createEl("button", { cls: "ob-tab-add" });
    this.addBtn.setAttribute("aria-label", "新建标签页");
    setIcon(this.addBtn, "plus");
    this.addBtn.addEventListener("click", () => this.newTab("about:blank", true));
    // Native mode has no strip: the host's tab bar already shows the page.
    if (this.isNative) this.tabbar.style.display = "none";

    this.renderTabbar();

    if (this.isNative) {
      // URL comes from the leaf's view state (workspace restore) or from
      // setState(). Obsidian does NOT necessarily call setState before onOpen
      // when it creates a brand-new leaf, so read the state directly too.
      // The plugin's handoff wins; the leaf state covers a workspace restore.
      const initial = this.pendingUrl || this.readLeafStateUrl() || this.ctx.getSettings().homePage || "about:blank";
      this.pendingUrl = "";
      this.newTab(initial, true);
      // Obsidian can attach the state AFTER onOpen (workspace restore). If it
      // disagrees with what we loaded, follow the state.
      if (!this.pendingUrl) {
        setTimeout(() => {
          const later = this.readLeafStateUrl();
          if (later && this.tabs[0] && later !== this.tabs[0].url) void this.tabs[0].loadUrl(later);
        }, 0);
      }
      return;
    }

    // Restore last session, or start with the home page.
    const tabs = this.ctx.initialTabs?.() ?? null;
    if (tabs && tabs.length) {
      for (const t of tabs) this.newTab(t.url || "about:blank", false);
      const idx = tabs.findIndex((t) => t.active);
      if (idx >= 0 && this.tabs[idx]) this.activate(this.tabs[idx].id);
    } else {
      const home = this.ctx.getSettings().homePage || "about:blank";
      this.newTab(home, true);
    }
  }

  async onClose(): Promise<void> {
    // Native mode persists through workspace.json, not our own session list.
    if (!this.isNative) this.persistSession();
    for (const t of this.tabs) t.dispose();
    this.tabs = [];
  }

  private persistSession(): void {
    if (!this.ctx.getSettings().restoreSession) return;
    this.ctx.saveSession(
      this.tabs
        .filter((t) => t.url && t.url !== "about:blank")
        .map((t) => ({ url: t.url, title: t.title, active: t.id === this.activeId })),
    );
  }

  // ---------------- tabs ----------------

  newTab(url = "about:blank", activate = true): BrowserTab {
    // Native mode: one leaf holds exactly one page, so "new tab" means
    // "replace this page" here — a genuinely new tab is a new leaf.
    if (this.isNative && this.tabs.length) {
      const existing = this.tabs[0];
      if (url && url !== "about:blank") void existing.loadUrl(url);
      if (activate) this.activate(existing.id);
      return existing;
    }
    const tab = new BrowserTab(this.ctx, url !== "about:blank" ? url : undefined, !this.isNative);
    this.tabs.push(tab);
    this.tabhost.appendChild(tab.element);
    if (this.isNative) this.mountToolbarInHeader(tab);
    if (activate) this.activate(tab.id);
    else this.renderTabbar();
    return tab;
  }

  /** Open a URL: reuse the active tab, or open a fresh one. */
  openUrl(url: string, newTab = false): BrowserTab | null {
    // A new tab in native mode is a new Obsidian leaf — the plugin owns leaves.
    if (this.isNative && newTab) {
      this.ctx.requestNewTab(url);
      return null;
    }
    const target = newTab || !this.tabs.length ? this.newTab(url, true) : (this.activeTab() ?? this.newTab(url, true));
    if (!newTab && target) void target.loadUrl(url);
    return target;
  }

  activate(id: string): void {
    this.activeId = id;
    for (const t of this.tabs) {
      const on = t.id === id;
      t.element.style.display = on ? "flex" : "none";
      if (on) t.element.scrollIntoView();
    }
    this.renderTabbar();
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    this.updateTitle();
  }

  closeTab(id: string): void {
    // Native mode: closing the page means closing the Obsidian leaf (Ctrl+W
    // and the host's own close button land here too).
    if (this.isNative) {
      this.leaf.detach();
      return;
    }
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    tab.dispose();
    this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      if (next) this.activate(next.id);
      else {
        this.activeId = null;
        this.newTab(this.ctx.getSettings().homePage || "about:blank", true);
      }
    } else {
      this.renderTabbar();
    }
  }

  activeTab(): BrowserTab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? this.tabs[this.tabs.length - 1] ?? null;
  }

  async updateTitle(): Promise<void> {
    // Native mode: the header title element is detached and the toolbar lives
    // where the title was — nothing to patch.
    if (this.isNative) return;
    // Obsidian caches the header text; there is no public "refresh title" API,
    // so patch the node the native views use. `tabHeaderEl` is internal and
    // not always present — walking up to .workspace-leaf always works.
    const leaf = this.containerEl.closest(".workspace-leaf");
    const titleEl =
      (this.leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl?.querySelector(".view-header-title") ??
      leaf?.querySelector(".view-header-title");
    const text = this.getDisplayText();
    if (titleEl && text) titleEl.textContent = text;
  }

  // ---------------- native header toolbar ----------------

  /**
   * Native mode: mount the tab's toolbar in the leaf's own view header, the
   * way the core Web Viewer does — header always visible, title element
   * detached, toolbar taking the title container's place. The header lives
   * inside the leaf's containerEl, so it survives the leaf being dragged
   * between splits without re-mounting.
   */
  private mountToolbarInHeader(tab: BrowserTab): void {
    const tryMount = (): boolean => {
      const header = this.containerEl.querySelector(".view-header");
      if (!header) return false;
      header.addClass("view-header-always-show", "ob-browser-native-header");
      const titleContainer = header.querySelector(".view-header-title-container");
      const host = (titleContainer ?? header) as HTMLElement;
      host.empty();
      host.addClass("ob-browser-header-host");
      host.appendChild(tab.toolbar.element);
      return true;
    };
    if (!tryMount()) setTimeout(() => tryMount(), 0);
  }

  // ---------------- tab strip ----------------

  renderTabbar(): void {
    // Keep the "+" button, drop the tab chips.
    this.tabbar.querySelectorAll(".ob-tab").forEach((n) => n.remove());
    for (const tab of this.tabs) {
      const chip = document.createElement("div");
      chip.className = "ob-tab" + (tab.id === this.activeId ? " is-active" : "");
      chip.setAttribute("data-tab-id", tab.id);

      if (tab.favicon) {
        const img = document.createElement("img");
        img.className = "ob-tab-favicon";
        img.src = tab.favicon;
        chip.appendChild(img);
      } else {
        const ph = document.createElement("span");
        ph.className = "ob-tab-favicon";
        setIcon(ph, "globe");
        chip.appendChild(ph);
      }

      const label = document.createElement("span");
      label.className = "ob-tab-title";
      label.textContent = tab.title || "新标签页";
      label.title = (tab.title || "") + "\n" + prettyUrl(tab.url);
      chip.appendChild(label);

      const close = document.createElement("button");
      close.className = "ob-tab-close";
      close.setAttribute("aria-label", "关闭标签页");
      setIcon(close, "x");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });
      chip.appendChild(close);

      chip.addEventListener("click", () => this.activate(tab.id));
      chip.addEventListener("contextmenu", (e) => this.tabMenu(e, tab));
      chip.addEventListener("auxclick", (e) => {
        if ((e as MouseEvent).button === 1) {
          e.preventDefault();
          this.closeTab(tab.id);
        }
      });

      this.tabbar.insertBefore(chip, this.addBtn);
    }
  }

  private tabMenu(e: MouseEvent, tab: BrowserTab): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("重新加载").setIcon("refresh-cw").onClick(() => tab.reload(false)));
    menu.addItem((i) => i.setTitle("复制链接").setIcon("link").onClick(() => void copyText(tab.url)));
    menu.addItem((i) => i.setTitle("加入书签").setIcon("star").onClick(() => this.ctx.bookmarks.toggle({ title: tab.title, url: tab.url })));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("在新标签页中打开").setIcon("external-link").onClick(() => this.newTab(tab.url, true)));
    if (isValidHttpUrl(tab.url)) {
      menu.addItem((i) => i.setTitle("在系统浏览器中打开").setIcon("globe").onClick(() => this.ctx.openInSystemBrowser(tab.url)));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("关闭标签页").setIcon("x").onClick(() => this.closeTab(tab.id)));
    menu.showAtMouseEvent(e);
  }

  onPaneMenu(menu: Menu, _source: string): void {
    const home = this.ctx.getSettings().homePage;
    menu.addItem((i) =>
      i.setTitle("新建标签页").setIcon("plus").onClick(() => {
        // Native mode asks the plugin for a new leaf; internal adds a chip.
        if (this.isNative) this.ctx.requestNewTab(home);
        else this.newTab(home, true);
      }),
    );
    menu.addItem((i) =>
      i
        .setTitle("关闭标签页")
        .setIcon("x")
        .onClick(() => (this.activeId ? this.closeTab(this.activeId) : this.leaf.detach())),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("摘录整页为笔记").setIcon("scissors").onClick(() => {
        const tab = this.activeTab();
        if (tab) void this.ctx.excerpt(tab, "article");
      }),
    );
  }
}
