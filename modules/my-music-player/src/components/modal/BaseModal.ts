/**
 * 基础模态框类
 * 
 * 提供模态框的公共功能，包括：
 * - 按钮创建和事件绑定
 * - 键盘事件处理（Enter 确认，Escape 取消）
 * - 键盘事件清理
 */

import { App, Modal } from "obsidian";
import "./BaseModal.css";

/**
 * 基础模态框类
 * 
 * 提供模态框的公共功能，供其他模态框类继承使用
 */
export abstract class BaseModal<TResult> extends Modal {
	/** WeakMap to store keydown handlers for each modal instance */
	private static handlerMap = new WeakMap<object, (e: KeyboardEvent) => void>();
	/** Promise 的 resolve 函数，用于返回用户的选择结果 */
	protected resolve!: (value: TResult) => void;
	/** 标记用户是否已提交（点击确定或按 Enter） */
	protected submitted = false;

	/**
	 * 构造函数
	 * 
	 * @param app Obsidian 应用实例
	 * @param title 模态框标题
	 */
	constructor(app: App, title: string) {
		super(app);
		// 添加插件特定的类名，用于限制样式作用域
		this.modalEl.addClass("music-player-modal");
		// 设置模态框标题
		this.setTitle(title);
	}

	/**
	 * 创建按钮容器和按钮
	 * 
	 * @param confirmText 确认按钮文本
	 * @param cancelText 取消按钮文本
	 * @param onConfirm 确认按钮点击回调
	 * @param onCancel 取消按钮点击回调
	 * @returns 返回按钮容器元素
	 */
	protected createButtonContainer(
		confirmText: string,
		cancelText: string,
		onConfirm: () => void,
		onCancel: () => void
	): HTMLElement {
		// 创建按钮容器
		const buttonContainer = this.contentEl.createDiv({ cls: "prompt-button-container" });
		// 创建确定按钮（使用 mod-cta 类使其成为主要操作按钮）
		const confirmBtn = buttonContainer.createEl("button", { text: confirmText, cls: "mod-cta" });
		// 创建取消按钮
		const cancelBtn = buttonContainer.createEl("button", { text: cancelText });

		// 绑定按钮点击事件
		confirmBtn.addEventListener("click", () => {
			void onConfirm();
		});
		cancelBtn.addEventListener("click", () => {
			void onCancel();
		});

		return buttonContainer;
	}

	/**
	 * 设置键盘事件处理
	 * 
	 * @param onEnter Enter 键回调
	 * @param onEscape Escape 键回调
	 */
	protected setupKeyboardHandlers(onEnter: () => void, onEscape: () => void): void {
		// 绑定键盘事件：Enter 确认，Escape 取消
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void onEnter();
			} else if (e.key === "Escape") {
				e.preventDefault();
				void onEscape();
			}
		};
		this.contentEl.addEventListener("keydown", handleKeyDown);
		
		// 保存事件处理器引用，以便在关闭时移除
		BaseModal.handlerMap.set(this, handleKeyDown);
	}

	/**
	 * 当模态框关闭时调用
	 * 清理键盘事件监听器
	 */
	onClose() {
		// 移除键盘事件监听器
		const handler = BaseModal.handlerMap.get(this);
		if (handler) {
			this.contentEl.removeEventListener("keydown", handler);
			BaseModal.handlerMap.delete(this);
		}
	}

	/**
	 * 提交结果
	 * 
	 * @param result 要返回的结果
	 */
	protected submit(result: TResult): void {
		this.submitted = true;
		this.resolve(result);
		this.close();
	}

	/**
	 * 取消操作
	 * 
	 * @param result 取消时的默认结果
	 */
	protected cancel(result: TResult): void {
		this.resolve(result);
		this.close();
	}

	/**
	 * 显示模态框并等待用户操作
	 * 
	 * @returns 返回 Promise，解析为用户操作的结果
	 */
	async prompt(): Promise<TResult> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
}

