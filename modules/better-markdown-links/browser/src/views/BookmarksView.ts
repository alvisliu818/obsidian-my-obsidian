import { ItemView, Menu, Modal, setIcon, type App, type WorkspaceLeaf } from "obsidian";
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
    const titleRow = text.createDiv({ cls: "ob-dock-title" });
    titleRow.setText(b.title || b.url);
    for (const t of b.tags ?? []) {
      titleRow.createSpan({ cls: "ob-dock-tag", text: `#${t}` });
    }
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
        i.setTitle("编辑…").setIcon("pencil").onClick(() => {
          new BookmarkEditModal(this.app, b, (patch) => {
            this.ctx.bookmarks.update(b.id, patch);
            this.render();
          }).open();
        }),
      );
      menu.addItem((i) =>
        i.setTitle("添加标签…").setIcon("tag").onClick(() => {
          const next = window.prompt("标签（可留空）", (b.tags ?? []).join(", "));
          if (next !== null) {
            this.ctx.bookmarks.update(b.id, { tags: next.split(/[,，]/).map((t) => t.trim()).filter(Boolean) });
            this.render();
          }
        }),
      );
      for (const t of b.tags ?? []) {
        menu.addItem((i) =>
          i.setTitle(`移除标签：${t}`).setIcon("tag-off").onClick(() => {
            this.ctx.bookmarks.removeTag(b.id, t);
            this.render();
          }),
        );
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("删除").setIcon("trash").onClick(() => this.ctx.bookmarks.remove(b.id)));
      menu.showAtMouseEvent(e);
    });
    return row;
  }
}


/** 书签编辑弹窗（标题 / URL / 标签三字段，思源 promptDialog 的 Obsidian 形态）。 */
class BookmarkEditModal extends Modal {
  constructor(
    app: App,
    private bookmark: Bookmark,
    private onSave: (patch: Partial<Bookmark>) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: "编辑书签" });
    const row = (label: string, value: string): HTMLInputElement => {
      const wrap = this.contentEl.createDiv({ cls: "ob-edit-row" });
      wrap.createEl("label", { text: label });
      const input = wrap.createEl("input", { type: "text" });
      input.value = value;
      input.addClass("ob-edit-input");
      return input;
    };
    const title = row("标题", this.bookmark.title || "");
    const url = row("URL", this.bookmark.url);
    const tags = row("标签（逗号分隔）", (this.bookmark.tags ?? []).join(", "));
    const btns = this.contentEl.createDiv({ cls: "ob-edit-btns" });
    const save = (): void => {
      const tagList = tags.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      this.onSave({
        title: title.value.trim() || this.bookmark.url,
        url: url.value.trim() || this.bookmark.url,
        tags: tagList,
      });
      this.close();
    };
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const ok = btns.createEl("button", { text: "保存" });
    ok.addClass("mod-cta");
    ok.addEventListener("click", save);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
