import { Plugin, MarkdownView, MarkdownPostProcessorContext, TFile, setIcon } from "obsidian";
import { StickyMediaManager } from "./sticky-media";
import { TimestampManager } from "./timestamps";
import { createLivePreviewTimestampExtension } from "./timestamps-live-preview";
import { t } from "./i18n";
import { initPlayerSettings } from "./utils/player-settings";

const MEDIA_EMBED_RE = /!\[\[.+?\.(mp3|webm|wav|m4a|ogg|3gp|flac|mp4|mov|avi|mkv|mpeg)\]\]/i;

export default class TimestampPlayerPlugin extends Plugin {
    private stickyManager: StickyMediaManager;
    private timestampManager: TimestampManager;
    private mediaObserver: MutationObserver | null = null;
    private stickyEnabled = false;
    private instrumentedViews = new WeakSet<MarkdownView>();

    async onload() {
        const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        await initPlayerSettings(this.app, pluginDir);
        this.stickyManager = new StickyMediaManager(this.app);
        this.stickyManager.initialize();
        this.timestampManager = new TimestampManager(this.app, this.stickyManager);

        // 阅读模式 / 嵌入块的常规路径
        this.registerMarkdownPostProcessor(
            async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
                if (!(await this.hasMediaEmbed(ctx))) return;
                this.timestampManager.processLoopTimestamps(el);
                this.timestampManager.processTimestamps(el);
                this.timestampManager.rewriteMediaElements(el);
                this.stickyManager.setupForElement(el);
            }
        );

        // 实时预览的时间戳渲染
        this.registerEditorExtension(
            createLivePreviewTimestampExtension(this.timestampManager)
        );

        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                this.stickyManager.scan();
                this.instrumentStickyToggle();
            })
        );

        // 兜底：监听动态插入的媒体元素（覆盖实时预览路径）
        this.setupMediaObserver();
        this.instrumentStickyToggle();

        // 加载时刷新已打开的标签页，让插件立即生效
        window.setTimeout(() => this.refreshActiveView(), 0);
    }

    onunload() {
        this.timestampManager.clearPlaybackState();
        this.stickyManager.destroy();
        this.mediaObserver?.disconnect();
        this.mediaObserver = null;

        // 显式清理 DOM 产物（re-render 无法覆盖）：自定义播放器、吸附开关、装饰节点
        this.timestampManager.teardown();
        this.removeViewArtifacts();

        // 延迟到 Obsidian 清理完注册项后再刷新，还原时间戳等后处理器产物
        window.setTimeout(() => this.refreshActiveView(), 0);
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

            if (added.length === 0) return;

            for (const media of added) {
                // 只处理位于 Markdown 视图内的媒体
                if (!media.closest(".markdown-preview-view, .cm-scroller")) continue;
                // 已被包装过的会因属性检查跳过
                this.timestampManager.wrapMediaElement(media);
                this.stickyManager.setupForElement(media);
            }
        });

        this.mediaObserver.observe(root, { childList: true, subtree: true });
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
}