import { App, MarkdownView } from "obsidian";

export interface StickyMediaContext {
    media: HTMLMediaElement;
    scrollEl: HTMLElement;
    hostEl: HTMLElement;
}

const MODE_SELECTORS = {
    preview: [".markdown-reading-view audio", ".markdown-reading-view video"],
    source: [".markdown-source-view.is-live-preview audio", ".markdown-source-view.is-live-preview video"],
    scroll: {
        preview: ".markdown-reading-view .markdown-preview-view",
        source: ".markdown-source-view.is-live-preview .cm-scroller"
    }
} as const;

export function findStickyMediaCandidates(root: ParentNode, mode?: "preview" | "source"): HTMLMediaElement[] {
    const sel = mode ? MODE_SELECTORS[mode] : [...MODE_SELECTORS.preview, ...MODE_SELECTORS.source];
    return Array.from(root.querySelectorAll<HTMLMediaElement>(sel.join(", ")));
}

export function findStickyScrollContainer(root: ParentNode, mode: "preview" | "source"): HTMLElement | null {
    return root.querySelector<HTMLElement>(MODE_SELECTORS.scroll[mode]);
}

export function findStickyMediaContext(el: HTMLElement): StickyMediaContext | null {
    const media = el.matches("audio, video") ? el as HTMLMediaElement : el.querySelector<HTMLMediaElement>("audio, video");
    if (!media) return null;
    const scrollEl = el.closest<HTMLElement>(".markdown-preview-view") ?? el.closest<HTMLElement>(".cm-scroller");
    if (!scrollEl) return null;
    const hostEl = scrollEl.closest<HTMLElement>(".view-content");
    return hostEl ? { media, scrollEl, hostEl } : null;
}

function resolveWrapper(media: HTMLMediaElement, scrollEl: HTMLElement): HTMLElement {
    const player = media.closest<HTMLElement>(".custom-media-player");
    if (player && scrollEl.contains(player)) return player;
    const cand = media.closest<HTMLElement>(".internal-embed, .media-embed");
    return cand && scrollEl.contains(cand) ? cand : media;
}

interface MediaGroup { ctls: BaseController[]; onScroll: () => void; }

abstract class BaseController {
    protected attached = false;
    protected docked = false;
    protected destroyed = false;
    protected wrapper: HTMLElement;
    public anchor: HTMLElement | null = null;

    /**
     * anchor 的文档 Y 坐标（相对 scrollEl 内容顶部）。
     * anchor 可见时每次 arbitrate 都会刷新；anchor 被 CM 虚拟化卸载后保留最后值。
     */
    public anchorDocY: number | null = null;

    /**
     * 本段最后一个"已知"时间戳底边的文档 Y 坐标（相对 scrollEl 内容顶部）。
     * 单调递增：缓存只增不减，用于在 anchor 被卸载后仍能判断
     * "本段的时间戳是否已全部滚出容器顶部"。
     */
    public lastTsDocY: number | null = null;

    get isActive(): boolean { return this.attached && !this.destroyed && this.media.isConnected; }
    isDocked(): boolean { return this.docked; }
    getStickyHeight(): number { return this.wrapper.getBoundingClientRect().height; }

    constructor(
        public readonly media: HTMLMediaElement,
        protected readonly scrollEl: HTMLElement,
        protected readonly hostEl: HTMLElement
    ) {
        this.wrapper = resolveWrapper(media, scrollEl);
    }

    abstract attach(): void;
    abstract getTriggerRect(): DOMRect;
    abstract dock(): void;
    abstract restore(): void;
    abstract destroy(): void;
    refresh(): void {}

    /**
     * 刷新位置缓存。
     * - anchor 在 DOM 时刷新 anchorDocY。
     * - 扫描 [anchorDocY, nextAnchorDocY) 区间内的时间戳，取最靠下的更新 lastTsDocY。
     *
     * @param sr            scrollEl 的 getBoundingClientRect()
     * @param nextAnchorDocY 下一个 active ctrl 的 anchorDocY（无则为 null，视作正无穷）
     */
    updateCache(sr: DOMRect, nextAnchorDocY: number | null) {
        const scrollEl = this.scrollEl;
        const scrollTop = scrollEl.scrollTop;

        if (this.anchor?.isConnected) {
            const ar = this.anchor.getBoundingClientRect();
            this.anchorDocY = ar.top - sr.top + scrollTop;
        }

        const myDocY = this.anchorDocY ?? -Infinity;
        const nextDocY = nextAnchorDocY ?? Infinity;

        const timestamps = scrollEl.querySelectorAll<HTMLElement>(".tsp-timestamp");
        for (const ts of Array.from(timestamps)) {
            const r = ts.getBoundingClientRect();
            const docY = r.bottom - sr.top + scrollTop;
            if (docY <= myDocY) continue;
            if (docY >= nextDocY) continue;
            if (this.lastTsDocY === null || docY > this.lastTsDocY) {
                this.lastTsDocY = docY;
            }
        }
    }
}

export class StickyMediaController extends BaseController {
    private placeholder: HTMLElement | null = null;
    private layer: HTMLElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private origW = 0;
    private origH = 0;
    private origLeft = 0;
    private origParent: Node | null = null;
    private origNext: Node | null = null;
    private readonly onResize = () => this.refresh();

    constructor(media: HTMLMediaElement, scrollEl: HTMLElement, hostEl: HTMLElement, private mgr: StickyMediaManager) {
        super(media, scrollEl, hostEl);
    }

    attach() {
        if (this.attached || this.destroyed || !this.wrapper.isConnected) return;
        this.installAnchor();

        const win = this.media.ownerDocument.defaultView;
        win?.addEventListener("resize", this.onResize);
        const RC = win?.ResizeObserver;
        if (RC) {
            this.resizeObserver = new RC(this.onResize);
            this.resizeObserver.observe(this.wrapper);
            this.resizeObserver.observe(this.hostEl);
        }
        this.attached = true;
        this.refresh();
    }

    private installAnchor() {
        this.anchor = createDiv();
        this.anchor.className = "tsp-sticky-anchor";
        this.anchor.setAttribute("aria-hidden", "true");
        this.wrapper.before(this.anchor);
        this.mgr.registerMediaAnchor(this.media, this.anchor);
    }

    /**
     * 返回用于 arbitrate() 判断的矩形。
     * - anchor 可见：返回它的矩形。
     * - anchor 被 CodeMirror 虚拟化卸载，但当前处于 docked：
     *   合成一个位于 scrollEl 上沿之上的矩形（top = sr.top - 1），使当前 ctrl
     *   继续被选为 best。
     * - 其他情况：回退到 wrapper 的矩形。
     */
    getTriggerRect(): DOMRect {
        if (this.anchor?.isConnected) return this.anchor.getBoundingClientRect();

        if (this.docked) {
            const sr = this.scrollEl.getBoundingClientRect();
            return new DOMRect(sr.left, sr.top - 1, sr.width, 0);
        }

        return this.wrapper.getBoundingClientRect();
    }

    refresh() {
        if (!this.attached || this.destroyed) return;
        if (!this.scrollEl.isConnected || !this.hostEl.isConnected) {
            this.destroy();
            return;
        }

        // CodeMirror 虚拟化容错
        if (this.anchor && !this.anchor.isConnected) {
            if (this.docked) {
                // 已 dock：wrapper 在 sticky 层里，位置由 origLeft 兜底。
                // 不要重新 installAnchor。
            } else if (this.wrapper.isConnected && this.scrollEl.contains(this.wrapper)) {
                // 未 dock：CM 重建了承载行，重新安装 anchor 继续追踪
                this.mgr.unregisterMediaAnchor(this.media);
                this.installAnchor();
            }
            // 其余情况：由 moveBack() 暂存到 hostEl，等 anchor 重现时自愈
        }

        // 自愈：anchor 重新挂载、未 dock、wrapper 还停在 hostEl 里 → 归位
        if (!this.docked
            && this.anchor?.isConnected
            && this.wrapper.parentElement === this.hostEl) {
            this.anchor.after(this.wrapper);
        }

        if (this.docked) this.syncGeo();
    }

    dock() {
        if (this.docked || !this.anchor?.isConnected) return;
        this.origParent = this.wrapper.parentNode;
        this.origNext = this.wrapper.nextSibling;
        const wr = this.wrapper.getBoundingClientRect();
        const hr = this.hostEl.getBoundingClientRect();
        this.origW = wr.width;
        this.origH = wr.height;
        this.origLeft = wr.left - hr.left;

        this.placeholder = createDiv();
        this.placeholder.className = "tsp-sticky-placeholder";
        this.placeholder.setAttribute("aria-hidden", "true");
        this.placeholder.style.cssText = `height:${this.origH}px;width:${this.origW}px`;
        this.anchor.after(this.placeholder);

        this.layer = createDiv();
        this.layer.className = "tsp-sticky-media-layer";
        this.hostEl.classList.add("tsp-sticky-host-context");
        this.hostEl.appendChild(this.layer);
        this.layer.appendChild(this.wrapper);
        this.docked = true;
        this.syncGeo();
    }

    restore() {
        if (!this.docked) return;
        this.moveBack();
        this.placeholder?.remove();
        this.layer?.remove();
        this.hostEl.classList.remove("tsp-sticky-host-context");
        this.placeholder = this.layer = null;
        this.docked = false;
    }

    private moveBack() {
        if (this.anchor?.isConnected) {
            this.anchor.after(this.wrapper);
            return;
        }
        if (this.origParent instanceof Node && (this.origParent as HTMLElement).isConnected) {
            try {
                this.origParent.insertBefore(this.wrapper, this.origNext);
                return;
            } catch { /* fall through */ }
        }
        // 兜底：暂存到 hostEl，refresh() 在 anchor 重现时会把它放回
        this.hostEl.appendChild(this.wrapper);
    }

    destroy() {
        if (this.destroyed) return;
        const win = this.media.ownerDocument.defaultView;
        win?.removeEventListener("resize", this.onResize);
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.mgr.unregisterMediaAnchor(this.media);
        if (this.docked) {
            this.moveBack();
            this.placeholder?.remove();
            this.layer?.remove();
            this.docked = false;
        }
        this.anchor?.remove();
        this.hostEl.classList.remove("tsp-sticky-host-context");
        this.placeholder = this.layer = this.anchor = null;
        this.origParent = this.origNext = null;
        this.anchorDocY = null;
        this.lastTsDocY = null;
        this.attached = false;
        this.destroyed = true;
    }

    private syncGeo() {
        if (!this.docked || !this.placeholder || !this.layer) return;
        const hr = this.hostEl.getBoundingClientRect();
        const sr = this.scrollEl.getBoundingClientRect();
        let left = this.origLeft;
        // 可用宽度优先取 anchor 宽度（≈承载内容列宽度），便于窄内容精确居中
        let avail = Math.max(0, hr.width - Math.max(0, left));
        if (this.anchor?.isConnected) {
            const ar = this.anchor.getBoundingClientRect();
            if (Number.isFinite(ar.left - hr.left)) left = ar.left - hr.left;
            if (ar.width > 0) avail = ar.width;
        }
        const w = Math.min(this.origW, avail);
        // 竖屏等窄内容在吸附层内水平居中（普通内容 origW≈avail，不会偏移）
        const centering = this.wrapper.classList.contains("tsp-orient-portrait")
            ? Math.max(0, (avail - w) / 2)
            : 0;
        this.placeholder.style.cssText = `height:${this.origH}px;width:${w}px`;
        this.layer.style.cssText = `top:${sr.top - hr.top}px;left:${left + centering}px;width:${w}px`;
    }
}

export class StickyMediaManager {
    private groups = new Map<HTMLElement, MediaGroup>();
    private mo: MutationObserver | null = null;
    private timer: number | null = null;
    private readonly anchorMap = new Map<HTMLElement, HTMLMediaElement>();
    private readonly mediaMap = new WeakMap<HTMLMediaElement, HTMLElement>();
    private enabled = false;

    constructor(private app: App) {}

    initialize() { if (this.enabled) this.startObs(); }

    /** 启用/禁用吸附：禁用时销毁全部控制器，启用时重建并扫描 */
    setEnabled(enabled: boolean) {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        if (enabled) this.startObs();
        else this.destroy();
    }

    registerMediaAnchor(media: HTMLMediaElement, anchor: HTMLElement) {
        this.anchorMap.set(anchor, media);
        this.mediaMap.set(media, anchor);
    }
    unregisterMediaAnchor(media: HTMLMediaElement) {
        const a = this.mediaMap.get(media);
        if (a) { this.anchorMap.delete(a); this.mediaMap.delete(media); }
    }
    getMediaForAnchor(anchor: HTMLElement): HTMLMediaElement | null { return this.anchorMap.get(anchor) || null; }
    getAnchorForMedia(media: HTMLMediaElement): HTMLElement | null { return this.mediaMap.get(media) || null; }

    setupForElement(renderRoot: HTMLElement) {
        if (!this.enabled) return;
        const ctx = findStickyMediaContext(renderRoot);
        if (!ctx) return;
        const { media, scrollEl, hostEl } = ctx;

        let g = this.groups.get(scrollEl);
        if (!g) {
            g = { ctls: [], onScroll: () => this.arbitrate(scrollEl) };
            this.groups.set(scrollEl, g);
            scrollEl.addEventListener("scroll", g.onScroll, { passive: true });
        }

        if (g.ctls.some(c => c.media === media)) return;
        const ctrl = new StickyMediaController(media, scrollEl, hostEl, this);
        ctrl.attach();
        g.ctls.push(ctrl);
    }

    scan() {
        if (!this.enabled) return;
        this.cleanup();
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) continue;
            const mode = view.getMode();
            for (const media of findStickyMediaCandidates(view.containerEl, mode)) {
                this.setupForElement(media);
            }
        }
    }

    destroy() {
        this.mo?.disconnect();
        this.mo = null;
        if (this.timer !== null) {
            this.app.workspace.containerEl.ownerDocument.defaultView?.clearTimeout(this.timer);
            this.timer = null;
        }
        for (const [el, g] of this.groups) {
            el.removeEventListener("scroll", g.onScroll);
            for (const c of g.ctls) c.destroy();
        }
        this.groups.clear();
        this.anchorMap.clear();
    }

    private arbitrate(scrollEl: HTMLElement) {
        const g = this.groups.get(scrollEl);
        if (!g) return;
        const sr = scrollEl.getBoundingClientRect();

        // 1) 更新所有 active ctrl 的位置缓存（从后往前，后面 ctrl 的 anchorDocY 作为前面 ctrl 的上界）
        const actives = g.ctls.filter(c => c.isActive);
        for (let i = actives.length - 1; i >= 0; i--) {
            const next = actives[i + 1];
            actives[i].updateCache(sr, next ? next.anchorDocY : null);
        }

        // 2) 选 best（视口顶部上方距离最近的 media）
        let best: BaseController | null = null, bestTop = -Infinity;
        for (const c of actives) {
            const r = c.getTriggerRect();
            if (r.top < sr.top && r.top > bestTop) { bestTop = r.top; best = c; }
        }

        // 3) 限位判定
        if (best && this.shouldUnstick(scrollEl, best, sr)) best = null;

        // 4) 应用
        for (const c of g.ctls) {
            const should = c === best;
            if (should && !c.isDocked()) c.dock();
            else if (!should && c.isDocked()) c.restore();
        }
    }

    /**
     * 限位判定：
     *  A) 下一个媒体 anchor 顶到 sticky 底边 → 松手
     *  B) 本段最后一个已知时间戳已滚出容器顶部 → 松手
     *
     * 条件 B 使用 BaseController.lastTsDocY（文档坐标），
     * 因此不再依赖 anchor 是否还在 DOM 中 —— 这解决了"时间戳过长时
     * anchor 被 CM 虚拟化卸载，导致条件 B 永远无法命中"的问题。
     */
    private shouldUnstick(scrollEl: HTMLElement, ctrl: BaseController, sr: DOMRect): boolean {
        // A) 下一个媒体 anchor 顶上来
        const g = this.groups.get(scrollEl);
        if (g) {
            const idx = g.ctls.indexOf(ctrl);
            for (let i = idx + 1; i < g.ctls.length; i++) {
                const next = g.ctls[i];
                if (!next.isActive) continue;
                if (next.anchor?.isConnected) {
                    const nr = next.anchor.getBoundingClientRect();
                    if (nr.top < sr.top + ctrl.getStickyHeight()) return true;
                }
                // 第一个 active 就够了：anchor 不可见说明它还在下方很远，不会顶上来
                break;
            }
        }

        // B) 本段最后一个已知时间戳滚出容器顶部
        if (ctrl.lastTsDocY !== null && ctrl.lastTsDocY < scrollEl.scrollTop) {
            return true;
        }

        return false;
    }

    private startObs() {
        const el = this.app.workspace.containerEl;
        const win = el.ownerDocument.defaultView;
        if (!win) return;
        this.mo = new win.MutationObserver(() => { this.cleanup(); this.schedule(); });
        this.mo.observe(el, { childList: true, subtree: true });
        this.scan();
    }

    private schedule() {
        if (this.timer !== null) return;
        const win = this.app.workspace.containerEl.ownerDocument.defaultView;
        if (!win) { this.scan(); return; }
        this.timer = win.setTimeout(() => { this.timer = null; this.scan(); }, 0);
    }

    private cleanup() {
        const valid = new Map<HTMLElement, string>();
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) continue;
            const s = findStickyScrollContainer(view.containerEl, view.getMode());
            if (s) valid.set(s, view.file.path);
        }
        for (const [el, g] of this.groups) {
            if (!valid.has(el)) {
                for (const c of g.ctls) c.destroy();
                el.removeEventListener("scroll", g.onScroll);
                this.groups.delete(el);
                continue;
            }
            const toRemove: BaseController[] = [];
            for (const c of g.ctls) {
                if (!c.isActive) toRemove.push(c);
                else c.refresh();
            }
            for (const c of toRemove) {
                const idx = g.ctls.indexOf(c);
                if (idx > -1) g.ctls.splice(idx, 1);
                c.destroy();
            }
            if (g.ctls.length === 0) {
                el.removeEventListener("scroll", g.onScroll);
                this.groups.delete(el);
            }
        }
    }
}