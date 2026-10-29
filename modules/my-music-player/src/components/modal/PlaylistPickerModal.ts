/**
 * 歌单选择器模态框模块
 * 
 * 提供一个带模糊搜索功能的歌单选择对话框，用户可以：
 * - 从已有歌单列表中选择
 * - 通过输入搜索过滤歌单
 * - 输入已存在的歌单名称进行选择
 * 
 * 注意：如果输入的歌单不存在，不会自动创建，而是返回 null
 */

import { App, FuzzySuggestModal } from "obsidian";

/**
 * 歌单选择器模态框类
 * 
 * 继承自 Obsidian 的 FuzzySuggestModal，提供模糊搜索和选择功能
 * 用于在添加歌曲到歌单时选择目标歌单
 */
export class PlaylistPickerModal extends FuzzySuggestModal<string> {
	/** Promise 的 resolve 函数，用于返回用户选择的结果 */
	private resolve!: ((value: string | null) => void) | null;
	/** 可选择的歌单名称列表 */
	private items: string[] = [];
	/** 标记用户是否已通过点击选择了项目（用于区分点击选择和输入选择） */
	private chosen: boolean = false;

	/**
	 * 构造函数
	 * @param app Obsidian 应用实例
	 * @param existingPlaylists 已存在的歌单名称列表，默认为空数组
	 * @param allowNew 是否允许创建新歌单（当前未使用），默认为 true
	 */
	constructor(app: App, existingPlaylists: string[] = [], _allowNew: boolean = true) {
		super(app);
		this.items = existingPlaylists;
	}

	/**
	 * 获取可选择的项目列表
	 * @returns 返回歌单名称数组
	 */
	getItems(): string[] {
		return this.items;
	}

	/**
	 * 获取项目的显示文本
	 * @param item 歌单名称
	 * @returns 返回歌单名称（直接返回，不做转换）
	 */
	getItemText(item: string): string {
		return item;
	}

	/**
	 * 当用户从列表中选择项目时调用（点击或按 Enter）
	 * 
	 * @param item 被选择的歌单名称
	 * @param evt 鼠标或键盘事件对象
	 */
	onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent): void {
		// 立即设置 chosen 标志，必须在任何异步操作之前
		// 这用于区分是通过列表选择还是通过输入选择
		this.chosen = true;
		
		// 保存 resolve 函数的引用
		const resolve = this.resolve;
		
		// 如果 resolve 已经被清除（可能是在 onClose 中），说明用户取消了操作
		if (!resolve) {
			this.close();
			return;
		}
		
		// 清除 resolve，防止 onClose 中再次调用
		this.resolve = null;
		
		// 立即 resolve，确保值被传递
		resolve(item);
		
		// 延迟关闭模态框，确保 resolve 先执行
		window.setTimeout(() => {
			this.close();
		}, 0);
	}

	/**
	 * 当模态框关闭时调用
	 * 
	 * 处理以下情况：
	 * 1. 用户通过点击列表项选择（已在 onChooseItem 中处理）
	 * 2. 用户输入歌单名称并按 Enter（需要检查输入值是否在列表中）
	 * 3. 用户按 Escape 或关闭对话框（返回 null）
	 */
	onClose(): void {
		super.onClose();
		
		// 延迟检查，给 onChooseItem 一个机会先执行
		// 这样可以避免重复处理
		window.setTimeout(() => {
			// 如果已经通过 onChooseItem 选择了，不再处理
			if (this.chosen) {
				this.chosen = false;
				return;
			}
			
			// 检查是否有输入的值（用户按 Enter 输入了值）
			const inputValue = this.inputEl?.value?.trim();
			// 只有当输入的值存在于歌单列表中时，才返回它
			// 如果不存在，不自动创建，返回 null
			if (inputValue && this.items.includes(inputValue)) {
				// 输入的值是已存在的歌单，返回它
				if (this.resolve) {
					const resolve = this.resolve;
					this.resolve = null;
					resolve(inputValue);
					return;
				}
			}
			
			// 用户取消了（按了 Escape、关闭了对话框，或输入了不存在的歌单名称）
			if (this.resolve) {
				const resolve = this.resolve;
				this.resolve = null;
				resolve(null);
			}
		}, 0);
	}

	/**
	 * 显示模态框并等待用户选择
	 * 
	 * @returns 返回 Promise，解析为用户选择的歌单名称，如果取消则返回 null
	 */
	async prompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.chosen = false;
			this.open();
		});
	}
}

