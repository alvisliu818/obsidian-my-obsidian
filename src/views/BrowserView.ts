import { ItemView, Menu, setIcon, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_BROWSER } from "../constants";
import { BrowserTab } from "../browser/BrowserTab";
import type { BrowserContext } from "../browser/context";
import { prettyUrl, isValidHttpUrl } from "../utils/url";
import { copyText } from "../utils/dom";

/**
 * The browser view: a tab strip plus one hidden or visible tab body.
 *
 * Obsidian has no notion of a plugin-owned tab type, so the strip is ours —
 * tabs are real BrowserTab instances kept in the DOM and merely hidden when
 * inactive (unloading them would throw away the page state).
 */
export class BrowserView extends ItemView {
  tabs: BrowserTab[] = [];
  activeId: string | null = null;

  private tabbar!: HTMLDivElement;
  private tabhost!: HTMLDivElement;
  private addBtn!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private ctx: BrowserContext) {
    super(leaf);
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

    this.renderTabbar();

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
    this.persistSession();
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
    const tab = new BrowserTab(this.ctx, url !== "about:blank" ? url : undefined);
    this.tabs.push(tab);
    this.tabhost.appendChild(tab.element);
    if (activate) this.activate(tab.id);
    else this.renderTabbar();
    return tab;
  }

  /** Open a URL: reuse the active tab, or open a fresh one. */
  openUrl(url: string, newTab = false): BrowserTab {
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
    // Obsidian caches the header; updating the text node directly is what the
    // native views do.
    const header = (this.leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
    const titleEl = header?.querySelector(".view-header-title");
    if (titleEl && this.getDisplayText()) titleEl.textContent = this.getDisplayText();
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
    menu.addItem((i) =>
      i.setTitle("新建标签页").setIcon("plus").onClick(() => this.newTab(this.ctx.getSettings().homePage, true)),
    );
    menu.addItem((i) => i.setTitle("关闭标签页").setIcon("x").onClick(() => this.activeId && this.closeTab(this.activeId)));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("摘录整页为笔记").setIcon("scissors").onClick(() => {
        const tab = this.activeTab();
        if (tab) void this.ctx.excerpt(tab, "article");
      }),
    );
  }
}
