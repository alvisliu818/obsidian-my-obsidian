import { StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { editorInfoField, TFile } from "obsidian";
import type { Tracker } from "./tracker";
import type { TraceTimeSettings } from "./settings";
import { formatTimestamp } from "./format";

/** 插件状态变化（索引加载/外部恢复完成）后触发标签重绘。 */
export const tracetimeRefreshEffect = StateEffect.define<null>();

function fileOf(view: EditorView): TFile | null {
	try {
		return view.state.field(editorInfoField, false)?.file ?? null;
	} catch {
		return null;
	}
}

interface Label {
	text: string;
	/** 标签右缘的文档横坐标（钳制在可视区内） */
	right: number;
	top: number;
}

/**
 * 编辑模式显示：overlay 作为滚动容器（.cm-scroller）的子元素，
 * 标签使用文档坐标定位——滚动由浏览器原生完成，标签天然跟随内容。
 * 横坐标锚在文档内容区右边缘并钳制在可视区内，只渲染 visibleRanges 内的块。
 */
export function createEditorExtension(tracker: Tracker, getSettings: () => TraceTimeSettings) {
	return ViewPlugin.fromClass(
		class {
			private overlay: HTMLElement;
			private destroyed = false;

			constructor(view: EditorView) {
				this.overlay = createDiv("tracetime-editor-overlay");
				view.scrollDOM.appendChild(this.overlay);
				this.scheduleRender(view);
			}

			update(u: ViewUpdate) {
				if (u.docChanged) {
					const file = fileOf(u.view);
					if (file) {
						// 逐 transaction 顺序应用，保证多 transaction 时索引连续一致；
						// 单个失败不炸穿 CM 更新周期，由后续 modify 事件走全文恢复
						for (const tr of u.transactions) {
							if (!tr.docChanged) continue;
							try {
								tracker.applyEdit(file.path, tr.startState.doc, tr.state.doc, tr.changes);
							} catch (e) {
								console.error("TraceTime: applyEdit failed", e);
							}
						}
					}
				}
				const refreshed = u.transactions.some((tr) =>
					tr.effects.some((e) => e.is(tracetimeRefreshEffect))
				);
				if (u.docChanged || u.viewportChanged || u.geometryChanged || refreshed) {
					this.scheduleRender(u.view);
				}
			}

			destroy() {
				this.destroyed = true;
				this.overlay.remove();
			}

			private scheduleRender(view: EditorView) {
				// CM 更新周期内不允许直接读布局，必须走 measure 的 read/write 阶段
				view.requestMeasure({
					read: (v) => this.measureLabels(v),
					write: (res) => {
						if (this.destroyed) return;
						this.overlay.textContent = "";
						this.overlay.toggleClass("tracetime-compact", getSettings().compactLabels);
						this.overlay.toggleClass("tracetime-clamped", res.clamped);
						for (const l of res.labels) {
							const label = createDiv("tracetime-label");
							label.createSpan("tracetime-label-dot");
							label.createSpan({ cls: "tracetime-label-text", text: l.text });
							label.style.left = `${l.right}px`;
							label.style.top = `${l.top}px`;
							this.overlay.appendChild(label);
						}
					},
				});
			}

			private measureLabels(view: EditorView): { labels: Label[]; clamped: boolean } {
				const file = fileOf(view);
				const st = file ? tracker.getState(file.path) : undefined;
				if (!st) return { labels: [], clamped: false };

				const doc = view.state.doc;
				// 文档坐标系原点：contentDOM 在 scroller 内的偏移
				// （inline title 等元素会把内容区往下推，offsetTop 自动覆盖）
				const originTop = view.contentDOM.offsetTop;
				const contentRight = view.contentDOM.offsetLeft + view.contentDOM.offsetWidth;
				const viewportRight = view.scrollDOM.scrollLeft + view.scrollDOM.clientWidth - 8;
				// 与阅读模式同一套规则：未开“限制行宽”一律锚在可视区右缘、
				// clamped 右对齐（向左展开）；开了则锚在内容区右边缘、向右伸进
				// 页边距，仅窗口过窄内容超出可视区时才退回右缘锚定
				const readable = view.dom.closest(".markdown-source-view.is-readable-line-width") !== null;
				const clamped = !readable || contentRight > viewportRight;
				const right = clamped ? viewportRight : contentRight;

				const labels: Label[] = [];
				const vertical = getSettings().labelVertical;
				for (const vr of view.visibleRanges) {
					for (const b of st.index.queryOverlapping(vr.from, vr.to)) {
						const firstLine = view.lineBlockAt(Math.min(b.from, doc.length));
						let top: number;
						if (vertical === "start") {
							top = firstLine.top + firstLine.height / 2;
						} else {
							// 块末行（b.to 为开区间，取最后一个字符所在行）
							const lastLine = view.lineBlockAt(Math.max(b.from, Math.min(b.to - 1, doc.length)));
							top =
								vertical === "end"
									? lastLine.top + lastLine.height / 2
									: (firstLine.top + lastLine.top + lastLine.height) / 2;
						}
						labels.push({
							text: formatTimestamp(b.modifiedAt, getSettings()),
							right,
							top: originTop + top,
						});
					}
				}
				return { labels, clamped };
			}
		}
	);
}
