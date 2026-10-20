import {
    EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet,
    WidgetType, MatchDecorator,
} from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { TimestampManager } from "./timestamps";
import { parseTimestamp, createInlineTsRegex, createLoopRangeRegex } from "./utils/time";
import { buildTimestampButton, buildLoopButton } from "./utils/ts-button";

class TimestampWidget extends WidgetType {
    constructor(
        private timeStr: string,
        private totalSeconds: number,
        private manager: TimestampManager
    ) {
        super();
    }

    eq(other: TimestampWidget): boolean {
        return this.timeStr === other.timeStr
            && this.totalSeconds === other.totalSeconds;
    }

    toDOM(_view: EditorView): HTMLElement {
        return buildTimestampButton(this.timeStr, this.totalSeconds, (btn, e) => {
            e.preventDefault();
            e.stopPropagation();
            this.manager.togglePlay(btn, this.totalSeconds);
        });
    }

    ignoreEvent(): boolean {
        return true;
    }
}

class LoopWidget extends WidgetType {
    constructor(
        private rangeStr: string,
        private start: number,
        private end: number,
        private manager: TimestampManager
    ) {
        super();
    }

    eq(other: LoopWidget): boolean {
        return this.rangeStr === other.rangeStr
            && this.start === other.start
            && this.end === other.end;
    }

    toDOM(_view: EditorView): HTMLElement {
        const btn = buildLoopButton(this.rangeStr, this.start, this.end, (el, e) => {
            e.preventDefault();
            e.stopPropagation();
            this.manager.toggleLoop(el, this.start, this.end);
        });
        if (this.manager.isLoopActive(this.start, this.end)) {
            btn.addClass("tsp-loop-active");
            btn.setAttribute("aria-pressed", "true");
        }
        return btn;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

/** 时间戳是否属于 `[loop]start->end` 循环区间 */
function isLoopRangeEndpoint(view: EditorView, from: number, to: number): boolean {
    const line = view.state.doc.lineAt(from);
    const regex = createLoopRangeRegex();
    let m: RegExpExecArray | null;

    while ((m = regex.exec(line.text)) !== null) {
        const start = line.from + m.index;
        const end = start + m[0].length;
        if (from >= start && to <= end) return true;
    }
    return false;
}

function createDecorationPlugin(matcher: MatchDecorator) {
    return Prec.high(ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = matcher.createDeco(view);
            }

            update(update: ViewUpdate) {
                if (
                    update.docChanged ||
                    update.viewportChanged ||
                    update.selectionSet
                ) {
                    this.decorations = matcher.createDeco(update.view);
                }
            }
        },
        { decorations: (v) => v.decorations }
    ));
}

export function createLivePreviewTimestampExtension(manager: TimestampManager) {
    const timestampMatcher = new MatchDecorator({
        regexp: createInlineTsRegex(),
        decorate: (add, from, to, match, view) => {
            const cursor = view.state.selection.main;

            // 光标落入时间戳范围内时回退为源码
            if (cursor.from <= to && cursor.to >= from) return;

            // 循环区间的两个端点不参与普通时间戳渲染
            if (isLoopRangeEndpoint(view, from, to)) return;

            const timeStr = match[0];
            const totalSeconds = parseTimestamp(timeStr);
            add(from, to, Decoration.replace({
                widget: new TimestampWidget(timeStr, totalSeconds, manager),
                inclusive: false,
            }));
        },
    });

    const loopMatcher = new MatchDecorator({
        regexp: createLoopRangeRegex(),
        decorate: (add, from, to, match, view) => {
            const cursor = view.state.selection.main;
            if (cursor.from <= to && cursor.to >= from) return;

            const rangeStr = `${match[1]}->${match[2]}`;
            const start = parseTimestamp(match[1]);
            const end = parseTimestamp(match[2]);
            add(from, to, Decoration.replace({
                widget: new LoopWidget(rangeStr, start, end, manager),
                inclusive: false,
            }));
        },
    });

    return [
        createDecorationPlugin(timestampMatcher),
        createDecorationPlugin(loopMatcher),
    ];
}
