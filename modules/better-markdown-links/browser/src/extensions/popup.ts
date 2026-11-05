/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ExtensionHost } from "./extensionHost";
import type { ExtensionRecord, IWebviewTag } from "../types";
import { beginPopupWorld, evalPopupJs } from "./cs-runtime";
import { closeExtensionPopupInPage, showExtensionPopupInPage } from "./extPopup";

/**
 * Extension popups —— 源侧（siyuan-plugin-browser）架构：**页内渲染 + 扩展世界注入**。
 *
 * showExtensionPopupInPage 把 popup.html 的 body/CSS/脚本渲染进当前页签页面的
 * #ob-ext-popup-host 容器，脚本经 beginPopupWorld 新建的扩展专属世界逐文件执行 ——
 * shim 在首个脚本前同步建立（无 IPC 异步竞态），世界全局与页面隔离（AdGuard 自带
 * 的 runtime/*.js polyfill 空壳 chrome 不会覆盖 shim）。这与 cs-runtime/SW 的
 * binding 桥是同一套通道：设置齿轮（openOptionsPage → hostCall("openoptions")）。
 *
 * 历史教训：旧实现用「独立 webview + extPreload IPC 握手」交付 shim —— popup 页面
 * 没有 window.require（webview 无 nodeIntegration），extPreload 拿不到 ipcRenderer
 * 提前 return，shim 从未交付（window.chrome 一直是页面 polyfill 的空壳）。
 */
export class PopupLayer {
  private current: { rec: ExtensionRecord; webview: IWebviewTag } | null = null;

  constructor(
    private extHost: ExtensionHost,
    /** 当前活动页签的主 webview（popup 渲染进它的页面） */
    private getWebview: () => IWebviewTag | null,
    private onNotice: (msg: string) => void,
  ) {}

  get isOpen(): boolean {
    return !!this.current;
  }

  toggle(rec: ExtensionRecord, anchor: HTMLElement): void {
    if (this.current?.rec.id === rec.id) {
      this.close();
      return;
    }
    this.close();
    if (!rec.popup) return;

    const webview = this.getWebview();
    if (!webview) {
      this.onNotice("没有可用的浏览器页签");
      return;
    }
    if (!rec.electronId) {
      this.onNotice(`扩展「${rec.name}」未完成原生加载（重启 Obsidian 后重试）`);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const info = this.extHost.extInfoOf(rec);
    void showExtensionPopupInPage({
      webview,
      extPath: this.extHost.extPathOf(rec),
      electronId: rec.electronId,
      popupPath: rec.popup,
      anchorRect: { right: rect.right, bottom: rect.bottom },
      begin: () => beginPopupWorld(webview, info),
      evalJs: (src: string, relPath: string) => {
        const fakeUrl = "chrome-extension://" + rec.electronId + "/" + String(relPath).replace(/^\.\//, "");
        const prefixed = "self.__obSetCurrentScript && self.__obSetCurrentScript(" + JSON.stringify(fakeUrl) + ");\n" + src;
        return evalPopupJs(webview, info, prefixed).then((rr) => {
          if (!rr.ok) throw new Error(rr.error);
          return rr.value;
        });
      },
    })
      .then((out) => {
        if (out.ok) this.current = { rec, webview };
        else this.onNotice(`打开「${rec.name}」面板失败: ${out.error ?? ""}`);
      })
      .catch((e) => this.onNotice(`打开「${rec.name}」面板失败: ${String(e?.message || e)}`));
  }

  close(): void {
    const cur = this.current;
    this.current = null;
    if (cur) void closeExtensionPopupInPage(cur.webview).catch(() => undefined);
  }
}
