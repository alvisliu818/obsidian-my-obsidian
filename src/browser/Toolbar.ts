import { setIcon } from "obsidian";
import type { BrowserSettings } from "../types";
import { normalizeUrl } from "../utils/url";

export interface ToolbarCallbacks {
  onBack(): void;
  onForward(): void;
  onReload(force: boolean): void;
  onHome(): void;
  onStop(): void;
  onNavigate(url: string): void;
  onToggleBookmark(): void;
  onFind(text: string, forward: boolean, findNext: boolean): void;
  onFindClose(): void;
  onOpenExternal(): void;
  onMenu(e: MouseEvent): void;
  onExtensionClick?(id: string, anchor: HTMLElement): void;
}

/** The per-tab chrome: address bar, navigation buttons and the find bar. */
export class Toolbar {
  readonly element: HTMLDivElement;
  private urlbar!: HTMLInputElement;
  private findbarWrap!: HTMLDivElement;
  private findInput!: HTMLInputElement;
  private findResult!: HTMLSpanElement;
  private loadingBar!: HTMLDivElement;
  private btnBack!: HTMLButtonElement;
  private btnForward!: HTMLButtonElement;
  private btnReload!: HTMLButtonElement;
  private btnBookmark!: HTMLButtonElement;
  private extbar!: HTMLDivElement;
  private findActive = false;

  constructor(
    private getSettings: () => BrowserSettings,
    private cb: ToolbarCallbacks,
  ) {
    this.element = document.createElement("div");
    this.element.className = "ob-browser-toolbar";
    this.buildDom();
    this.bindEvents();
  }

  private buildDom(): void {
    this.element.innerHTML = `
      <div class="ob-browser-loading-bar"></div>
      <div class="ob-browser-row">
        <button class="ob-btn" data-act="back" aria-label="后退" title="后退 (Alt+←)"></button>
        <button class="ob-btn" data-act="forward" aria-label="前进" title="前进 (Alt+→)"></button>
        <button class="ob-btn" data-act="reload" aria-label="刷新" title="刷新 (Ctrl+R) / Shift 强制刷新"></button>
        <button class="ob-btn" data-act="home" aria-label="主页" title="主页"></button>
        <input class="ob-urlbar" type="text" spellcheck="false" placeholder="搜索或输入网址" />
        <button class="ob-btn" data-act="bookmark" aria-label="书签" title="书签"></button>
        <button class="ob-btn" data-act="find" aria-label="查找" title="查找 (Ctrl+F)"></button>
        <button class="ob-btn" data-act="openExternal" aria-label="系统浏览器打开" title="在系统浏览器中打开"></button>
        <button class="ob-btn" data-act="menu" aria-label="更多" title="更多"></button>
        <div class="ob-extbar"></div>
      </div>
      <div class="ob-findbar-wrap" style="display:none">
        <input class="ob-findbar" type="text" spellcheck="false" placeholder="在页面中查找" />
        <span class="ob-find-result"></span>
        <button class="ob-btn" data-act="findPrev" aria-label="上一个"></button>
        <button class="ob-btn" data-act="findNext" aria-label="下一个"></button>
        <button class="ob-btn" data-act="findClose" aria-label="关闭"></button>
      </div>`;

    const q = <T extends HTMLElement>(sel: string): T => this.element.querySelector(sel) as T;
    this.loadingBar = q<HTMLDivElement>(".ob-browser-loading-bar");
    this.urlbar = q<HTMLInputElement>(".ob-urlbar");
    this.findbarWrap = q<HTMLDivElement>(".ob-findbar-wrap");
    this.findInput = q<HTMLInputElement>(".ob-findbar");
    this.findResult = q<HTMLSpanElement>(".ob-find-result");
    this.btnBack = q<HTMLButtonElement>('[data-act="back"]');
    this.btnForward = q<HTMLButtonElement>('[data-act="forward"]');
    this.btnReload = q<HTMLButtonElement>('[data-act="reload"]');
    this.btnBookmark = q<HTMLButtonElement>('[data-act="bookmark"]');
    this.extbar = q<HTMLDivElement>(".ob-extbar");

    setIcon(this.btnBack, "arrow-left");
    setIcon(this.btnForward, "arrow-right");
    setIcon(this.btnReload, "refresh-cw");
    setIcon(q('[data-act="home"]'), "home");
    setIcon(this.btnBookmark, "star");
    setIcon(q('[data-act="find"]'), "search");
    setIcon(q('[data-act="openExternal"]'), "external-link");
    setIcon(q('[data-act="menu"]'), "more-vertical");
    setIcon(q('[data-act="findPrev"]'), "chevron-up");
    setIcon(q('[data-act="findNext"]'), "chevron-down");
    setIcon(q('[data-act="findClose"]'), "x");
  }

  private bindEvents(): void {
    this.element.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!btn) {
        const ext = (e.target as HTMLElement).closest<HTMLElement>("[data-ext-id]");
        if (ext) this.cb.onExtensionClick?.(ext.getAttribute("data-ext-id") ?? "", ext);
        return;
      }
      const act = btn.getAttribute("data-act");
      switch (act) {
        case "back": this.cb.onBack(); break;
        case "forward": this.cb.onForward(); break;
        case "reload": this.cb.onReload((e as MouseEvent).shiftKey); break;
        case "stop": this.cb.onStop(); break;
        case "home": this.cb.onHome(); break;
        case "bookmark": this.cb.onToggleBookmark(); break;
        case "openExternal": this.cb.onOpenExternal(); break;
        case "menu": this.cb.onMenu(e as MouseEvent); break;
        case "find": this.toggleFind(true); break;
        case "findClose": this.toggleFind(false); break;
        case "findPrev": this.cb.onFind(this.findInput.value, false, true); break;
        case "findNext": this.cb.onFind(this.findInput.value, true, true); break;
      }
    });

    this.urlbar.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const raw = this.urlbar.value;
        this.cb.onNavigate(normalizeUrl(raw, this.getSettings()));
        this.urlbar.blur();
      } else if (e.key === "Escape") {
        this.urlbar.blur();
      }
    });
    this.urlbar.addEventListener("focus", () => this.urlbar.select());

    this.findInput.addEventListener("input", () => {
      this.cb.onFind(this.findInput.value, true, false);
    });
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.cb.onFind(this.findInput.value, !e.shiftKey, true);
      } else if (e.key === "Escape") {
        this.toggleFind(false);
      }
    });
  }

  // ---------------- state ----------------

  setUrl(url: string): void {
    // Never fight the user's typing.
    if (document.activeElement === this.urlbar) return;
    this.urlbar.value = url === "about:blank" ? "" : url;
  }

  setNavState(canBack: boolean, canForward: boolean): void {
    this.btnBack.disabled = !canBack;
    this.btnForward.disabled = !canForward;
  }

  setLoading(loading: boolean): void {
    this.loadingBar.style.opacity = loading ? "1" : "0";
    if (loading) {
      setIcon(this.btnReload, "x");
      this.btnReload.setAttribute("data-act", "stop");
      this.btnReload.setAttribute("title", "停止加载");
    } else {
      setIcon(this.btnReload, "refresh-cw");
      this.btnReload.setAttribute("data-act", "reload");
      this.btnReload.setAttribute("title", "刷新 (Ctrl+R) / Shift 强制刷新");
    }
  }

  setBookmarked(bookmarked: boolean): void {
    setIcon(this.btnBookmark, bookmarked ? "star" : "star");
    this.btnBookmark.classList.toggle("is-active", bookmarked);
  }

  setFindResult(active: number, matches: number): void {
    if (!this.findInput.value) this.findResult.textContent = "";
    else this.findResult.textContent = matches ? `${active}/${matches}` : "0/0";
  }

  focusUrl(): void {
    this.urlbar.focus();
    this.urlbar.select();
  }

  toggleFind(show?: boolean): void {
    this.findActive = show ?? !this.findActive;
    this.findbarWrap.style.display = this.findActive ? "flex" : "none";
    if (this.findActive) {
      this.findInput.focus();
      this.findInput.select();
    } else {
      this.findInput.value = "";
      this.findResult.textContent = "";
      this.cb.onFindClose();
    }
  }

  get findVisible(): boolean {
    return this.findActive;
  }

  /** Extension icons: file:// images are blocked, so everything is a data URL. */
  setExtensionIcons(items: { id: string; name: string; icon: string }[]): void {
    this.extbar.empty();
    for (const it of items) {
      const btn = document.createElement("button");
      btn.className = "ob-btn ob-ext-btn";
      btn.setAttribute("data-ext-id", it.id);
      btn.setAttribute("title", it.name);
      btn.setAttribute("aria-label", it.name);
      if (it.icon) {
        const img = document.createElement("img");
        img.src = it.icon;
        img.className = "ob-ext-icon";
        btn.appendChild(img);
      } else {
        setIcon(btn, "puzzle");
      }
      this.extbar.appendChild(btn);
    }
    this.extbar.style.display = items.length ? "flex" : "none";
  }
}
