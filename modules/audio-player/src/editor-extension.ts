import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findMarkdownLinkTarget } from "./timestamp-target";

/**
 * 编辑态链接时间戳点击（移植自 obsidian-audio-timestamp-player，0BSD）。
 *
 * 纯事件型 CM6 扩展，不做装饰： Live Preview 下 Obsidian 会把
 * `[00:13](#audio-time=00:13)` 渲染为可点链接，纯源码模式下则是行内文本，
 * 两者都用 posAtCoords 把点击坐标换算成行内偏移，命中链接文本即交给
 * 控制器走显式绑定播放。与阅读态后处理器（链接按钮化）和 Live Preview
 * 装饰（链接按钮 widget）互补：光标落在链接上时装饰被抑制， raw 文本
 * 的点击由本扩展兜底。
 */
export interface LinkTimestampClickHandler {
    handleLinkClick(event: MouseEvent, target: Element, linkTarget: string): Promise<void>;
}

export function createEditorTimestampExtension(
    handler: LinkTimestampClickHandler,
): Extension {
    return EditorView.domEventHandlers({
        click(event, editorView): boolean {
            const target = event.target;
            if (!target || typeof (target as Element).closest !== "function") return false;

            const position = editorView.posAtCoords({
                x: event.clientX,
                y: event.clientY,
            });
            if (position === null) return false;

            const line = editorView.state.doc.lineAt(position);
            const linkTarget = findMarkdownLinkTarget(line.text, position - line.from);
            if (!linkTarget) return false;

            void handler.handleLinkClick(event, target as Element, linkTarget);
            return true;
        },
    });
}
