import { Menu, Notice, setIcon, App, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { SubtitleManager } from "./subtitle";
import { PlaybackSettingsModal, ShortcutSettingsModal } from "./settings-modals";
import { t } from "./i18n";
import { formatTime as fmtTime, parseTimestamp, TS_PATTERN } from "./utils/time";
import { parseKeyframes } from "./utils/keyframes";
import { getPlayerSettings, normalizeKeyEvent, SHORTCUT_DEFS, ShortcutTarget } from "./utils/player-settings";

export type StepSize = "frame" | "keyframe" | "5s";

/** 步长档位顺序：cycleStep 沿此顺序前后切换 */
const STEP_ORDER: readonly StepSize[] = ["frame", "keyframe", "5s"];

export class CustomMediaPlayer {
    private container: HTMLElement;
    private controls: HTMLElement;
    private progressBar: HTMLInputElement;
    private currentTimeLabel: HTMLElement;
    private durationLabel: HTMLElement;
    private playBtn: HTMLElement;
    private tooltip: HTMLElement | null = null;
    private volumeBtn: HTMLElement;
    private volumeSlider: HTMLInputElement;
    private pipBtn: HTMLElement | null = null;
    private fullscreenBtn: HTMLElement | null = null;
    private stepBtn: HTMLElement | null = null;
    private speedLabelEl: HTMLElement | null = null;
    private subtitleBtn: HTMLElement | null = null;
    /** 跳转步长档位：帧 / 关键帧 / 5 秒 */
    private step: StepSize = "5s";

    private hideTimeout: number | null = null;
    private isMouseOver = false;

    private lastFrameTime: number | null = null;
    private measuredFrameDuration: number | null = null;
    private frameCallbackBound: boolean = false;

    /** formatTime 是否输出毫秒（默认携带） */
    private timestampWithMs: boolean = true;

    private subtitleManager: SubtitleManager;

    /**
     * 关键帧时间表（秒，升序）：
     * - undefined = 尚未尝试解析
     * - null      = 尝试过但不可用（文件缺失 / 过大 / 解析失败）
     * - number[]  = 解析结果（可能为空数组，表示无独立关键帧）
     */
    private keyframes: number[] | null | undefined = undefined;
    /** 是否正在解析，避免首次连续按键重复读盘 */
    private keyframesLoading = false;
    /** 嵌入链接的原始 src（在包装、吸附前捕获，用于反查 vault 文件） */
    private embedSrc: string | null = null;

    /** 供 SHORTCUT_DEFS 调用的播放器能力集合 */
    private readonly shortcutContext: ShortcutTarget = {
        togglePlay: () => this.togglePlay(),
        seekByStep: (dir) => this.seekByStep(dir),
        cycleStep: (dir) => this.cycleStep(dir),
        adjustVolume: (delta) => this.adjustVolume(delta),
        toggleSubtitle: () => this.toggleSubtitle(),
        insertTimestamp: () => this.insertTimestamp(),
        toggleFullscreen: () => this.toggleFullscreen(),
    };

    constructor(private media: HTMLMediaElement, private app: App) {
        // 必须在媒体被移出 .internal-embed 之前捕获链接目标
        this.embedSrc = media.closest(".internal-embed, .media-embed")?.getAttribute("src") ?? null;
        this.container = createDiv({ cls: "custom-media-player", attr: { tabindex: "0" } });
        // 标记媒体类型，供移动端样式回退使用
        this.container.addClass(media.tagName === "AUDIO" ? "tsp-audio" : "tsp-video");
        media.parentNode?.insertBefore(this.container, media);
        this.container.appendChild(media);
        media.setCssStyles({ width: "100%" });
    }

    /** 媒体所属文档（可能与主窗口不同，用于弹出窗口 / 多窗口场景） */
    private get doc(): Document {
        return this.media.ownerDocument;
    }

    build() {
        this.controls = createDiv({ cls: "media-controls" });

        // 上排：进度条
        const topRow = createDiv({ cls: "media-controls-row", attr: { "data-media-row": "top" } });
        this.progressBar = createEl("input", {
            type: "range",
            cls: "media-progress",
            attr: { min: "0", max: "100", value: "0" },
        });
        topRow.appendChild(this.progressBar);
        this.controls.appendChild(topRow);

        // 下排：左（播放/暂停、音量、时间） + 右（画中画、全屏、设置）
        const bottomRow = createDiv({ cls: "media-controls-row", attr: { "data-media-row": "bottom" } });

        const leftGroup = createDiv({ cls: "media-controls-group", attr: { "data-media-group": "left" } });
        this.playBtn = this.createButton("play", () => this.togglePlay());
        leftGroup.appendChild(this.playBtn);

        const volContainer = createDiv({ cls: "media-volume-container" });
        this.volumeBtn = this.createButton("volume-2", (e) => {
            e.stopPropagation();
            this.media.muted = !this.media.muted;
            this.updateVolumeIcon();
        });
        volContainer.appendChild(this.volumeBtn);

        this.volumeSlider = createEl("input", {
            type: "range",
            cls: "media-volume-slider",
            attr: { min: "0", max: "1", step: "0.01" },
            value: String(this.media.volume),
        });
        this.volumeSlider.addEventListener("input", () => {
            this.media.volume = parseFloat(this.volumeSlider.value);
            this.media.muted = false;
            this.updateVolumeIcon();
        });
        volContainer.appendChild(this.volumeSlider);
        leftGroup.appendChild(volContainer);

        this.currentTimeLabel = createSpan({ cls: "media-time", text: "00:00" });
        leftGroup.appendChild(this.currentTimeLabel);

        this.durationLabel = createSpan({ cls: "media-time", text: " / 00:00" });
        leftGroup.appendChild(this.durationLabel);

        bottomRow.appendChild(leftGroup);

        // 右下角：向后、步长切换、向前、播放速度、字幕、画中画、全屏（仅视频）、设置
        const rightGroup = createDiv({ cls: "media-controls-group", attr: { "data-media-group": "right" } });

        const seekBackwardBtn = this.createButton("rewind", () => this.seekByStep(-1));
        seekBackwardBtn.setAttribute("aria-label", t("aria.rewind"));
        rightGroup.appendChild(seekBackwardBtn);

        this.stepBtn = createEl("button", { cls: "media-btn media-step-btn" });
        this.stepBtn.addEventListener("click", () => this.cycleStep(1));
        this.stepBtn.setAttribute("aria-label", t("aria.step"));
        rightGroup.appendChild(this.stepBtn);

        const seekForwardBtn = this.createButton("fast-forward", () => this.seekByStep(1));
        seekForwardBtn.setAttribute("aria-label", t("aria.forward"));
        rightGroup.appendChild(seekForwardBtn);

        // 播放速度：timer 图标 + 当前倍率，点击弹出倍率菜单
        const speedBtn = createEl("button", { cls: "media-btn media-speed-btn" });
        speedBtn.setAttribute("aria-label", t("aria.speed"));
        const speedIcon = createSpan({ cls: "media-speed-icon" });
        setIcon(speedIcon, "timer");
        speedBtn.appendChild(speedIcon);
        this.speedLabelEl = createSpan({ cls: "media-speed-label" });
        speedBtn.appendChild(this.speedLabelEl);
        speedBtn.addEventListener("click", (e) => this.showSpeedMenu(e));
        rightGroup.appendChild(speedBtn);

        // 字幕开关
        this.subtitleBtn = this.createButton("subtitles", () => this.toggleSubtitle());
        this.subtitleBtn.setAttribute("aria-label", t("aria.subtitle"));
        rightGroup.appendChild(this.subtitleBtn);

        if (this.media.tagName === "VIDEO") {
            if ('requestPictureInPicture' in this.media) {
                this.pipBtn = this.createButton("picture-in-picture", (e) => {
                    e.stopPropagation();
                    const pipPromise = this.doc.pictureInPictureElement
                        ? this.doc.exitPictureInPicture?.()
                        : (this.media as HTMLVideoElement).requestPictureInPicture?.();
                    void pipPromise?.catch(() => {});
                });
                rightGroup.appendChild(this.pipBtn);
            }
            this.fullscreenBtn = this.createButton("expand", (e) => {
                e.stopPropagation();
                this.toggleFullscreen();
            });
            rightGroup.appendChild(this.fullscreenBtn);
        }
        rightGroup.appendChild(this.createButton("settings", (e) => this.showSettings(e)));

        bottomRow.appendChild(rightGroup);
        this.controls.appendChild(bottomRow);

        this.container.appendChild(this.controls);

        this.subtitleManager = new SubtitleManager(this.media, this.container, this.app);

        this.showControls();

        this.container.addEventListener("mouseenter", () => {
            this.isMouseOver = true;
            this.showControls();
        });
        this.container.addEventListener("mouseleave", () => {
            this.isMouseOver = false;
            if (!this.media.paused) this.hideControls();
        });
        this.container.addEventListener("mousemove", () => this.resetHideTimer());

        this.media.addEventListener("play", () => {
            this.setPlayIcon("pause");
            this.dispatchMediaEvent('media-play');
            if (!this.isMouseOver) this.hideControls();
        });
        this.media.addEventListener("pause", () => {
            this.setPlayIcon("play");
            this.dispatchMediaEvent('media-pause');
            this.showControls();
            this.clearHideTimer();
        });
        this.media.addEventListener("ended", () => {
            this.setPlayIcon("play");
            this.dispatchMediaEvent('media-pause');
        });

        this.media.addEventListener("click", () => this.togglePlay());

        this.progressBar.addEventListener("input", () => {
            this.media.currentTime = (parseFloat(this.progressBar.value) / 100) * this.media.duration;
        });
        this.progressBar.addEventListener("click", (e) => {
            const rect = this.progressBar.getBoundingClientRect();
            this.media.currentTime = Math.max(0, ((e.clientX - rect.left) / rect.width) * this.media.duration);
        });
        this.progressBar.addEventListener("mousemove", (e) => this.showTooltip(e));
        this.progressBar.addEventListener("mouseleave", () => this.hideTooltip());

        this.media.addEventListener("timeupdate", () => this.updateProgress());
        this.media.addEventListener("loadedmetadata", () => this.updateDuration());
        this.media.addEventListener("seeked", () => this.updateProgress());

        this.container.addEventListener("keydown", (e) => {
            const binding = normalizeKeyEvent(e);
            const shortcuts = getPlayerSettings(this.app).shortcuts;
            const def = SHORTCUT_DEFS.find(d => shortcuts[d.id] === binding);
            if (!def) return;
            // 除个别编辑类操作外，其余快捷键都要等媒体就绪
            if (def.needsMedia !== false && this.media.readyState < 1) return;
            def.run(this.shortcutContext);
            e.preventDefault();
        });

        // 设置面板修改后由 refreshPlayers() 派发，实时应用新的播放方式 / 比例
        this.container.addEventListener("tsp-settings-changed", () => this.applyPlayerSettings());

        // 全屏 / 画中画状态图标同步
        this.container.addEventListener("fullscreenchange", () => {
            if (this.fullscreenBtn) setIcon(this.fullscreenBtn, this.doc.fullscreenElement ? "shrink" : "expand");
        });
        this.media.addEventListener("enterpictureinpicture", () => {
            if (this.pipBtn) setIcon(this.pipBtn, "picture-in-picture");
        });
        this.media.addEventListener("leavepictureinpicture", () => {
            if (this.pipBtn) setIcon(this.pipBtn, "picture-in-picture");
        });

        this.setupFrameTracking();
        this.updateVolumeIcon();
        this.updateStepLabel();
        this.updateSpeedLabel();
        this.updateSubtitleIcon();
        this.applyPlayerSettings();
    }

    /** 解除包装：把媒体元素放回原位并移除自定义控件（插件卸载时调用） */
    destroy() {
        this.clearHideTimer();
        this.hideTooltip();
        const media = this.media;
        media.removeAttribute("data-custom-player");
        media.setAttribute("controls", "");
        media.style.removeProperty("width");
        media.style.removeProperty("height");
        media.style.removeProperty("aspect-ratio");
        const parent = this.container.parentNode;
        if (parent) parent.insertBefore(media, this.container);
        this.container.remove();
    }

    /** 应用全局播放设置（播放方式 / 视频比例 / 屏幕方向） */
    private applyPlayerSettings() {
        const settings = getPlayerSettings(this.app);
        this.media.loop = settings.playbackMode === "loop";
        if (this.media.tagName !== "VIDEO") return;

        const video = this.media as HTMLVideoElement;
        const container = this.container;
        container.removeClass("tsp-orient-portrait");
        container.removeClass("tsp-orient-landscape");

        // 方向优先于画面比例：横屏 → 16:9，竖屏 → 9:16，自动 → 使用视频比例
        let ratio: string | null = settings.aspectRatio === "auto"
            ? null
            : settings.aspectRatio.replace(":", " / ");
        if (settings.orientation === "portrait") {
            ratio = "9 / 16";
            container.addClass("tsp-orient-portrait");
            video.setCssStyles({ width: "auto", height: "80vh" });
        } else {
            video.setCssStyles({ width: "100%" });
            video.style.removeProperty("height");
            if (settings.orientation === "landscape") {
                ratio = "16 / 9";
                container.addClass("tsp-orient-landscape");
            }
        }

        if (ratio) video.style.aspectRatio = ratio;
        else video.style.removeProperty("aspect-ratio");
    }

    private setPlayIcon(icon: "play" | "pause") {
        setIcon(this.playBtn, icon);
    }

    private showControls() {
        this.controls.addClass("is-visible");
        this.clearHideTimer();
    }

    private hideControls() {
        if (this.media.paused) {
            this.showControls();
            return;
        }
        this.clearHideTimer();
        this.hideTimeout = window.setTimeout(() => {
            this.controls.removeClass("is-visible");
            this.hideTimeout = null;
        }, 1000);
    }

    private seek(offset: number) {
        if (!this.media.duration) return;
        this.media.currentTime = Math.max(0, Math.min(this.media.duration, this.media.currentTime + offset));
    }

    private seekFrame(dir: 1 | -1) {
        this.seek(dir * (this.measuredFrameDuration ?? 1 / 30));
    }

    /** 按当前步长档位向前/向后跳转 */
    private seekByStep(dir: 1 | -1) {
        if (this.step === "frame") this.seekFrame(dir);
        else if (this.step === "keyframe") this.seekKeyframe(dir);
        else this.seek(5 * dir);
    }

    /** 切换步长档位：dir=1 放大（帧 → 关键帧 → 5 秒），dir=-1 缩小 */
    private cycleStep(dir: 1 | -1) {
        const i = STEP_ORDER.indexOf(this.step);
        this.step = STEP_ORDER[(i + dir + STEP_ORDER.length) % STEP_ORDER.length];
        this.updateStepLabel();
    }

    /** 同步步长按钮的文字标签 */
    private updateStepLabel() {
        if (this.stepBtn) {
            this.stepBtn.textContent = this.step === "frame" ? t("step.frame")
                : this.step === "keyframe" ? t("step.keyframe")
                : t("step.5s");
        }
    }

    /** 弹出播放速度菜单（当前倍率打勾） */
    private showSpeedMenu(e: MouseEvent) {
        const menu = new Menu();
        [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].forEach(sp =>
            menu.addItem(item =>
                item.setTitle(this.formatRate(sp))
                    .setChecked(Math.abs(this.media.playbackRate - sp) < 0.001)
                    .onClick(() => {
                        this.media.playbackRate = sp;
                        this.updateSpeedLabel();
                    })
            )
        );
        this.showMenuAt(menu, e.currentTarget as HTMLElement);
    }

    /** 同步步率按钮的文字标签 */
    private updateSpeedLabel() {
        if (this.speedLabelEl) this.speedLabelEl.textContent = this.formatRate(this.media.playbackRate);
    }

    /** 字幕关闭时图标改为 captions-off */
    private updateSubtitleIcon() {
        if (this.subtitleBtn) {
            setIcon(this.subtitleBtn, this.subtitleManager.isEnabled() ? "subtitles" : "captions-off");
        }
    }

    /** 倍率显示：1 → "1x"，1.25 → "1.25x" */
    private formatRate(rate: number): string {
        return (Math.round(rate * 100) / 100) + "x";
    }

    /** 跳到当前时间附近的上/下一个关键帧（PotPlayer 行为） */
    private seekKeyframe(dir: 1 | -1) {
        if (!this.media.duration) return;
        const kf = this.keyframes;

        if (kf === undefined) {
            // 首次按键：惰性解析关键帧表（避免每个嵌入构建时都整体读盘），
            // 本次先按帧步进；解析完成后自动使用真实关键帧
            void this.loadKeyframes();
            this.seekFrame(dir);
            return;
        }
        if (kf === null || kf.length === 0) {
            // 文件不可用 / 无独立关键帧（如全 I 帧流）：退化为逐帧
            this.seekFrame(dir);
            return;
        }

        // 时间表升序，二分查找避免长视频下的线性扫描卡顿
        const t = this.media.currentTime;
        let lo = 0, hi = kf.length;
        if (dir > 0) {
            const key = t + 0.05;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (kf[mid] > key) hi = mid; else lo = mid + 1;
            }
            if (lo < kf.length) this.media.currentTime = kf[lo];
        } else {
            const key = t - 0.05;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (kf[mid] < key) lo = mid + 1; else hi = mid;
            }
            if (lo > 0) this.media.currentTime = kf[lo - 1];
        }
    }

    /** 从嵌入元素反查 vault 文件并异步解析关键帧时间表 */
    private async loadKeyframes() {
        if (this.keyframesLoading || this.keyframes !== undefined) return;
        this.keyframesLoading = true;
        try {
            const file = this.resolveSourceFile();
            if (!(file instanceof TFile)) { this.keyframes = null; return; }
            const stat = await this.app.vault.adapter.stat(file.path);
            // 超大文件整体读取不划算，放弃解析
            if (stat && stat.size > 256 * 1024 * 1024) { this.keyframes = null; return; }
            const buf = await this.app.vault.adapter.readBinary(file.path);
            const parsed = parseKeyframes(buf);
            parsed.sort((a, b) => a - b);
            this.keyframes = parsed;
        } catch {
            this.keyframes = null;
        } finally {
            this.keyframesLoading = false;
        }
    }

    /**
     * 反查媒体对应的 vault 文件。
     * 嵌入的 src 是「链接目标」而非 vault 绝对路径（可能是短名、相对路径、
     * 含空格 / 中文的编码名），必须走 Obsidian 的链接解析规则。
     */
    private resolveSourceFile(): TFile | null {
        const raw = (this.embedSrc ?? "").split("#")[0].split("|")[0].trim();
        if (raw) {
            let linkpath = raw;
            try { linkpath = decodeURIComponent(raw); } catch { /* 保持原值 */ }
            const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, "");
            if (dest instanceof TFile) return dest;
            // 回退：全库按文件名唯一匹配
            const name = linkpath.split("/").pop();
            if (name) {
                const matches = this.app.vault.getFiles().filter(f => f.name === name);
                if (matches.length === 1) return matches[0];
            }
        }
        return this.resolveFromMediaUrl();
    }

    /** 以媒体实际 URL 为线索，剥离 vault 根路径反查文件（嵌入 src 缺失时兜底） */
    private resolveFromMediaUrl(): TFile | null {
        const src = this.media.currentSrc || this.media.src;
        if (!src || src.startsWith("blob:")) return null;
        const base = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
        if (!base) return null;
        let pathname: string;
        try { pathname = decodeURIComponent(new URL(src).pathname); } catch { return null; }
        const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
        let p = norm(pathname);
        // app:// URL 的 pathname 在 Windows 上会多出前导斜杠（/D:/…）
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
        const b = norm(base);
        if (p.length > b.length && p.slice(0, b.length + 1).toLowerCase() === (b + "/").toLowerCase()) {
            const rel = p.slice(b.length + 1);
            const file = this.app.vault.getAbstractFileByPath(rel);
            if (file instanceof TFile) return file;
        }
        return null;
    }

    private adjustVolume(delta: number) {
        const v = Math.max(0, Math.min(1, this.media.volume + delta));
        this.media.volume = v;
        // 从静音状态调整时自动解除静音
        if (v > 0 && this.media.muted) this.media.muted = false;
        this.updateVolumeIcon();
    }

    /**
     * 将当前时间戳按时间顺序插入到该媒体对应的"时间戳队列"中。
     *
     * 队列定义：从媒体源行往下，连续的"时间戳行"（时间戳位于行首或行尾）
     * 构成队列；允许媒体行与首个时间戳行之间存在前导空行；遇到队列外的
     * 非时间戳行或下一个媒体即终止。
     *
     * 插入规则：
     *   - 队列为空 → 紧贴媒体行下方插入新行
     *   - 队列非空 → 找到第一个时间戳 **严格大于** 当前时间的行，
     *     插到该行之前；若不存在（当前时间大于队列内所有时间戳），
     *     追加到队列末尾
     *
     * 仅支持实时预览：需要能从媒体 DOM 反查 CodeMirror 视图与文档位置。
     */
    private insertTimestamp() {
        const cmEditor = this.media.closest<HTMLElement>(".cm-editor");
        const cmView = cmEditor ? EditorView.findFromDOM(cmEditor) : null;
        if (!cmView) {
            new Notice(t("notice.insertPreviewOnly"));
            return;
        }

        let mediaLine;
        try {
            const target = this.media.closest<HTMLElement>(".cm-line") ?? this.media;
            const pos = cmView.posAtDOM(target);
            mediaLine = cmView.state.doc.lineAt(pos);
        } catch {
            new Notice(t("notice.noMediaLine"));
            return;
        }

        const doc = cmView.state.doc;

        // 收集媒体行之后的连续时间戳行（允许前导空行，遇到队列外的非时间戳行终止）
        const tsLines: { from: number; to: number; seconds: number }[] = [];
        let scanLineNo = mediaLine.number + 1;

        while (scanLineNo <= doc.lines) {
            const line = doc.line(scanLineNo);
            const text = line.text.trim();

            if (text === "") {
                // 队列尚未开始时允许前导空行；一旦已经开始收集，空行意味着队列结束
                if (tsLines.length === 0) { scanLineNo++; continue; }
                break;
            }

            const m = text.match(TS_PATTERN);
            if (!m) break;

            // 时间戳必须位于行的开头或末尾，才视为队列成员
            const idx = m.index ?? -1;
            const end = idx + m[0].length;
            if (idx !== 0 && end !== text.length) break;

            tsLines.push({ from: line.from, to: line.to, seconds: parseTimestamp(m[0]) });
            scanLineNo++;
        }

        const currentTime = this.media.currentTime;
        const ts = this.formatTime(currentTime);

        let insertPos: number;
        let insert: string;
        let cursor: number;

        if (tsLines.length === 0) {
            // 队列为空：紧贴媒体行下方插入
            insertPos = mediaLine.to;
            insert = "\n" + ts;
            cursor = insertPos + insert.length;
        } else {
            // 找到第一个时间戳严格大于当前时间的行
            const idx = tsLines.findIndex(t => t.seconds > currentTime);
            if (idx >= 0) {
                // 插到该行之前
                insertPos = tsLines[idx].from;
                insert = ts + "\n";
                cursor = insertPos + ts.length;
            } else {
                // 所有时间戳都不大于当前时间：追加到队列末尾
                insertPos = tsLines[tsLines.length - 1].to;
                insert = "\n" + ts;
                cursor = insertPos + insert.length;
            }
        }

        cmView.dispatch({
            changes: { from: insertPos, insert },
            selection: { anchor: cursor },
        });

        new Notice(t("notice.inserted", { time: ts }));
    }

    private setupFrameTracking() {
        const video = this.media as HTMLVideoElement;
        if (!('requestVideoFrameCallback' in video) || this.frameCallbackBound) return;
        this.frameCallbackBound = true;

        const callback = (_now: number, meta: VideoFrameCallbackMetadata) => {
            const t = meta.presentationTime;
            if (this.lastFrameTime !== null) {
                const dur = t - this.lastFrameTime;
                if (dur > 0.001 && dur < 1.0) this.measuredFrameDuration = dur;
            }
            this.lastFrameTime = t;
            if (!this.media.paused) video.requestVideoFrameCallback(callback);
        };

        this.media.addEventListener("play", () => {
            video.requestVideoFrameCallback(callback);
        });
    }

    private resetHideTimer() {
        this.showControls();
        if (!this.media.paused) this.hideControls();
    }

    private clearHideTimer() {
        if (this.hideTimeout !== null) {
            window.clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    private togglePlay() {
        if (this.media.paused) {
            this.media.play().catch(() => {});
        } else {
            this.media.pause();
        }
    }

    private toggleSubtitle() {
        this.subtitleManager.setEnabled(!this.subtitleManager.isEnabled());
        this.updateSubtitleIcon();
    }

    private toggleFullscreen() {
        if (this.media.tagName !== "VIDEO") return;
        if (this.doc.fullscreenElement) {
            this.doc.exitFullscreen().catch(() => {});
        } else {
            this.container.requestFullscreen?.().catch(() => {});
        }
    }

    private dispatchMediaEvent(type: string) {
        this.container.dispatchEvent(new CustomEvent(type, {
            bubbles: true,
            detail: { media: this.media },
        }));
    }

    private updateProgress() {
        if (!this.media.duration) return;
        const pct = (this.media.currentTime / this.media.duration) * 100;
        this.progressBar.value = String(pct);
        this.progressBar.style.setProperty("--mp-progress", pct + "%");
        this.currentTimeLabel.textContent = this.formatTime(this.media.currentTime);
    }

    private updateDuration() {
        if (this.media.duration) {
            this.durationLabel.textContent = " / " + this.formatTime(this.media.duration);
        }
        this.updateProgress();
    }

    private formatTime(seconds: number): string {
        return fmtTime(seconds, this.timestampWithMs);
    }

    private updateVolumeIcon() {
        const vol = this.media.volume;
        const muted = this.media.muted;
        setIcon(this.volumeBtn, muted || vol === 0 ? "volume-off" : vol < 0.33 ? "volume-1" : "volume-2");
        const shown = muted ? 0 : vol;
        this.volumeSlider.value = String(shown);
        this.volumeSlider.style.setProperty("--mp-progress", shown * 100 + "%");
    }

    private showTooltip(e: MouseEvent) {
        if (!this.media.duration) return;
        const rect = this.progressBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (!this.tooltip) {
            this.tooltip = createDiv({ cls: "media-tooltip" });
            this.doc.body.appendChild(this.tooltip);
        }
        this.tooltip.textContent = this.formatTime(pct * this.media.duration);
        this.tooltip.style.left = (e.clientX - this.tooltip.offsetWidth / 2) + "px";
        this.tooltip.style.top = (rect.top - 30) + "px";
        this.tooltip.setCssStyles({ display: "block" });
    }

    private hideTooltip() {
        // 悬停结束即移除，避免播放器销毁后残留节点泄漏
        this.tooltip?.remove();
        this.tooltip = null;
    }

    private showSettings(e: MouseEvent) {
        const menu = new Menu();

        menu.addItem((item) => {
            item.setTitle(t("menu.ms"))
                .setIcon("timer")
                .setChecked(this.timestampWithMs)
                .onClick(() => {
                    this.timestampWithMs = !this.timestampWithMs;
                    this.updateDuration();
                    this.updateProgress();
                    new Notice(this.timestampWithMs ? t("notice.msOn") : t("notice.msOff"));
                });
        });

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle(t("menu.copy"))
                .setIcon("copy")
                .onClick(() => {
                    const ts = this.formatTime(this.media.currentTime);
                    navigator.clipboard.writeText(ts)
                        .then(() => new Notice(t("notice.copied", { time: ts })))
                        .catch(() => new Notice(t("notice.copyFailed", { time: ts })));
                });
        });

        menu.addItem((item) => {
            item.setTitle(t("menu.insert"))
                .setIcon("text-cursor-input")
                .onClick(() => this.insertTimestamp());
        });

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle(t("menu.playback"))
                .setIcon("wrench")
                .onClick(() => new PlaybackSettingsModal(this.app).open());
        });

        menu.addItem((item) => {
            item.setTitle(t("menu.shortcuts"))
                .setIcon("keyboard")
                .onClick(() => new ShortcutSettingsModal(this.app).open());
        });

        this.showMenuAt(menu, e.target as HTMLElement);
    }

    private showMenuAt(menu: Menu, target: HTMLElement) {
        const rect = target.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
        if (this.doc.fullscreenElement === this.container) {
            const el = (menu as Menu & { dom?: HTMLElement }).dom;
            if (el) {
                this.container.appendChild(el);
                el.setCssStyles({ zIndex: "9999" });
            }
        }
    }

    private createButton(iconName: string, onClick: (e: MouseEvent) => void): HTMLElement {
        const btn = createEl("button", { cls: "media-btn" });
        setIcon(btn, iconName);
        btn.addEventListener("click", onClick);
        return btn;
    }
}
