import { Menu } from "obsidian";
import type { WebViewContextMenuParams } from "../types";
import { copyText } from "../utils/dom";
import { compensateMenuPosition } from "../../../shared/menuPosition";

/**
 * 浏览器模块菜单单例（2026-11-28 对齐思源 dcc08fd/9e995c3）。
 *
 * webview 是独立 document：在网页里右键时宿主 document 收不到 contextmenu，
 * Obsidian Menu 自带的「点外部关闭」因此失效，旧菜单会叠在新菜单后面。
 * 这里统一登记菜单，并在宿主右键 / webview 事件 / 页内 mousedown 时显式关闭。
 */
let activeMenu: Menu | null = null;

export function closeActiveBrowserMenu(): void {
  const m = activeMenu;
  activeMenu = null;
  if (!m) return;
  // Obsidian 的关闭方法是 hide()（close() 已弃用但仍在），运行时都兜一层
  try {
    const anyMenu = m as unknown as { hide?: () => unknown; close?: () => unknown };
    if (typeof anyMenu.hide === "function") anyMenu.hide();
    else if (typeof anyMenu.close === "function") anyMenu.close();
  } catch {
    /* 菜单已销毁 */
  }
}

export function trackBrowserMenu(menu: Menu): void {
  closeActiveBrowserMenu();
  activeMenu = menu;
  try {
    menu.onHide(() => {
      if (activeMenu === menu) activeMenu = null;
    });
  } catch {
    /* onHide 不可用：下次打开菜单时仍会先关旧的 */
  }
}

// 不用 window 全局标志：插件 reload 时 window 不重建，全局标志会让新模块
// 拿不到事件监听；重复绑定只会多关一次已经关闭的旧菜单，无副作用。
if (typeof document !== "undefined") {
  // 右键点在宿主任意位置都先关掉本插件上一个菜单
  document.addEventListener("contextmenu", () => closeActiveBrowserMenu(), true);
  // 左键点菜单外也兜底（Obsidian 自己有关闭逻辑，这里只处理本插件登记的菜单）
  document.addEventListener(
    "pointerdown",
    (e) => {
      const m = activeMenu as unknown as { dom?: HTMLElement } | null;
      if (!m) return;
      const el = m.dom;
      const target = e.target as Node | null;
      if (el && target && !el.contains(target)) closeActiveBrowserMenu();
    },
    true,
  );
}

export interface WebViewMenuCallbacks {
  goBack(): void;
  goForward(): void;
  reload(): void;
  openInNewTab(url: string): void;
  saveAs(url: string, suggestedName?: string): void;
  /** 保存网页 MHTML(自选位置;用户 2026-11-20) */
  savePageMhtml(): void;
  /** 复制右键命中元素为带样式 HTML(用户 2026-11-20) */
  copyElement(x: number, y: number): void;
  excerpt(mode: "article" | "selection"): void;
  annotate(selectionText: string): void;
  copyImage(srcUrl: string): void;
  openSource(url: string): void;
  inspect(): void;
}

/**
 * Right-click menu for the guest. Electron reports x/y relative to the webview,
 * while Obsidian's Menu wants host-window coordinates — hence the rect offset.
 */
export function showWebViewContextMenu(
  params: WebViewContextMenuParams,
  hostRect: DOMRect,
  cb: WebViewMenuCallbacks,
): void {
  const menu = new Menu();
  trackBrowserMenu(menu);

  menu.addItem((i) => i.setTitle("后退").setIcon("arrow-left").onClick(() => cb.goBack()));
  menu.addItem((i) => i.setTitle("前进").setIcon("arrow-right").onClick(() => cb.goForward()));
  menu.addItem((i) => i.setTitle("刷新").setIcon("refresh-cw").onClick(() => cb.reload()));
  menu.addSeparator();

  if (params.linkURL) {
    menu.addItem((i) =>
      i.setTitle("在新页签中打开链接").setIcon("external-link").onClick(() => cb.openInNewTab(params.linkURL!)),
    );
    menu.addItem((i) => i.setTitle("复制链接地址").setIcon("link").onClick(() => void copyText(params.linkURL!)));
  }

  if (params.mediaType === "image" && params.srcURL) {
    menu.addItem((i) => i.setTitle("复制图片").setIcon("image").onClick(() => cb.copyImage(params.srcURL!)));
    menu.addItem((i) => i.setTitle("图片另存到仓库").setIcon("download").onClick(() => cb.saveAs(params.srcURL!)));
  }

  if (!params.linkURL && params.mediaType !== "image") {
    menu.addItem((i) => i.setTitle("页面另存到仓库").setIcon("download").onClick(() => cb.saveAs(params.pageURL)));
  }
  // 保存网页(完整渲染页 MHTML,自选保存位置;用户 2026-11-20)
  menu.addItem((i) => i.setTitle("保存网页到本地…").setIcon("hard-drive-download").onClick(() => cb.savePageMhtml()));
  // 复制右键命中元素为带样式 HTML(内联计算样式+保留 script;用户 2026-11-20)
  menu.addItem((i) =>
    i.setTitle("复制元素为带样式 HTML").setIcon("code-xml").onClick(() => cb.copyElement(params.x, params.y)),
  );

  if (params.selectionText) {
    menu.addItem((i) => i.setTitle("复制所选文本").setIcon("copy").onClick(() => void copyText(params.selectionText!)));
  }

  menu.addSeparator();
  menu.addItem((i) => i.setTitle("摘录整页为笔记").setIcon("scissors").onClick(() => cb.excerpt("article")));
  // 标注：始终显示（2026-11-28 对齐思源 0e96d7b）；有选区标注选中文字，无选区标注整页
  const hasSelection = !!String(params.selectionText || "").trim();
  menu.addItem((i) =>
    i
      .setTitle(hasSelection ? "标注选中文字" : "标注此页")
      .setIcon("pen-tool")
      .onClick(() => cb.annotate(hasSelection ? params.selectionText! : "")),
  );
  if (hasSelection) {
    menu.addItem((i) => i.setTitle("摘录所选内容").setIcon("scissors").onClick(() => cb.excerpt("selection")));
  }

  menu.addSeparator();
  menu.addItem((i) =>
    i.setTitle("查看源代码").setIcon("code").onClick(() => cb.openSource("view-source:" + params.pageURL)),
  );
  menu.addItem((i) => i.setTitle("检查元素").setIcon("terminal").onClick(() => cb.inspect()));

  // 1.15 菜单 realm 补偿(用户 2026-11-20 报「右键菜单位置偏移」):见
  // shared/menuPosition.ts——realm 窗口存在时按原样坐标渲染会偏移窗口原点差。
  const pos = compensateMenuPosition(Math.round(hostRect.left + params.x), Math.round(hostRect.top + params.y));
  menu.showAtPosition(pos);
}
