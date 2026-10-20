import { Plugin, MarkdownView, MarkdownPostProcessorContext, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { StickyMediaManager } from "./sticky-media";
import { TimestampManager } from "./timestamps";
import { createLivePreviewTimestampExtension } from "./timestamps-live-preview";
import { createEditorTimestampExtension } from "./editor-extension";
import { findTimestampTarget } from "./timestamp-target";
import { MediaBindingIndex } from "./media-binding";
import { FloatingPlayerManager } from "./floating-player";
import { AudioPlayerSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";
import type { AudioPlayerSettings } from "./settings";
import { t } from "./i18n";
import { initPlayerSettings } from "./utils/player-settings";

const MEDIA_EMBED_RE = /!\[\[.+?\.(mp3|webm|wav|m4a|ogg|3gp|flac|mp4|mov|avi|mkv|mpeg)\]\]/i;

export default class TimestampPlayerPlugin extends Plugin {
    /** 模块自己的设置（切页行为 / 悬浮视频尺寸），经宿主 loadData/saveData 分片持久化 */
    settings: AudioPlayerSettings = DEFAULT_SETTINGS;
    private stickyManager!: StickyMediaManager;
    private timestampManager!: TimestampManager;
    private floatingPlayer!: FloatingPlayerManager;
    private bindingIndex!: MediaBindingIndex;
    private mediaObserver: MutationObserver | null = null;
    private stickyEnabled = false;
    private instrumentedViews = new WeakSet<MarkdownView>();
    private disconnectCheckScheduled = false;

    async onload() {
        const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        await initPlayerSettings(this.app, pluginDir);
        this.settings = normalizeSettings(await this.loadData());

        this.bindingIndex = new MediaBindingIndex(this.app);
        this.stickyManager = new StickyMediaManager(this.app);
        this.stickyManager.initialize();
        this.floatingPlayer = new FloatingPlayerManager(
            this.app,
            () => this.settings,
            (width, height) => this.saveVideoSize(width, height),
            (media) => this.timestampManager?.releaseIfMedia(media),
        );
        this.timestampManager = new TimestampManager(
            this.app,
            this.stickyManager,
            this.bindingIndex,
            this.floatingPlayer,
            () => this.settings,
        );

        // 阅读模式 / 嵌入块的常规路径
        this.registerMarkdownPostProcessor(
            async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
                if (!(await this.hasMediaEmbed(ctx))) return;
                this.timestampManager.processLoopTimestamps(el);
                this.timestampManager.processTimestamps(el);
                // 链接语法时间戳按钮化须在裸时间戳之后：先处理的不受后者幂等 guard 影响
                this.timestampManager.processLinkTimestamps(el);
                this.timestampManager.rewriteMediaElements(el);
                this.stickyManager.setupForElement(el);
            }
        );

        // 实时预览的时间戳渲染（裸时间戳 / 循环区间 / 链接语法）
        this.registerEditorExtension(
            createLivePreviewTimestampExtension(this.timestampManager)
        );

        // 编辑态链接时间戳点击（Live Preview 行内文本 / 纯源码模式，光标落在链接上时装饰被抑制）
        this.registerEditorExtension(
            createEditorTimestampExtension(this.timestampManager)
        );

        // 文档级捕获点击兜底：阅读态未按钮化的链接（如无媒体嵌入的笔记）也走显式绑定
        this.registerDomEvent(activeDocument, "click", (event: MouseEvent) => {
            const target = event.target as Element | null;
            if (!target || typeof target.closest !== "function") return;
            const linkTarget = findTimestampTarget(event, target);
            if (!linkTarget) return;
            void this.timestampManager.handleLinkClick(event, target, linkTarget);
        }, true);

        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                this.stickyManager.scan();
                this.instrumentStickyToggle();
            })
        );

        // 切页存活：悬浮播放器与 in-place 播放各自按配置行为处理
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                if (!this.isMainWorkspaceLeaf(leaf)) return;
                const file = this.getLeafFile(leaf);
                this.floatingPlayer.handleNavigation(file);
                this.timestampManager.handleNavigation(file);
            })
        );
        this.registerEvent(
            this.app.workspace.on("file-open", (file) => {
                this.floatingPlayer.handleNavigation(file);
                this.timestampManager.handleNavigation(file);
            })
        );

        // 绑定缓存失效
        this.registerEvent(this.app.vault.on("modify", (file) => this.invalidateNote(file)));
        this.registerEvent(this.app.vault.on("delete", (file) => this.invalidateNote(file)));
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                this.bindingIndex.invalidate(oldPath);
                this.invalidateNote(file);
            })
        );

        this.addSettingTab(new AudioPlayerSettingTab(this.app, this));

        // 兜底：监听动态插入的媒体元素（覆盖实时预览路径）
        this.setupMediaObserver();
        this.instrumentStickyToggle();

        // 加载时刷新已打开的标签页，让插件立即生效
        window.setTimeout(() => this.refreshActiveView(), 0);
    }

    onunload() {
        this.timestampManager.clearPlaybackState();
        this.stickyManager.destroy();
        this.floatingPlayer.destroy();
        this.mediaObserver?.disconnect();
        this.mediaObserver = null;

        // 显式清理 DOM 产物（re-render 无法覆盖）：自定义播放器、吸附开关、装饰节点
        this.timestampManager.teardown();
        this.removeViewArtifacts();

        // 延迟到 Obsidian 清理完注册项后再刷新，还原时间戳等后处理器产物
        window.setTimeout(() => this.refreshActiveView(), 0);
    }

    /** 保存模块设置并刷新悬浮播放器呈现 */
    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.floatingPlayer?.refreshPresentation();
    }

    private async saveVideoSize(width: number, height: number): Promise<void> {
        this.settings.videoPlayerWidth = width;
        this.settings.videoPlayerHeight = height;
        await this.saveData(this.settings);
    }

    /** 移除插件注入的、无法通过 re-render 回收的 DOM 产物 */
    private removeViewArtifacts() {
        const root = this.app.workspace.containerEl;

        root.querySelectorAll<HTMLElement>("[data-tsp-sticky-toggle]").forEach(el => el.remove());
        root.querySelectorAll<HTMLElement>(
            ".tsp-sticky-anchor, .tsp-sticky-placeholder, .tsp-sticky-media-layer"
        ).forEach(el => el.remove());
        root.querySelectorAll<HTMLElement>(".tsp-sticky-host-context")
            .forEach(el => el.removeClass("tsp-sticky-host-context"));
        root.querySelectorAll<HTMLElement>(".tsp-floating-player").forEach(el => el.remove());

        // 阅读模式的时间戳 / 说话人 / 循环区间节点还原为纯文本；实时预览的由 CM 扩展回收，跳过
        root.querySelectorAll<HTMLElement>(".tsp-timestamp, .tsp-speaker, .tsp-loop-timestamp").forEach(el => {
            if (el.closest(".cm-content")) return;
            el.replaceWith(el.ownerDocument.createTextNode(el.textContent ?? ""));
        });
    }

    /** 刷新当前激活的 markdown 标签页（阅读模式 / 实时预览均覆盖） */
    private refreshActiveView() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;
        if (view.getMode() === "preview") {
            view.previewMode.rerender(true);
        } else {
            view.editor?.refresh();
        }
    }

    private setupMediaObserver() {
        const root = this.app.workspace.containerEl;

        this.mediaObserver = new MutationObserver((mutations) => {
            const added: HTMLMediaElement[] = [];

            for (const m of mutations) {
                for (const node of Array.from(m.addedNodes)) {
                    if (!node.instanceOf(HTMLElement)) continue;

                    if (node.matches("audio, video")) {
                        added.push(node as HTMLMediaElement);
                    } else {
                        const nested = node.querySelectorAll<HTMLMediaElement>("audio, video");
                        for (const media of Array.from(nested)) added.push(media);
                    }
                }
            }

            for (const media of added) {
                // 只处理位于 Markdown 视图内的媒体
                if (!media.closest(".markdown-preview-view, .cm-scroller")) continue;
                // 已被包装过的会因属性检查跳过
                this.timestampManager.wrapMediaElement(media);
                this.stickyManager.setupForElement(media);
            }

            this.checkActiveMediaDisconnect();
        });

        this.mediaObserver.observe(root, { childList: true, subtree: true });
    }

    /**
     * 活跃媒体被重渲染 / CM 虚拟化拆走且仍在播放 → 按切页行为处理
     * （continue = 收养进悬浮播放器续播）。延迟一个 tick 复核，
     * 避免节点被临时搬移又被放回时误判。
     */
    private checkActiveMediaDisconnect() {
        const media = this.timestampManager.activeMediaElement;
        if (!media || media.paused || media.isConnected) return;
        if (this.disconnectCheckScheduled) return;
        this.disconnectCheckScheduled = true;
        window.setTimeout(() => {
            this.disconnectCheckScheduled = false;
            const current = this.timestampManager.activeMediaElement;
            if (!current || current.paused || current.isConnected) return;
            this.timestampManager.handleDisconnect();
        }, 0);
    }

    /** 为每个 markdown 视图头部（模式切换旁）添加吸附开关按钮 */
    private instrumentStickyToggle() {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || this.instrumentedViews.has(view)) continue;
            this.instrumentedViews.add(view);
            const btn = view.addAction(
                this.stickyEnabled ? "pin" : "pin-off",
                this.stickyEnabled ? t("sticky.disable") : t("sticky.enable"),
                () => this.toggleSticky()
            );
            btn.setAttribute("data-tsp-sticky-toggle", "");
        }
    }

    private toggleSticky() {
        this.stickyEnabled = !this.stickyEnabled;
        this.stickyManager.setEnabled(this.stickyEnabled);
        const title = this.stickyEnabled ? t("sticky.disable") : t("sticky.enable");
        for (const btn of Array.from(document.querySelectorAll<HTMLElement>(".view-action[data-tsp-sticky-toggle]"))) {
            setIcon(btn, this.stickyEnabled ? "pin" : "pin-off");
            btn.setAttribute("aria-label", title);
            btn.title = title;
        }
    }

    private async hasMediaEmbed(ctx: MarkdownPostProcessorContext): Promise<boolean> {
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (!(file instanceof TFile)) return false;
        const content = await this.app.vault.cachedRead(file);
        return MEDIA_EMBED_RE.test(content);
    }

    private invalidateNote(file: TAbstractFile): void {
        if (file instanceof TFile && file.extension === "md") {
            this.bindingIndex.invalidate(file.path);
        }
    }

    private getLeafFile(leaf: WorkspaceLeaf | null): TFile | null {
        const file = (leaf?.view as { file?: unknown } | undefined)?.file;
        return file instanceof TFile ? file : null;
    }

    private isMainWorkspaceLeaf(leaf: WorkspaceLeaf | null): boolean {
        return Boolean(leaf?.view.containerEl.closest(".workspace-split.mod-root"));
    }
}
