/**
 * 文本输入模态框模块
 * 
 * 提供一个简单的文本输入对话框，用于获取用户输入的文本。
 * 兼容移动端和桌面端，支持键盘快捷键（Enter 确认，Escape 取消）。
 */

import { App } from "obsidian";
import { BaseModal } from "./BaseModal";
import "./TextInputModal.css";
import { t } from "@/utils/i18n/i18n";

/**
 * 文本输入模态框类
 * 
 * 继承自 BaseModal，提供一个文本输入框和确认/取消按钮。
 * 用于需要用户输入文本的场景，如创建歌单时输入歌单名称。
 */
export class TextInputModal extends BaseModal<string | null> {
	/** 输入框元素引用 */
	private inputEl: HTMLInputElement;

	/**
	 * 构造函数
	 * 
	 * @param app Obsidian 应用实例
	 * @param promptText 提示文本，显示在模态框标题中
	 * @param defaultValue 输入框的默认值，默认为空字符串
	 */
	constructor(app: App, promptText: string, defaultValue: string = "") {
		super(app, promptText);
		
		// 创建输入框容器
		const container = this.contentEl.createDiv({ cls: "prompt-input-container" });
		// 创建输入框元素
		this.inputEl = container.createEl("input", {
			type: "text",
			cls: "prompt-input",
			value: defaultValue,
		});

		// 创建按钮容器
		this.createButtonContainer(
			t("common.ok"),
			t("common.cancel"),
			() => this.submit(this.inputEl.value),
			() => this.cancel(null)
		);
		
		// 设置键盘事件处理（在输入框上）
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit(this.inputEl.value);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.cancel(null);
			}
		});
	}

	/**
	 * 当模态框打开时调用
	 * 自动聚焦到输入框并选中默认文本，方便用户直接输入
	 */
	onOpen() {
		void super.onOpen();
		// 聚焦到输入框
		this.inputEl.focus();
		// 选中输入框中的文本（如果有默认值）
		this.inputEl.select();
	}

	/**
	 * 当模态框关闭时调用
	 * 如果用户没有提交（直接关闭或按 Escape），返回 null
	 */
	onClose() {
		super.onClose();
		// 只有在用户未提交的情况下才返回 null
		// 如果已提交，submit() 方法已经处理了 resolve
		if (!this.submitted) {
			this.resolve(null);
		}
	}
}

