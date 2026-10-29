/**
 * 标签页未保存圆点。
 *
 * Obsidian 1.14.4 实测：原生不给标签页标「未保存」状态（app.js 里标签页状态
 * 区只有 mod-linked / mod-pinned 两个图标，没有 modified 圆点），自定义视图
 * （库外文件的三个视图）更是什么都没有。于是自己画一个：
 *
 *   - 库外视图：问视图的 isDirty() 探针（实时）；
 *   - 库内视图：看自动保存控制器的待保存队列（pendingSaveQueue.getPaths()）。
 *
 * 轮询 500ms 一次——编辑事件的钩子在各家视图里形态不一（原生编辑器、我们的
 * 块编辑器、CodeMirror 都不一样），轮询是唯一对三类视图都成立的做法，且
 * 500ms 的延迟肉眼不可感知。
 */

import type { App, WorkspaceLeaf } from "obsidian";
import { asExternalSaveHandle } from "./targets";

/** 圆点的 class（样式在 styles.css）。 */
export const UNSAVED_DOT_CLASS = "sc-unsaved-dot";

/** 待保存状态来源（由 save-control 主插件提供）。 */
export interface UnsavedStateSource {
  /** 库内待保存的 vault 路径集合。 */
  vaultPending(): string[];
}

/** 叶子 → 标签页头元素。Obsidian 内部属性，运行时稳定存在。 */
function tabHeaderElOf(leaf: WorkspaceLeaf): HTMLElement | null {
  const el = (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
  return el ?? null;
}

function statusContainerOf(tabHeaderEl: HTMLElement): HTMLElement | null {
  return tabHeaderEl.querySelector<HTMLElement>(".workspace-tab-header-status-container");
}

/** 给一个叶子打上/取消未保存圆点（幂等，可反复调用）。 */
export function setLeafUnsavedDot(leaf: WorkspaceLeaf, unsaved: boolean): void {
  const tabHeaderEl = tabHeaderElOf(leaf);
  if (!tabHeaderEl) return;
  const container = statusContainerOf(tabHeaderEl);
  if (!container) return;
  const existing = container.querySelector<HTMLElement>(`.${UNSAVED_DOT_CLASS}`);
  if (unsaved && !existing) {
    const dot = document.createElement("div");
    dot.className = `workspace-tab-header-status-icon ${UNSAVED_DOT_CLASS}`;
    dot.setAttribute("title", "未保存的更改");
    container.appendChild(dot);
  } else if (!unsaved && existing) {
    existing.remove();
  }
}

export class UnsavedDotMonitor {
  private timer: number | null = null;

  constructor(
    private readonly app: App,
    private readonly source: UnsavedStateSource,
  ) {}

  start(intervalMs: number): void {
    this.stop();
    this.timer = window.setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const pending = new Set(this.source.vaultPending());
    this.app.workspace.iterateAllLeaves((leaf) => {
      const handle = asExternalSaveHandle(leaf.view);
      if (handle) {
        setLeafUnsavedDot(leaf, handle.isDirty());
        return;
      }
      const path = (leaf.view as { file?: { path?: string } } | null)?.file?.path ?? "";
      setLeafUnsavedDot(leaf, !!path && pending.has(path));
    });
  }
}
