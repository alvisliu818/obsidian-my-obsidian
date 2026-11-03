/**
 * 从点击事件中定位 Markdown 链接目标（移植自 obsidian-audio-timestamp-player，0BSD）。
 *
 * 三分支覆盖三种渲染现场：
 *  1. 阅读态 / Live Preview 的 `<a>`（data-href 优先，Obsidian 内部链接属性）
 *  2. 带 data-href / href 的元素（Live Preview 的 span 链接）
 *  3. 纯源码模式的 `.cm-line` —— 用 caretPositionFromPoint 把点击坐标
 *     换算成行内偏移，再判断是否落在链接文本范围内
 */

/** `[label](target)` 链接（label 允许转义方括号），供编辑态装饰与点击定位共用 */
export const MARKDOWN_LINK_PATTERN = /\[(?:\\.|[^\]])*\]\(([^)]+)\)/g;

export function findTimestampTarget(event: MouseEvent, target: Element): string | null {
    const link = target.closest<HTMLAnchorElement>("a");
    if (link) {
        return link.getAttribute("data-href") ?? link.getAttribute("href");
    }

    const attributedTarget = target.closest<HTMLElement>("[data-href], [href]");
    if (attributedTarget) {
        return attributedTarget.getAttribute("data-href") ?? attributedTarget.getAttribute("href");
    }

    const line = target.closest<HTMLElement>(".cm-line");
    if (!line) return null;

    const offset = textOffsetAtPoint(line, event.clientX, event.clientY);
    return findMarkdownLinkTarget(line.textContent ?? "", offset);
}

/** 判断行内偏移是否落在某个 `[label](target)` 链接范围内，返回链接目标 */
export function findMarkdownLinkTarget(line: string, offset: number): string | null {
    for (const match of line.matchAll(MARKDOWN_LINK_PATTERN)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (offset >= start && offset <= end) return match[1] ?? null;
    }
    return null;
}

function textOffsetAtPoint(line: HTMLElement, x: number, y: number): number {
    const documentAtPoint = line.ownerDocument;
    const caretPosition = documentAtPoint.caretPositionFromPoint?.(x, y);
    if (caretPosition && line.contains(caretPosition.offsetNode)) {
        return rangeLength(line, caretPosition.offsetNode, caretPosition.offset);
    }

    const caretRangeFromPoint = Reflect.get(documentAtPoint, "caretRangeFromPoint") as
        | ((clientX: number, clientY: number) => Range | null)
        | undefined;
    const caretRange = caretRangeFromPoint?.call(documentAtPoint, x, y);
    if (caretRange && line.contains(caretRange.startContainer)) {
        return rangeLength(line, caretRange.startContainer, caretRange.startOffset);
    }

    return Number.MAX_SAFE_INTEGER;
}

function rangeLength(line: HTMLElement, node: Node, offset: number): number {
    const range = line.ownerDocument.createRange();
    range.setStart(line, 0);
    range.setEnd(node, offset);
    return range.toString().length;
}
