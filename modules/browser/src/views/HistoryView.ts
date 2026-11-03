import { ItemView, Menu, setIcon, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_HISTORY } from "../constants";
import type { BrowserContext } from "../browser/context";
import type { HistoryEntry } from "../types";
import { formatDateKey, formatTime, prettyUrl } from "../utils/url";
import { copyText } from "../utils/dom";

/** History dock: today / yesterday / last 7 days / earlier, with search. */
export class HistoryView extends ItemView {
  private keyword = "";
  private listEl!: HTMLDivElement;
  private unsub: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private ctx: BrowserContext) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_HISTORY;
  }

  getDisplayText(): string {
    return "浏览器历史";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ob-dock");

    const bar = root.createDiv({ cls: "ob-dock-bar" });
    const search = bar.createEl("input", { cls: "ob-dock-search", type: "text" });
    search.placeholder = "搜索历史";
    search.addEventListener("input", () => {
      this.keyword = search.value;
      this.render();
    });

    const clear = bar.createEl("button", { cls: "ob-dock-btn" });
    clear.setAttribute("aria-label", "清空历史");
    setIcon(clear, "trash");
    clear.addEventListener("click", () => {
      if (window.confirm("清空全部浏览历史？")) this.ctx.history.clear();
    });

    this.listEl = root.createDiv({ cls: "ob-dock-list" });
    this.render();
    this.unsub = this.ctx.onDataChange(() => this.render());
  }

  async onClose(): Promise<void> {
    this.unsub?.();
  }

  render(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const entries = this.ctx.history.search(this.keyword);
    if (!entries.length) {
      this.listEl.createDiv({ cls: "ob-dock-empty", text: this.keyword ? "没有匹配的历史" : "还没有浏览记录" });
      return;
    }

    if (this.keyword) {
      for (const h of entries) this.listEl.appendChild(this.row(h));
      return;
    }

    for (const group of this.ctx.history.groupByDate(entries)) {
      this.listEl.createDiv({ cls: "ob-dock-group", text: group.label });
      for (const h of group.entries) this.listEl.appendChild(this.row(h));
    }
  }

  private row(h: HistoryEntry): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "ob-dock-item";

    if (h.favicon) {
      const img = document.createElement("img");
      img.className = "ob-dock-favicon";
      img.src = h.favicon;
      row.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "ob-dock-favicon";
      setIcon(ph, "clock");
      row.appendChild(ph);
    }

    const text = document.createElement("div");
    text.className = "ob-dock-text";
    text.createDiv({ cls: "ob-dock-title", text: h.title || h.url });
    text.createDiv({ cls: "ob-dock-sub", text: `${prettyUrl(h.url)} · ${formatTime(h.visitTime)}` });
    row.appendChild(text);

    row.addEventListener("click", () => this.ctx.openUrl(h.url, false));
    row.addEventListener("contextmenu", (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("打开").setIcon("arrow-right").onClick(() => this.ctx.openUrl(h.url, false)));
      menu.addItem((i) => i.setTitle("在新标签页打开").setIcon("external-link").onClick(() => this.ctx.openUrl(h.url, true)));
      menu.addItem((i) => i.setTitle("复制链接").setIcon("link").onClick(() => void copyText(h.url)));
      menu.addItem((i) => i.setTitle("加入书签").setIcon("star").onClick(() => this.ctx.bookmarks.toggle({ title: h.title, url: h.url })));
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("清除当天记录").setIcon("trash").onClick(() => this.ctx.history.clearByDate(formatDateKey(h.visitTime))),
      );
      menu.addItem((i) => i.setTitle("删除此条").setIcon("x").onClick(() => this.ctx.history.remove(h.url)));
      menu.showAtMouseEvent(e);
    });
    return row;
  }
}
