/**
 * 保存网页路径弹窗(用户 2026-11-20:保存网页+支持自己选择保存位置)。
 * 输入完整绝对路径(.mhtml);Enter/按钮提交;上次目录由插件侧记忆拼默认值。
 */
import { Modal, type App } from "obsidian";

export class SavePageModal extends Modal {
	constructor(
		app: App,
		private readonly suggested: string,
		private readonly onSubmit: (absPath: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass("ob-save-page-modal");
		this.contentEl.createEl("h3", { text: "保存网页到本地" });
		this.contentEl.createEl("p", {
			text: "完整渲染页保存为单文件 MHTML(含样式/图片/字体)。输入绝对路径:",
			cls: "setting-item-description",
		});
		const input = this.contentEl.createEl("input", {
			type: "text",
			cls: "ob-save-page-input",
			attr: { spellcheck: "false" },
		});
		input.value = this.suggested;
		const submit = (): void => {
			const v = input.value.trim();
			if (!v) return;
			this.close();
			this.onSubmit(v);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});
		const row = this.contentEl.createDiv({ cls: "ob-save-page-row" });
		const btn = row.createEl("button", { cls: "mod-cta", text: "保存" });
		btn.addEventListener("click", submit);
		const cancel = row.createEl("button", { text: "取消" });
		cancel.addEventListener("click", () => this.close());
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
