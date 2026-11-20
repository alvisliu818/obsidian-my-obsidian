import { Menu } from "obsidian";
import type { WebViewContextMenuParams } from "../types";
import { copyText } from "../utils/dom";
import { compensateMenuPosition } from "../../../shared/menuPosition";

export interface WebViewMenuCallbacks {
  goBack(): void;
  goForward(): void;
  reload(): void;
  openInNewTab(url: string): void;
  saveAs(url: string, suggestedName?: string): void;
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

  if (params.selectionText) {
    menu.addItem((i) => i.setTitle("复制所选文本").setIcon("copy").onClick(() => void copyText(params.selectionText!)));
  }

  menu.addSeparator();
  menu.addItem((i) => i.setTitle("摘录整页为笔记").setIcon("scissors").onClick(() => cb.excerpt("article")));
  if (params.selectionText) {
    menu.addItem((i) => i.setTitle("标注").setIcon("pen-tool").onClick(() => cb.annotate(params.selectionText!)));
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
