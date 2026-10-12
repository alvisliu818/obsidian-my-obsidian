/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ExtensionHost } from "./extensionHost";
import type { ExtensionRecord } from "../types";

/**
 * Extension popups: a floating <webview> pinned under the toolbar icon.
 *
 * A webview (not an iframe) because the popup lives on file:// — an iframe from
 * the app:// host could not reach into it to install the chrome shim, and the
 * popup's own scripts need that shim before they run.
 */
/** Electron's <webview> is not in lib.dom — this covers what we use. */
type PopupWebview = HTMLElement & { send(channel: string, ...args: unknown[]): void };

export class PopupLayer {
  private layer: HTMLDivElement | null = null;
  private current: { webview: PopupWebview; rec: ExtensionRecord } | null = null;

  constructor(
    private host: HTMLElement,
    private extHost: ExtensionHost,
    private extPreloadUrl: string,
  ) {}

  get isOpen(): boolean {
    return !!this.layer;
  }

  toggle(rec: ExtensionRecord, anchor: HTMLElement): void {
    if (this.current?.rec.id === rec.id && this.isOpen) {
      this.close();
      return;
    }
    this.close();
    if (!rec.popup) return;

    const rect = anchor.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.className = "ob-popup-layer";
    layer.style.left = `${Math.max(8, rect.left - 220)}px`;
    layer.style.top = `${Math.min(window.innerHeight - 40, rect.bottom + 6)}px`;

    const wv = document.createElement("webview") as unknown as PopupWebview;
    wv.setAttribute("partition", "persist:obsidian-browser");
    wv.setAttribute("webpreferences", "contextIsolation=no");
    wv.setAttribute("allowpopups", "");
    if (this.extPreloadUrl) wv.setAttribute("preload", this.extPreloadUrl);
    wv.setAttribute("src", this.extHost.extensionFileUrl(rec, rec.popup));
    wv.className = "ob-popup-webview";
    layer.appendChild(wv);

    wv.addEventListener("ipc-message", (e: any) => {
      if (e.channel === "ob-popup-request") {
        wv.send("ob-popup-shim", this.extHost.shimSourceFor(rec));
      } else if (e.channel === "obsidian-browser-open-new-tab") {
        this.onOpenNewTab?.(String(e.args?.[0] ?? ""));
        this.close();
      }
    });

    document.addEventListener("pointerdown", this.outsideHandler, true);
    this.host.appendChild(layer);
    this.layer = layer;
    this.current = { webview: wv, rec };
  }

  onOpenNewTab: ((url: string) => void) | null = null;

  private outsideHandler = (e: PointerEvent) => {
    if (!this.layer) return;
    const t = e.target as Node | null;
    if (this.layer.contains(t)) return;
    this.close();
  };

  close(): void {
    document.removeEventListener("pointerdown", this.outsideHandler, true);
    this.layer?.remove();
    this.layer = null;
    this.current = null;
  }
}
