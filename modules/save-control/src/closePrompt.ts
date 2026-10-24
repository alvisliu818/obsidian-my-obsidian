/**
 * 关闭标签页前的「未保存更改」提示。
 *
 * 上游 autosave-control 只在关窗/退出时提示（manual 模式），关单个标签页是
 * 静默的。合并后把提示延伸到关标签页：库内（控制器有待保存项）与库外（视图
 * 缓冲区脏）都覆盖，三个选项——保存并关闭 / 不保存并关闭 / 取消。
 *
 * 弹窗期间 detach 被按在调用栈里不返回（包装器直接 return），用户点哪个再
 * 决定要不要继续拆标签页，所以取消是真正意义上的取消。
 */

import { App, Modal } from "obsidian";

export type UnsavedCloseChoice = "save" | "discard" | "cancel";

export class UnsavedCloseModal extends Modal {
  private readonly resolve: (choice: UnsavedCloseChoice) => void;
  /** tab = 关闭标签页；quit = 退出 Obsidian（标题/按钮文案不同，三选一同款）。 */
  private readonly kind: "tab" | "quit";

  constructor(
    app: App,
    private readonly displayName: string,
    resolve: (choice: UnsavedCloseChoice) => void,
    kind: "tab" | "quit" = "tab",
  ) {
    super(app);
    this.resolve = resolve;
    this.kind = kind;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("sc-unsaved-close");
    contentEl.createEl("h3", { text: this.kind === "quit" ? "退出 Obsidian" : "关闭标签页" });
    contentEl.createEl("p", {
      text: this.kind === "quit"
        ? `有未保存的更改（${this.displayName}）。要如何处理？`
        : `「${this.displayName}」有未保存的更改。要如何处理？`,
    });

    const row = contentEl.createDiv({ cls: "sc-unsaved-close__row" });
    const saveLabel = this.kind === "quit" ? "保存并退出" : "保存并关闭";
    const discardLabel = this.kind === "quit" ? "不保存并退出" : "不保存并关闭";
    const saveBtn = row.createEl("button", { cls: "mod-cta", text: saveLabel });
    saveBtn.addEventListener("click", () => this.finish("save"));
    const discardBtn = row.createEl("button", { cls: "mod-warning", text: discardLabel });
    discardBtn.addEventListener("click", () => this.finish("discard"));
    const cancelBtn = row.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.finish("cancel"));

    // Esc = 取消（默认 close 会当取消处理，见 onClose）。
    this.scope.register([], "Escape", () => {
      this.finish("cancel");
      return false;
    });
  }

  onClose(): void {
    this.contentEl.empty();
    // 用户直接点了遮罩/Esc 关掉的：按取消算——但 finish 已经 resolve 过一次，
    // Promise 只认第一个值，重复 resolve 无害。
    this.resolve("cancel");
  }

  private finish(choice: UnsavedCloseChoice): void {
    this.resolve(choice);
    this.close();
  }
}

/** 弹出提示并等待用户决定。kind = tab（关标签页）/ quit（退出 Obsidian）。 */
export function askUnsavedClose(
  app: App,
  displayName: string,
  kind: "tab" | "quit" = "tab",
): Promise<UnsavedCloseChoice> {
  return new Promise((resolve) => {
    new UnsavedCloseModal(app, displayName, resolve, kind).open();
  });
}
