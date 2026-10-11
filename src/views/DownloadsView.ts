import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_DOWNLOADS } from "../constants";
import type { BrowserContext } from "../browser/context";
import type { DownloadItem } from "../types";
import { formatBytes, formatTime } from "../utils/url";
import { showItemInFolder, vaultBasePath } from "../utils/electron";

/** Downloads dock: live progress, open in Obsidian / in Explorer, cleanup. */
export class DownloadsView extends ItemView {
  private listEl!: HTMLDivElement;
  private unsub: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private ctx: BrowserContext) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DOWNLOADS;
  }

  getDisplayText(): string {
    return "浏览器下载";
  }

  getIcon(): string {
    return "download";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ob-dock");

    const bar = root.createDiv({ cls: "ob-dock-bar" });
    const clear = bar.createEl("button", { cls: "ob-dock-btn" });
    clear.setAttribute("aria-label", "清除已完成");
    setIcon(clear, "eraser");
    clear.addEventListener("click", () => this.ctx.downloads.clearCompleted());

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
    const items = this.ctx.downloads.list();
    if (!items.length) {
      this.listEl.createDiv({ cls: "ob-dock-empty", text: "还没有下载" });
      return;
    }
    for (const d of items) this.listEl.appendChild(this.row(d));
  }

  private row(d: DownloadItem): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "ob-dock-item ob-download";

    const icon = document.createElement("span");
    icon.className = "ob-dock-favicon";
    setIcon(icon, d.state === "completed" ? "file-check" : d.state === "in_progress" ? "loader" : "file-warning");
    row.appendChild(icon);

    const text = document.createElement("div");
    text.className = "ob-dock-text";
    text.createDiv({ cls: "ob-dock-title", text: d.filename });

    const pct = d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
    if (d.state === "in_progress") {
      const bar = document.createElement("div");
      bar.className = "ob-progress";
      const fill = document.createElement("div");
      fill.className = "ob-progress-fill";
      fill.style.width = `${d.total ? pct : 100}%`;
      bar.appendChild(fill);
      text.appendChild(bar);
      text.createDiv({
        cls: "ob-dock-sub",
        text: d.total ? `${formatBytes(d.received)} / ${formatBytes(d.total)} (${pct}%)` : formatBytes(d.received),
      });
    } else {
      const state = d.state === "completed" ? "已完成" : d.state === "canceled" ? "已取消" : "已中断";
      text.createDiv({
        cls: "ob-dock-sub",
        text: `${state} · ${formatBytes(d.total || d.received)} · ${formatTime(d.finishedAt || d.startedAt)}`,
      });
    }
    row.appendChild(text);

    row.addEventListener("click", () => {
      if (d.state === "completed" && d.savePath) void this.openFile(d.savePath);
    });
    row.addEventListener("contextmenu", (e) => {
      const menu = new Menu();
      if (d.state === "completed" && d.savePath) {
        menu.addItem((i) => i.setTitle("打开").setIcon("file").onClick(() => void this.openFile(d.savePath)));
        menu.addItem((i) =>
          i.setTitle("在文件管理器中显示").setIcon("folder-open").onClick(() => {
            const abs = vaultBasePath(this.ctx.app) + "/" + d.savePath;
            if (!showItemInFolder(abs)) new Notice("无法显示：" + abs);
          }),
        );
        menu.addSeparator();
      }
      menu.addItem((i) => i.setTitle("复制链接").setIcon("link").onClick(() => void navigator.clipboard.writeText(d.url)));
      menu.addItem((i) => i.setTitle("在新标签页打开来源").setIcon("external-link").onClick(() => this.ctx.openUrl(d.url, true)));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("从列表移除").setIcon("trash").onClick(() => this.ctx.downloads.remove(d.id)));
      menu.showAtMouseEvent(e);
    });
    return row;
  }

  private async openFile(path: string): Promise<void> {
    const file = this.ctx.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice("文件已不存在：" + path);
      return;
    }
    await this.ctx.app.workspace.getLeaf(false).openFile(file as never);
  }
}
