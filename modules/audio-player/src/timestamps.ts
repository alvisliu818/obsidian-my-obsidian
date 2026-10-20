import { App, MarkdownView, setIcon } from "obsidian";
import { StickyMediaManager } from "./sticky-media";
import { CustomMediaPlayer } from "./custom-player";
import { parseTimestamp, createInlineTsRegex, createLoopRangeRegex } from "./utils/time";
import { buildTimestampButton, buildLoopButton } from "./utils/ts-button";

const SPEAKER_LINE_RE = /^(.+?)\s+((?:(?:\d{1,3}:)?\d{1,3}:\d{2}(?:\.\d{1,3})?))\s*$/;
const INLINE_TS_RE = createInlineTsRegex();
const SKIP_TAGS = new Set(["CODE", "PRE", "A", "SCRIPT", "STYLE"]);
const CM_SPAN_RE = /(^|\s)cm-/;
const MEDIA_SECTION_SELECTOR = "audio, video, .tsp-sticky-anchor, .tsp-timestamp";

export class TimestampManager {
    private activeBtn: HTMLElement | null = null;
    private activeMedia: HTMLMediaElement | null = null;
    private activeContainer: HTMLElement | null = null;
    /** 当前激活的循环区间（全插件同时只允许一个） */
    private activeLoop: { media: HTMLMediaElement; start: number; end: number; btn: HTMLElement } | null = null;
    private boundTimeUpdate: (() => void) | null = null;
    private boundEnded: (() => void) | null = null;
    private boundPause: (() => void) | null = null;
    private boundPlay: (() => void) | null = null;
    private readonly players = new Set<CustomMediaPlayer>();

    constructor(
        private app: App,
        private stickyManager: StickyMediaManager
    ) {}

    processTimestamps(el: HTMLElement) {
        for (const p of Array.from(el.querySelectorAll<HTMLElement>("p"))) {
            // 幂等：已经处理过就跳过
            if (p.querySelector(".tsp-timestamp")) continue;

            const texts = this.collectTextNodes(p);

            for (const node of texts.reverse()) {
                const text = node.textContent?.trim() ?? "";
                if (!text) continue;

                const speakerMatch = text.match(SPEAKER_LINE_RE);
                if (speakerMatch) {
                    this.replaceSpeakerLine(node, speakerMatch);
                } else {
                    INLINE_TS_RE.lastIndex = 0;
                    if (INLINE_TS_RE.test(text)) {
                        this.replaceInlineTimestamps(node);
                    }
                }
            }
        }
    }

    /** 阅读模式：把 `[loop]start->end` 渲染为可点击按钮 */
    processLoopTimestamps(el: HTMLElement) {
        for (const node of this.collectTextNodes(el).reverse()) {
            const text = node.textContent ?? "";
            const regex = createLoopRangeRegex();
            const fragment = createFragment();
            let lastIndex = 0;
            let m: RegExpExecArray | null;

            while ((m = regex.exec(text)) !== null) {
                if (m.index > lastIndex) {
                    fragment.appendChild(node.ownerDocument.createTextNode(text.slice(lastIndex, m.index)));
                }
                const rangeStr = `${m[1]}->${m[2]}`;
                const start = parseTimestamp(m[1]);
                const end = parseTimestamp(m[2]);
                fragment.appendChild(buildLoopButton(rangeStr, start, end, (btn, e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleLoop(btn, start, end);
                }));
                lastIndex = m.index + m[0].length;
            }

            if (lastIndex === 0) continue;
            if (lastIndex < text.length) {
                fragment.appendChild(node.ownerDocument.createTextNode(text.slice(lastIndex)));
            }
            node.parentNode?.replaceChild(fragment, node);
        }
    }

    /** 递归收集元素下的文本节点，跳过语义元素和自身产物 */
    private collectTextNodes(el: HTMLElement): Text[] {
        const result: Text[] = [];

        const walk = (node: Node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const e = node as HTMLElement;
                if (SKIP_TAGS.has(e.tagName)) return;
                if (
                    e.classList.contains("tsp-timestamp") ||
                    e.classList.contains("tsp-speaker") ||
                    e.classList.contains("tsp-play-icon") ||
                    e.classList.contains("tsp-time") ||
                    e.classList.contains("tsp-loop-timestamp") ||
                    e.classList.contains("tsp-loop-icon") ||
                    e.classList.contains("tsp-loop-time")
                ) return;
            }
            if (node.nodeType === Node.TEXT_NODE) {
                if (node.textContent?.trim()) result.push(node as Text);
            } else {
                for (const child of Array.from(node.childNodes)) walk(child);
            }
        };
        walk(el);
        return result;
    }

    private replaceSpeakerLine(node: Text, match: RegExpMatchArray) {
        const speaker = match[1];
        const timeStr = match[2];
        const totalSeconds = parseTimestamp(timeStr);

        const wrapper = createFragment();
        wrapper.appendChild(createSpan({ cls: "tsp-speaker", text: speaker + " " }));
        wrapper.appendChild(this.createTimestampBtn(timeStr, totalSeconds));

        const parent = node.parentNode;
        if (!parent) return;

        // CodeMirror 的安全处理：父节点是 CM 装饰 span 且只有一个子节点时，
        // 就地替换内容，避免整块 span 被替换引发 CM 重新布局异常。
        if (this.isCmSpan(parent) && parent.childNodes.length === 1) {
            parent.replaceChildren(wrapper);
        } else {
            parent.replaceChild(wrapper, node);
        }
    }

    private replaceInlineTimestamps(node: Text) {
        const text = node.textContent ?? "";
        const fragment = createFragment();
        let lastIndex = 0;

        INLINE_TS_RE.lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = INLINE_TS_RE.exec(text)) !== null) {
            if (m.index > lastIndex) {
                fragment.appendChild(activeDocument.createTextNode(text.slice(lastIndex, m.index)));
            }
            const timeStr = m[0];
            const totalSeconds = parseTimestamp(timeStr);
            fragment.appendChild(this.createTimestampBtn(timeStr, totalSeconds));
            lastIndex = m.index + m[0].length;
        }

        if (lastIndex < text.length) {
            fragment.appendChild(activeDocument.createTextNode(text.slice(lastIndex)));
        }

        const parent = node.parentNode;
        if (!parent) return;

        if (this.isCmSpan(parent) && parent.childNodes.length === 1) {
            parent.replaceChildren(fragment);
        } else {
            parent.replaceChild(fragment, node);
        }
    }

    /** 判断节点是否为 CodeMirror 的装饰性 span（类名包含 cm- 前缀） */
    private isCmSpan(node: Node): node is HTMLElement {
        return node.instanceOf(HTMLElement) && CM_SPAN_RE.test(node.className);
    }

    private createTimestampBtn(timeStr: string, totalSeconds: number): HTMLSpanElement {
        return buildTimestampButton(timeStr, totalSeconds, (btn, e) => {
            e.preventDefault();
            e.stopPropagation();
            this.togglePlay(btn, totalSeconds);
        });
    }

    public togglePlay(btn: HTMLElement, seconds: number) {
        // 普通时间戳跳转与循环播放互斥
        this.stopLoop();

        if (this.activeBtn === btn && this.activeMedia) {
            if (this.activeMedia.paused) {
                this.activeMedia.play().catch(() => {});
            } else {
                this.activeMedia.pause();
            }
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        const container = view.containerEl;
        const media = this.findMediaForElement(container, btn);
        if (!media) return;

        this.activateMedia(media, container);

        media.currentTime = Math.min(seconds, media.duration || Infinity);
        media.play().catch(() => {});

        this.setActiveBtn(btn);
    }

    /**
     * 切换循环播放区间。点击同一区间会停止循环；点击其他区间会替换当前循环。
     */
    public toggleLoop(btn: HTMLElement, start: number, end: number) {
        const [from, to] = start <= end ? [start, end] : [end, start];
        if (to <= from) return;

        // 以按钮所在的视图为准，兼容分屏 / 非激活窗格
        const container = btn.closest<HTMLElement>(".markdown-source-view, .markdown-reading-view")
            ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl;
        if (!container) return;

        const media = this.findMediaForElement(container, btn);
        if (!media) return;

        const loop = this.activeLoop;
        if (loop && loop.media === media && loop.start === from && loop.end === to) {
            this.stopLoop();
            return;
        }

        this.stopLoop();
        this.activateMedia(media, container);

        this.activeLoop = { media, start: from, end: to, btn };
        btn.addClass("tsp-loop-active");
        btn.setAttribute("aria-pressed", "true");

        media.currentTime = Math.min(from, media.duration || Infinity);
        media.play().catch(() => {});
    }

    /** 当前是否有与给定区间相同的循环按钮处于激活状态 */
    public isLoopActive(start: number, end: number): boolean {
        const loop = this.activeLoop;
        if (!loop) return false;
        const [from, to] = start <= end ? [start, end] : [end, start];
        return loop.start === from && loop.end === to;
    }

    private stopLoop() {
        const loop = this.activeLoop;
        if (!loop) return;

        // 装饰节点可能已被 CodeMirror 重建，按文档清理所有激活态
        loop.btn.ownerDocument.querySelectorAll<HTMLElement>(".tsp-loop-timestamp.tsp-loop-active")
            .forEach(el => {
                el.removeClass("tsp-loop-active");
                el.setAttribute("aria-pressed", "false");
            });

        this.activeLoop = null;
    }

    /** 查找位于目标元素之前、且距离最近的媒体（兼容吸附 anchor） */
    private findMediaForElement(container: HTMLElement, target: HTMLElement): HTMLMediaElement | null {
        const all = container.querySelectorAll<HTMLElement>(MEDIA_SECTION_SELECTOR);
        let lastMedia: HTMLMediaElement | null = null;

        for (const el of Array.from(all)) {
            if (el === target) break;

            // 只考虑文档顺序位于 target 之前的元素
            const rel = target.compareDocumentPosition(el);
            if (rel & Node.DOCUMENT_POSITION_FOLLOWING) break;
            if (!(rel & Node.DOCUMENT_POSITION_PRECEDING)) continue;

            if (el.tagName === "AUDIO" || el.tagName === "VIDEO") {
                const media = el as HTMLMediaElement;
                if (!this.stickyManager.getAnchorForMedia(media)) {
                    lastMedia = media;
                }
            }
            else if (el.classList.contains("tsp-sticky-anchor")) {
                const media = this.stickyManager.getMediaForAnchor(el);
                if (media) lastMedia = media;
            }
        }
        return lastMedia;
    }

    private getTimestampsForMedia(container: HTMLElement, media: HTMLMediaElement): HTMLElement[] {
        const representative = this.stickyManager.getAnchorForMedia(media) || media;
        const all = container.querySelectorAll<HTMLElement>(MEDIA_SECTION_SELECTOR);

        let repIndex = -1;
        for (let i = 0; i < all.length; i++) {
            if (all[i] === representative) {
                repIndex = i;
                break;
            }
        }
        if (repIndex === -1) return [];

        const result: HTMLElement[] = [];
        for (let i = repIndex + 1; i < all.length; i++) {
            const el = all[i];
            let isNextRep = false;
            if (el.tagName === "AUDIO" || el.tagName === "VIDEO") {
                if (!this.stickyManager.getAnchorForMedia(el as HTMLMediaElement)) {
                    isNextRep = true;
                }
            } else if (el.classList.contains("tsp-sticky-anchor")) {
                isNextRep = true;
            }
            if (isNextRep) break;

            if (el.classList.contains("tsp-timestamp")) {
                result.push(el);
            }
        }
        return result;
    }

    private findActiveTimestamp(container: HTMLElement, media: HTMLMediaElement): HTMLElement | null {
        const currentTime = media.currentTime;
        let target: HTMLElement | null = null;
        let targetSeconds = -Infinity;
        for (const el of this.getTimestampsForMedia(container, media)) {
            const seconds = parseFloat(el.getAttribute("data-seconds") || "0");
            if (seconds <= currentTime && seconds > targetSeconds) {
                target = el;
                targetSeconds = seconds;
            }
        }
        return target;
    }

    private onTimeUpdate() {
        if (!this.activeMedia || !this.activeContainer) return;

        // 循环区间优先：到达终点后回到起点
        if (this.activeLoop && this.activeLoop.media === this.activeMedia) {
            if (this.activeMedia.currentTime >= this.activeLoop.end) {
                this.activeMedia.currentTime = this.activeLoop.start;
            }
        }

        const target = this.findActiveTimestamp(this.activeContainer, this.activeMedia);
        if (target && target !== this.activeBtn) {
            this.setActiveBtn(target);
        }
    }

    private setPlayIcon(icon: "play" | "pause") {
        if (!this.activeBtn) return;
        const el = this.activeBtn.querySelector(".tsp-play-icon");
        if (el) setIcon(el as HTMLElement, icon);
    }

    private setActiveBtn(btn?: HTMLElement | null) {
        if (this.activeBtn) {
            this.setPlayIcon("play");
            this.activeBtn.removeClass("tsp-active");
        }
        this.activeBtn = btn ?? null;
        if (btn) {
            btn.addClass("tsp-active");
            this.setPlayIcon(this.activeMedia && !this.activeMedia.paused ? "pause" : "play");
        }
    }

    private detachMediaListeners() {
        if (this.activeMedia) {
            if (this.boundTimeUpdate) this.activeMedia.removeEventListener("timeupdate", this.boundTimeUpdate);
            if (this.boundEnded) this.activeMedia.removeEventListener("ended", this.boundEnded);
            if (this.boundPause) this.activeMedia.removeEventListener("pause", this.boundPause);
            if (this.boundPlay) this.activeMedia.removeEventListener("play", this.boundPlay);
        }
        this.boundTimeUpdate = null;
        this.boundEnded = null;
        this.boundPause = null;
        this.boundPlay = null;
    }

    private releaseCurrentMedia() {
        this.detachMediaListeners();
        this.setActiveBtn(null);
    }

    private bindMediaListeners(media: HTMLMediaElement) {
        this.boundTimeUpdate = () => this.onTimeUpdate();
        this.boundEnded = () => {
            // 循环区间包含媒体结尾时，直接回到起点继续播放
            if (this.activeLoop && this.activeMedia && this.activeLoop.media === this.activeMedia) {
                this.activeMedia.currentTime = this.activeLoop.start;
                this.activeMedia.play().catch(() => {});
                return;
            }
            this.clearPlaybackState();
        };
        this.boundPause = () => this.setPlayIcon("play");
        this.boundPlay = () => this.setPlayIcon("pause");
        media.addEventListener("timeupdate", this.boundTimeUpdate);
        media.addEventListener("ended", this.boundEnded);
        media.addEventListener("pause", this.boundPause);
        media.addEventListener("play", this.boundPlay);
    }

    clearPlaybackState() {
        this.stopLoop();
        this.releaseCurrentMedia();
        this.activeMedia = null;
        this.activeContainer = null;
    }

    /** 插件卸载：解除全部自定义播放器包装，恢复原生媒体元素 */
    teardown() {
        this.stopLoop();
        for (const player of this.players) player.destroy();
        this.players.clear();
    }

    /** 遍历容器内的所有媒体元素并包装（阅读模式后处理器入口） */
    rewriteMediaElements(el: HTMLElement) {
        const mediaElements = el.querySelectorAll<HTMLMediaElement>("audio, video");
        for (const media of Array.from(mediaElements)) {
            this.wrapMediaElement(media);
        }
    }

    /** 包装单个媒体元素为 custom player（幂等，MutationObserver 入口） */
    wrapMediaElement(media: HTMLMediaElement) {
        if (media.hasAttribute("data-custom-player")) return;
        if (media.closest(".custom-media-player")) return;

        media.setAttribute("data-custom-player", "true");
        media.removeAttribute("controls");

        const player = new CustomMediaPlayer(media, this.app);
        player.build();
        this.players.add(player);

        const container = media.closest(".custom-media-player");
        if (container) {
            container.addEventListener("media-play", () => {
                if (this.activeMedia !== media) this.switchToMedia(media);
                else this.setPlayIcon("pause");
            });
            container.addEventListener("media-pause", () => {
                if (this.activeMedia === media) this.setPlayIcon("play");
            });
        }
    }

    private activateMedia(media: HTMLMediaElement, container: HTMLElement | null) {
        // 切换媒体时结束旧循环，同一媒体内则由调用方决定是否保留
        if (this.activeLoop && this.activeLoop.media !== media) this.stopLoop();
        this.releaseCurrentMedia();

        if (this.activeMedia && this.activeMedia !== media && !this.activeMedia.paused) {
            this.activeMedia.pause();
        }

        this.activeMedia = media;
        this.activeContainer = container;
        this.bindMediaListeners(media);
    }

    private switchToMedia(media: HTMLMediaElement) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        this.activateMedia(media, view?.containerEl || null);

        if (this.activeContainer) {
            const target = this.findActiveTimestamp(this.activeContainer, media);
            if (target) this.setActiveBtn(target);
        }
    }
}
