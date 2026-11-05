import { ItemView, Menu, setIcon, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_BOOKMARKS } from "../constants";
import type { BrowserContext } from "../browser/context";
import type { Bookmark } from "../types";
import { prettyUrl } from "../utils/url";
import { copyText } from "../utils/dom";

/** Bookmarks dock: tag groups, search, and quick "bookmark current page". */
export class BookmarksView extends ItemView {
  private keyword = "";
  private listEl!: HTMLDivElement;
  private searchEl!: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, private ctx: BrowserContext) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BOOKMARKS;
  }

  getDisplayText(): string {
    return "浏览器书签";
  }

  getIcon(): string {
    return "star";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ob-dock");

    const bar = root.createDiv({ cls: "ob-dock-bar" });
    this.searchEl = bar.createEl("input", { cls: "ob-dock-search", type: "text" });
    this.searchEl.placeholder = "搜索书签";
    this.searchEl.addEventListener("input", () => {
      this.keyword = this.searchEl.value;
      this.render();
    });

    const add = bar.createEl("button", { cls: "ob-dock-btn" });
    add.setAttribute("aria-label", "书签当前页面");
    setIcon(add, "star");
    add.addEventListener("click", () => {
      const url = this.ctx.currentUrl?.();
      if (url) {
        this.ctx.bookmarks.toggle({ title: url, url });
        this.render();
      }
    });

    this.listEl = root.createDiv({ cls: "ob-dock-list" });
    this.render();
    this.unsub = this.ctx.onDataChange(() => this.render());
  }

  async onClose(): Promise<void> {
    this.unsub?.();
  }

  private unsub: (() => void) | null = null;

  /** Data-driven redraw (the stores notify through the plugin). */
  render(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const items = this.ctx.bookmarks.search(this.keyword);

    if (!items.length) {
      this.listEl.createDiv({ cls: "ob-dock-empty", text: this.keyword ? "没有匹配的书签" : "还没有书签" });
      return;
    }

    if (this.keyword) {
      for (const b of items) this.listEl.appendChild(this.row(b));
      return;
    }

    for (const [tag, group] of this.ctx.bookmarks.groupByTag()) {
      const head = this.listEl.createDiv({ cls: "ob-dock-group" });
      head.setText(tag);
      for (const b of group) this.listEl.appendChild(this.row(b));
    }
  }

  private row(b: Bookmark): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "ob-dock-item";

    if (b.favicon) {
      const img = document.createElement("img");
      img.className = "ob-dock-favicon";
      img.src = b.favicon;
      row.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "ob-dock-favicon";
      setIcon(ph, "link");
      row.appendChild(ph);
    }

    const text = document.createElement("div");
    text.className = "ob-dock-text";
    text.createDiv({ cls: "ob-dock-title", text: b.title || b.url });
    text.createDiv({ cls: "ob-dock-sub", text: prettyUrl(b.url) });
    row.appendChild(text);

    row.addEventListener("click", () => this.ctx.openUrl(b.url, false));
    row.addEventListener("contextmenu", (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("打开").setIcon("arrow-right").onClick(() => this.ctx.openUrl(b.url, false)));
      menu.addItem((i) => i.setTitle("在新标签页打开").setIcon("external-link").onClick(() => this.ctx.openUrl(b.url, true)));
      menu.addItem((i) => i.setTitle("在系统中打开").setIcon("globe").onClick(() => this.ctx.openInSystemBrowser(b.url)));
      menu.addItem((i) => i.setTitle("复制链接").setIcon("link").onClick(() => void copyText(b.url)));
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("编辑标题").setIcon("pencil").onClick(() => {
          const next = window.prompt("书签标题", b.title);
          if (next !== null) {
            this.ctx.bookmarks.update(b.id, { title: next || b.url });
            this.render();
          }
        }),
      );
      menu.addItem((i) => i.setTitle("删除").setIcon("trash").onClick(() => this.ctx.bookmarks.remove(b.id)));
      menu.showAtMouseEvent(e);
    });
    return row;
  }
}
