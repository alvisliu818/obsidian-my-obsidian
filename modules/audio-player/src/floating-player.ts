import { Notice, setIcon, TFile } from "obsidian";
import { t } from "./i18n";
import type { MediaBinding, MediaType, ParsedTimestamp } from "./media-binding";
import { getNavigationBehavior, getNavigationAction } from "./settings";
import type { AudioPlayerSettings } from "./settings";

/**
 * 顶置悬浮播放器（移植自 obsidian-audio-timestamp-player 的 MediaPlayerManager，0BSD）。
 *
 * 与基底 in-place 自定义播放器的分工：本播放器挂在 leaf 容器上（笔记内容
 * 子树之外），因此模式切换、长笔记滚动（CM 虚拟化）、分栏重渲染都不会
 * 打断播放。两种入模方式：
 *
 *  A. create —— 纯源码模式等场景下点击链接时间戳，按绑定文件现场创建
 *      （原生 controls + 视频宽高比拖拽缩放，尺寸持久化）；
 *  B. adopt  —— 基底 in-place 播放中的媒体因重渲染 / 切页断连时，把
 *      `.custom-media-player` 包装整体收养进来（保留基底完整控件）。
 */
export class FloatingPlayerManager {
    private containerEl: HTMLDivElement | null = null;
    private mediaEl: HTMLAudioElement | HTMLVideoElement | null = null;
    private labelEl: HTMLDivElement | null = null;
    private closeButtonEl: HTMLButtonElement | null = null;
    private resizeHandleEl: HTMLElement | null = null;
    private context: PlaybackContext | null = null;
    /** 当前媒体是否由本播放器创建（false = 收养的 in-place 包装） */
    private createdMedia = false;

    constructor(
        private readonly app: { vault: { getResourcePath(file: TFile): string } },
        private readonly getSettings: () => AudioPlayerSettings,
        private readonly saveVideoSize: (width: number, height: number) => Promise<void>,
        private readonly onClose: (media: HTMLMediaElement | null) => void,
    ) {}

    /** A. 按绑定文件创建/复用播放器并跳转播放，返回承载媒体（元数据就绪前失败返回 null） */
    async playFromFile(
        binding: MediaBinding,
        parsed: ParsedTimestamp,
        sourceView: HTMLElement,
        note: TFile,
    ): Promise<HTMLMediaElement | null> {
        const ownerDocument = sourceView.ownerDocument;
        const player = this.ensurePlayer(ownerDocument, parsed.mediaType, sourceView, false);
        this.pauseNativePlayers(sourceView, player);

        if (this.context?.mediaPath !== binding.file.path) {
            player.pause();
            player.src = this.app.vault.getResourcePath(binding.file);
            player.load();
        }

        this.context = {
            sourceNotePath: note.path,
            sourceNoteName: note.basename,
            mediaPath: binding.file.path,
            mediaFileName: binding.file.name,
            mediaId: binding.id,
            mediaType: parsed.mediaType,
            ownerDocument,
        };
        this.createdMedia = true;
        this.refreshPresentation();

        await this.waitForMetadata(player, parsed.mediaType);
        if (player.readyState < HTMLMediaElement.HAVE_METADATA) return null;

        player.currentTime = Math.min(
            parsed.seconds,
            Number.isFinite(player.duration) ? player.duration : parsed.seconds,
        );
        try {
            await player.play();
        } catch {
            new Notice(t("notice.playbackBlocked"));
        }
        return player;
    }

    /** B. 收养一个仍在播放、但已（或即将）与笔记内容断连的媒体元素 */
    adopt(
        media: HTMLMediaElement,
        ctx: {
            sourceNotePath: string;
            sourceNoteName: string;
            mediaType: MediaType;
            mediaId: string | null;
            sourceView: HTMLElement;
        },
    ): void {
        if (this.mediaEl === media && this.containerEl?.isConnected) {
            this.attachToSourceLeaf(ctx.sourceView);
            return;
        }

        this.close();
        const container = this.ensureContainer(media.ownerDocument, ctx.mediaType, ctx.sourceView, true);
        this.pauseNativePlayers(ctx.sourceView, media);

        // 收养优先搬 `.custom-media-player` 包装（保留基底完整控件），裸媒体元素直接搬
        const wrapper = media.closest<HTMLElement>(".custom-media-player") ?? media;
        if (wrapper.parentElement !== container) container.appendChild(wrapper);

        const closeButton = container.createEl("button", {
            cls: "tsp-floating-close clickable-icon",
            attr: { type: "button" },
        });
        setIcon(closeButton, "x");
        closeButton.addEventListener("click", () => this.close());

        this.containerEl = container;
        this.mediaEl = media;
        this.closeButtonEl = closeButton;
        this.resizeHandleEl = null;
        this.createdMedia = false;
        this.context = {
            sourceNotePath: ctx.sourceNotePath,
            sourceNoteName: ctx.sourceNoteName,
            mediaPath: "",
            mediaFileName: "",
            mediaId: ctx.mediaId,
            mediaType: ctx.mediaType,
            ownerDocument: media.ownerDocument,
        };
        this.refreshPresentation();
    }

    /** 切页 / 文件打开时的行为决策（continue 由调用方处理，这里只管 pause/close/挪窝） */
    handleNavigation(activeFile: TFile | null): void {
        if (!this.context) return;
        const behavior = getNavigationBehavior(this.getSettings(), this.context.mediaType);
        const action = getNavigationAction(
            behavior,
            activeFile?.path === this.context.sourceNotePath,
        );
        if (action === "pause") this.mediaEl?.pause();
        if (action === "close") this.close();
        else this.attachToMainActiveLeaf(this.context.ownerDocument);
    }

    refreshPresentation(): void {
        const context = this.context;
        const container = this.containerEl;
        if (!context || !container) return;

        const mediaName = t(context.mediaType === "audio" ? "media.audio" : "media.video");
        container.setAttribute("aria-label", t("aria.floatingPlayer"));
        container.toggleClass("is-video", context.mediaType === "video");
        container.toggleClass("tsp-floating-adopted", !this.createdMedia);

        if (this.createdMedia && context.mediaType === "video") {
            const settings = this.getSettings();
            container.style.width = `${settings.videoPlayerWidth}px`;
            container.style.height = `${settings.videoPlayerHeight}px`;
        } else {
            container.style.removeProperty("width");
            container.style.removeProperty("height");
        }

        this.closeButtonEl?.setAttribute("aria-label", t("aria.closeFloating"));
        this.resizeHandleEl?.setAttribute("aria-label", t("aria.resizeVideo"));
        this.resizeHandleEl?.toggleClass(
            "is-hidden",
            !this.createdMedia
                || context.mediaType !== "video"
                || !this.getSettings().videoResizeEnabled,
        );

        if (!this.labelEl) return;
        this.labelEl.empty();
        this.labelEl.createDiv({
            cls: "tsp-floating-alias",
            text: context.mediaId ?? mediaName,
        });
        this.labelEl.createDiv({
            cls: "tsp-floating-source",
            text: context.mediaFileName
                ? `${context.mediaFileName} · ${context.sourceNoteName}`
                : context.sourceNoteName,
        });
    }

    /** 关闭并移除悬浮播放器；收养的媒体随容器一起移除（其原宿主多已重渲染） */
    close(): void {
        const media = this.mediaEl;
        if (media && this.createdMedia) {
            media.pause();
            media.removeAttribute("src");
            media.load();
        } else if (media) {
            media.pause();
        }
        this.containerEl?.remove();
        this.containerEl = null;
        this.mediaEl = null;
        this.labelEl = null;
        this.closeButtonEl = null;
        this.resizeHandleEl = null;
        this.context = null;
        this.createdMedia = false;
        this.onClose(media);
    }

    destroy(): void {
        this.close();
    }

    /** 关掉正承载指定媒体的悬浮播放器（切走到其它媒体时调用） */
    closeIfMedia(media: HTMLMediaElement | null): void {
        if (media && this.mediaEl === media) this.close();
    }

    // ------------------------------------------------------------------

    private ensurePlayer(
        ownerDocument: Document,
        mediaType: MediaType,
        view: HTMLElement,
        adopted: boolean,
    ): HTMLAudioElement | HTMLVideoElement {
        if (
            this.mediaEl?.isConnected &&
            this.context?.mediaType === mediaType &&
            this.containerEl?.ownerDocument === ownerDocument &&
            this.createdMedia === !adopted
        ) {
            this.attachToSourceLeaf(view);
            return this.mediaEl;
        }

        this.close();
        const container = this.ensureContainer(ownerDocument, mediaType, view, adopted);
        const media = container.createEl(mediaType, {
            cls: `tsp-floating-media tsp-floating-${mediaType}`,
        });
        media.controls = true;
        media.preload = "metadata";
        if (mediaType === "video") (media as HTMLVideoElement).playsInline = true;

        const closeButton = container.createEl("button", {
            cls: "tsp-floating-close clickable-icon",
            attr: { type: "button" },
        });
        setIcon(closeButton, "x");
        closeButton.addEventListener("click", () => this.close());

        const resizeHandle = container.createDiv({
            cls: "tsp-floating-resize-handle is-hidden",
            attr: {
                role: "separator",
                tabindex: "0",
                "aria-orientation": "horizontal",
            },
        });
        this.registerResizeHandle(resizeHandle, container);

        this.containerEl = container;
        this.mediaEl = media;
        this.closeButtonEl = closeButton;
        this.resizeHandleEl = resizeHandle;
        this.createdMedia = !adopted;
        return media;
    }

    private ensureContainer(
        ownerDocument: Document,
        mediaType: MediaType,
        view: HTMLElement,
        adopted: boolean,
    ): HTMLDivElement {
        const host = this.findSourceLeaf(view)
            ?? this.findMainActiveLeaf(ownerDocument)
            ?? ownerDocument.querySelector<HTMLElement>(".workspace")
            ?? ownerDocument.body;
        const container = host.createDiv({
            cls: `tsp-floating-player${mediaType === "video" ? " is-video" : ""}${adopted ? " tsp-floating-adopted" : ""}`,
            attr: { role: "region" },
        });
        this.labelEl = container.createDiv({ cls: "tsp-floating-label" });
        return container;
    }

    /** 视频拖拽缩放：按视频实际宽高比反算高度，clamp 到宿主范围内，松手持久化 */
    private registerResizeHandle(handle: HTMLElement, container: HTMLElement): void {
        handle.addEventListener("pointerdown", (event) => {
            if (!this.getSettings().videoResizeEnabled) return;
            event.preventDefault();
            event.stopPropagation();
            const initialBounds = container.getBoundingClientRect();
            const video = this.mediaEl?.tagName === "VIDEO"
                ? this.mediaEl as HTMLVideoElement
                : null;
            const videoBounds = video?.getBoundingClientRect();
            const aspectRatio = video?.videoWidth && video.videoHeight
                ? video.videoWidth / video.videoHeight
                : 16 / 9;
            const horizontalChrome = Math.max(
                0,
                initialBounds.width - (videoBounds?.width ?? initialBounds.width),
            );
            const verticalChrome = Math.max(
                0,
                initialBounds.height - (videoBounds?.height ?? initialBounds.height),
            );
            const host = container.parentElement;
            const hostBounds = host?.getBoundingClientRect() ?? initialBounds;
            const startX = event.clientX;
            const startY = event.clientY;
            handle.setPointerCapture(event.pointerId);

            const move = (moveEvent: PointerEvent): void => {
                const maximumWidthFromHost = Math.max(320, hostBounds.width - 48);
                const maximumHeight = Math.max(
                    192,
                    hostBounds.bottom - initialBounds.top - 24,
                );
                const maximumWidthFromHeight = horizontalChrome + Math.max(
                    0,
                    maximumHeight - verticalChrome,
                ) * aspectRatio;
                const maximumWidth = Math.min(maximumWidthFromHost, maximumWidthFromHeight);
                const horizontalDelta = moveEvent.clientX - startX;
                const verticalDeltaAsWidth = (moveEvent.clientY - startY) * aspectRatio;
                const sizeDelta = Math.abs(horizontalDelta) >= Math.abs(verticalDeltaAsWidth)
                    ? horizontalDelta
                    : verticalDeltaAsWidth;
                const width = Math.min(
                    maximumWidth,
                    Math.max(320, initialBounds.width + sizeDelta),
                );
                const videoWidth = Math.max(0, width - horizontalChrome);
                const height = verticalChrome + videoWidth / aspectRatio;
                container.style.width = `${Math.round(width)}px`;
                container.style.height = `${Math.round(height)}px`;
            };

            const finish = (upEvent: PointerEvent): void => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", finish);
                handle.removeEventListener("pointercancel", finish);
                if (handle.hasPointerCapture(upEvent.pointerId)) {
                    handle.releasePointerCapture(upEvent.pointerId);
                }
                const bounds = container.getBoundingClientRect();
                void this.saveVideoSize(Math.round(bounds.width), Math.round(bounds.height));
            };

            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", finish);
            handle.addEventListener("pointercancel", finish);
        });
    }

    private attachToSourceLeaf(view: HTMLElement): void {
        const leaf = this.findSourceLeaf(view);
        const container = this.containerEl;
        if (leaf && container && container.parentElement !== leaf) {
            leaf.appendChild(container);
        }
    }

    private attachToMainActiveLeaf(ownerDocument: Document): void {
        const leaf = this.findMainActiveLeaf(ownerDocument);
        const container = this.containerEl;
        if (leaf && container && container.parentElement !== leaf) {
            leaf.appendChild(container);
        }
    }

    private findSourceLeaf(view: HTMLElement): HTMLElement | null {
        const leaf = view.closest<HTMLElement>(".workspace-leaf");
        return leaf?.closest(".workspace-split.mod-root") ? leaf : null;
    }

    private findMainActiveLeaf(ownerDocument: Document): HTMLElement | null {
        return ownerDocument.querySelector<HTMLElement>(
            ".workspace-split.mod-root .workspace-leaf.mod-active",
        );
    }

    /** 播放前暂停视图内其它原生 embed（本播放器自己的媒体除外） */
    private pauseNativePlayers(view: HTMLElement, own: HTMLMediaElement): void {
        for (const player of Array.from(
            view.querySelectorAll<HTMLMediaElement>("audio, video"),
        )) {
            if (player !== own) player.pause();
        }
    }

    private async waitForMetadata(
        player: HTMLMediaElement,
        mediaType: MediaType,
    ): Promise<void> {
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA) return;

        await new Promise<void>((resolve, reject) => {
            player.addEventListener("loadedmetadata", () => resolve(), { once: true });
            player.addEventListener(
                "error",
                () => reject(new Error("Media metadata failed to load.")),
                { once: true },
            );
        }).catch(() => {
            new Notice(t("notice.mediaLoadFailed", {
                media: t(mediaType === "audio" ? "media.audio" : "media.video"),
            }));
        });
    }
}

interface PlaybackContext {
    sourceNotePath: string;
    sourceNoteName: string;
    mediaPath: string;
    mediaFileName: string;
    mediaId: string | null;
    mediaType: MediaType;
    ownerDocument: Document;
}
