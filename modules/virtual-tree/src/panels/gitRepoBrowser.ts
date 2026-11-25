/**
 * Git 仓库浏览器（GitHub / Gitee 挂载的独立面板，2026-11-25 用户需求）。
 *
 * 背景：移动端没有统一的桌面侧栏/文件浏览器接管，GitHub/Gitee 挂载虽然能在
 * 挂载面板里列出来，但「打开文件」依赖 MD Editor 的存在；独立仓库浏览器把
 * 浏览 + 只读预览放进一个主区标签页，移动端可直接全屏使用，也能在没装
 * MD Editor 的移动端组合包里独立工作。
 *
 * 交互：
 *   - 目录行点击展开/折叠（逐层调用 gitListDir，不整树预载）；
 *   - 文件行点击在本面板内只读预览（Markdown 渲染 / 文本 pre / 二进制提示）；
 *   - 「用编辑器打开」把文件交给统一的 openExternalEntry 路由（有块编辑器/
 *     代码编辑器时进编辑器，没有时给出提示）。
 *
 * 面板身份用挂载 id（workspace 落盘可恢复）；挂载被删后显示空态而不是报错。
 */

import {
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  setIcon,
  type WorkspaceLeaf,
} from "obsidian";
import type VirtualTreePlugin from "../main";
import {
  isRemoteMount,
  mountDisplayName,
  type ExternalMount,
} from "../types";
import { clearGitRepoCache, gitDownloadFile, gitListDir } from "../features/gitRepoApi";
import { gitRepoShortName, gitRepoWebUrl, isGitRepoPath } from "../features/gitRepoPath";
import { isMarkdownFile, isTextFileName, type MountNode } from "../features/mountFilter";

export const VIEW_TYPE_GIT_REPO_BROWSER = "logseq-git-repo-browser";

/** 预览上限：超过就不把整份文件读进内存（二进制/超大文件交给编辑器）。 */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** 文本类预览的后备扩展名（与代码编辑器覆盖面基本一致）。 */
const TEXT_LIKE_EXT = new Set([
  "txt", "text", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini",
  "conf", "cfg", "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs",
  "jsx", "ts", "tsx", "vue", "svelte", "py", "rb", "go", "rs", "java", "kt", "c",
  "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql",
  "lua", "r", "dart", "swift", "scala", "clj", "ex", "exs", "erl", "hs", "ml",
  "gitignore", "env", "dockerfile", "makefile", "gradle", "properties", "lock",
]);

interface PreviewState {
  node: MountNode;
  status: "loading" | "ok" | "error";
  text?: string;
  error?: string;
  kind?: "markdown" | "text" | "binary";
}

export class GitRepoBrowserView extends ItemView {
  plugin: VirtualTreePlugin;
  private mountId = "";
  /** 已展开的目录（虚拟路径）。 */
  private readonly expanded = new Set<string>();
  /** 每个已加载目录的子项（虚拟路径 → 子项）。 */
  private readonly children = new Map<string, MountNode[]>();
  private readonly loading = new Set<string>();
  private readonly errors = new Map<string, string>();
  private preview: PreviewState | null = null;
  /** 打开/切换挂载时递增，异步结果回来时对不上就丢弃（防串台）。 */
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, plugin: VirtualTreePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_GIT_REPO_BROWSER;
  }

  getDisplayText(): string {
    const mount = this.mount();
    return mount ? `仓库：${mount.label || gitRepoShortName(mount.path)}` : "Git 仓库浏览器";
  }

  getIcon(): string {
    return "git-branch";
  }

  getState(): Record<string, unknown> {
    return { mountId: this.mountId };
  }

  async setState(state: unknown): Promise<void> {
    const s = state as { mountId?: unknown } | null | undefined;
    this.mountId = typeof s?.mountId === "string" ? s.mountId : "";
    this.resetTree();
    this.render();
  }

  async onOpen(): Promise<void> {
    this.render();
    if (!this.mountId) {
      const first = this.gitMounts()[0];
      if (first) {
        this.mountId = first.id;
        this.render();
      }
    }
  }

  async onClose(): Promise<void> {
    this.children.clear();
    this.loading.clear();
    this.errors.clear();
    this.expanded.clear();
    this.preview = null;
  }

  // ------------------------------------------------------------------
  // 数据
  // ------------------------------------------------------------------

  private gitMounts(): ExternalMount[] {
    return (this.plugin.settings.externalMounts ?? []).filter(
      (m) => m.enabled && isGitRepoPath(m.path) && isRemoteMount(m),
    );
  }

  private mount(): ExternalMount | null {
    const mounts = this.gitMounts();
    return mounts.find((m) => m.id === this.mountId) ?? null;
  }

  private resetTree(): void {
    this.generation++;
    this.expanded.clear();
    this.children.clear();
    this.loading.clear();
    this.errors.clear();
    this.preview = null;
  }

  private async loadDir(vPath: string): Promise<void> {
    if (this.children.has(vPath) || this.loading.has(vPath)) return;
    const gen = this.generation;
    this.loading.add(vPath);
    this.errors.delete(vPath);
    this.render();
    try {
      const list = await gitListDir(vPath);
      if (gen !== this.generation) return;
      this.children.set(vPath, list);
    } catch (e) {
      if (gen !== this.generation) return;
      this.errors.set(vPath, String((e as Error)?.message || e));
    } finally {
      if (gen === this.generation) {
        this.loading.delete(vPath);
        this.render();
      }
    }
  }

  /** 外部刷新入口（挂载重扫 / 设置变化后重绘并重读远端）。 */
  refresh(): void {
    this.generation++;
    this.children.clear();
    this.loading.clear();
    this.errors.clear();
    this.preview = null;
    this.render();
  }

  /** 切换仓库（面板内的挂载选择器）。 */
  private switchMount(id: string): void {
    if (!id || id === this.mountId) return;
    this.mountId = id;
    this.resetTree();
    this.render();
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vt-gitrepo-browser");

    const mount = this.mount();
    this.renderHeader(mount, contentEl);

    if (!mount) {
      const empty = contentEl.createDiv({ cls: "vt-gitrepo-browser__empty" });
      empty.createDiv({ text: "这个面板指向的 Git 仓库挂载不存在（可能已卸载）。" });
      const mounts = this.gitMounts();
      if (mounts.length > 0) {
        empty.createDiv({ text: "选择其他仓库挂载：" });
        const list = empty.createDiv({ cls: "vt-gitrepo-browser__mountlist" });
        for (const m of mounts) {
          const row = list.createDiv({ cls: "vt-gitrepo-browser__mountrow", text: mountDisplayName(m) });
          row.addEventListener("click", () => this.switchMount(m.id));
        }
      } else {
        empty.createDiv({ text: "先在挂载面板里添加 GitHub / Gitee 仓库挂载。" });
      }
      return;
    }

    if (this.preview) {
      this.renderPreview(mount, this.preview, contentEl);
      return;
    }

    const body = contentEl.createDiv({ cls: "vt-gitrepo-browser__tree" });
    if (!this.children.has(mount.path)) {
      void this.loadDir(mount.path);
    }
    this.renderLevel(mount, mount.path, 0, body);

    const rootErr = this.errors.get(mount.path);
    if (rootErr) {
      const err = body.createDiv({ cls: "vt-gitrepo-browser__error" });
      err.createDiv({ text: "加载失败：" });
      err.createDiv({ text: rootErr });
    }
  }

  private renderHeader(mount: ExternalMount | null, container: HTMLElement): void {
    const head = container.createDiv({ cls: "vt-gitrepo-browser__header" });
    const titleWrap = head.createDiv({ cls: "vt-gitrepo-browser__titlewrap" });
    const icon = titleWrap.createSpan({ cls: "vt-gitrepo-browser__icon" });
    setIcon(icon, "git-branch");
    const title = titleWrap.createDiv({ cls: "vt-gitrepo-browser__title" });
    title.setText(mount ? gitRepoShortName(mount.path) : "Git 仓库浏览器");
    title.setAttribute("title", mount ? mount.path : "");

    const actions = head.createDiv({ cls: "vt-gitrepo-browser__actions" });
    const btn = (iconName: string, label: string, onClick: () => void): void => {
      const b = actions.createEl("button", { cls: "vt-gitrepo-browser__btn", attr: { "aria-label": label, title: label } });
      setIcon(b, iconName);
      b.addEventListener("click", onClick);
    };

    const mounts = this.gitMounts();
    if (mounts.length > 1) {
      const select = actions.createEl("select", { cls: "vt-gitrepo-browser__mountselect" });
      for (const m of mounts) {
        const opt = select.createEl("option", { text: mountDisplayName(m) });
        opt.value = m.id;
        if (m.id === this.mountId) opt.selected = true;
      }
      select.addEventListener("change", () => this.switchMount(select.value));
    }
    if (mount) {
      btn("refresh-cw", "重新拉取（清远端缓存）", () => {
        clearGitRepoCache();
        const root = mount.path;
        this.children.delete(root);
        this.loading.delete(root);
        this.errors.delete(root);
        this.render();
      });
      btn("arrow-up-right", "在 GitHub/Gitee 中打开", () => {
        const url = gitRepoWebUrl(mount.path, true);
        if (url) window.open(url, "_blank");
      });
    }
    if (this.preview) {
      btn("arrow-left", "返回文件列表", () => {
        this.preview = null;
        this.render();
      });
    }
  }

  private renderLevel(mount: ExternalMount, parentVPath: string, depth: number, container: HTMLElement): void {
    const list = this.children.get(parentVPath);
    if (!list) {
      if (this.loading.has(parentVPath)) {
        container.createDiv({ cls: "vt-gitrepo-browser__loading", text: "加载中…" });
      }
      return;
    }
    if (list.length === 0) {
      if (depth === 0) container.createDiv({ cls: "vt-gitrepo-browser__empty", text: "空仓库或空目录。" });
      return;
    }
    for (const node of list) {
      this.renderRow(node, depth, container);
      if (node.isDir && this.expanded.has(node.abs)) {
        this.renderLevel(mount, node.abs, depth + 1, container);
      }
    }
  }

  private renderRow(node: MountNode, depth: number, container: HTMLElement): void {
    const row = container.createDiv({ cls: "vt-gitrepo-browser__row" });
    row.style.paddingLeft = `${8 + depth * 16}px`;
    const iconEl = row.createSpan({ cls: "vt-gitrepo-browser__rowicon" });
    if (node.isDir) {
      setIcon(iconEl, this.expanded.has(node.abs) ? "chevron-down" : "chevron-right");
    } else {
      setIcon(iconEl, isMarkdownFile(node.name) ? "file-text" : "file");
    }
    const name = row.createSpan({ cls: "vt-gitrepo-browser__rowname", text: node.name });
    name.setAttribute("title", node.rel);
    if (node.isDir) {
      row.addEventListener("click", () => {
        if (this.expanded.has(node.abs)) {
          this.expanded.delete(node.abs);
          this.render();
          return;
        }
        this.expanded.add(node.abs);
        void this.loadDir(node.abs);
        this.render();
      });
      return;
    }
    row.addEventListener("click", () => void this.openPreview(node));
  }

  private async openPreview(node: MountNode): Promise<void> {
    this.preview = { node, status: "loading" };
    this.render();
    const gen = this.generation;
    try {
      const bytes = await gitDownloadFile(node.abs);
      if (gen !== this.generation) return;
      if (bytes.byteLength > PREVIEW_MAX_BYTES) {
        this.preview = { node, status: "error", error: "文件超过 2MB，未加载预览；请用编辑器打开。" };
        this.render();
        return;
      }
      const ext = (node.name.split(".").pop() ?? "").toLowerCase();
      const markdown = isMarkdownFile(node.name);
      const textLike = markdown || isTextFileName(node.name) || TEXT_LIKE_EXT.has(ext);
      if (!textLike) {
        this.preview = { node, status: "ok", kind: "binary" };
        this.render();
        return;
      }
      const text = new TextDecoder("utf-8").decode(bytes);
      this.preview = { node, status: "ok", text, kind: markdown ? "markdown" : "text" };
    } catch (e) {
      if (gen !== this.generation) return;
      this.preview = { node, status: "error", error: String((e as Error)?.message || e) };
    }
    this.render();
  }

  private renderPreview(mount: ExternalMount, preview: PreviewState, container: HTMLElement): void {
    const body = container.createDiv({ cls: "vt-gitrepo-browser__preview" });
    const bar = body.createDiv({ cls: "vt-gitrepo-browser__previewbar" });
    const path = bar.createDiv({ cls: "vt-gitrepo-browser__previewpath", text: preview.node.rel });
    path.setAttribute("title", preview.node.abs);
    const edit = bar.createEl("button", { cls: "mod-cta", text: "用编辑器打开" });
    edit.addEventListener("click", () => {
      void this.plugin.openExternalEntry(mount, preview.node);
    });

    const content = body.createDiv({ cls: "vt-gitrepo-browser__previewbody" });
    if (preview.status === "loading") {
      content.createDiv({ cls: "vt-gitrepo-browser__loading", text: "加载中…" });
      return;
    }
    if (preview.status === "error") {
      content.createDiv({ cls: "vt-gitrepo-browser__error", text: `无法预览：${preview.error ?? "未知错误"}` });
      return;
    }
    if (preview.kind === "binary") {
      content.createDiv({
        cls: "vt-gitrepo-browser__empty",
        text: "二进制文件没有内置预览。点上方「用编辑器打开」或到 GitHub/Gitee 网页查看。",
      });
      return;
    }
    if (preview.kind === "markdown") {
      void MarkdownRenderer.render(this.app, preview.text ?? "", content, "", this);
      return;
    }
    const pre = content.createEl("pre", { cls: "vt-gitrepo-browser__code" });
    pre.setText(preview.text ?? "");
  }
}

/** 打开仓库浏览器（命令/右键菜单入口的实现，见 main.ts 与 mountPanel.ts）。 */
export async function openGitRepoBrowserFor(
  plugin: VirtualTreePlugin,
  mountId?: string,
): Promise<void> {
  const mounts = (plugin.settings.externalMounts ?? []).filter(
    (m) => m.enabled && isGitRepoPath(m.path) && isRemoteMount(m),
  );
  if (mounts.length === 0) {
    new Notice("没有 Git 仓库挂载：先在挂载面板里「挂载 Git 仓库…」。");
    return;
  }
  const target = mountId ? mounts.find((m) => m.id === mountId) : mounts.length === 1 ? mounts[0] : null;
  if (!target) {
    const menu = new Menu();
    for (const m of mounts) {
      menu.addItem((item) =>
        item
          .setTitle(mountDisplayName(m))
          .setIcon("git-branch" as never)
          .onClick(() => void openGitRepoBrowserFor(plugin, m.id)),
      );
    }
    menu.showAtPosition({ x: window.innerWidth / 2, y: 80 });
    return;
  }
  // 同一挂载已有面板 → 聚焦既有；否则在主区新开一个标签页（移动端全屏可用）。
  for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GIT_REPO_BROWSER)) {
    const state = leaf.getViewState().state as { mountId?: string } | undefined;
    if (state?.mountId === target.id) {
      plugin.app.workspace.revealLeaf(leaf);
      return;
    }
  }
  const leaf = plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({
    type: VIEW_TYPE_GIT_REPO_BROWSER,
    state: { mountId: target.id },
    active: true,
  });
  plugin.app.workspace.revealLeaf(leaf);
}
