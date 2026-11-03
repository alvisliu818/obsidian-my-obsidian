/**
 * 歌曲搜索模态框模块
 * 
 * 提供一个带模糊搜索功能的歌曲搜索对话框，用户可以：
 * - 搜索整个音乐库的所有歌曲
 * - 通过输入关键词进行模糊搜索
 * - 查看歌曲的封面、标题、艺术家、专辑信息
 * - 选择歌曲进行播放
 */

import { App, FuzzyMatch, FuzzySuggestModal, TFile } from "obsidian";
import MusicPlayerPlugin from "@/main";
import { getTrackCover } from "@/utils/library/coverFinder";
import { getOrCreateTrackId } from "@/utils/track/id";
import { renderTrackItemContent } from "@/utils/ui/trackItemRenderer";
import "@/components/shared/TrackItem.css";

/**
 * 歌曲搜索模态框类
 * 
 * 继承自 Obsidian 的 FuzzySuggestModal，提供模糊搜索和选择功能
 * 用于在整个音乐库中搜索并选择歌曲
 */
export class TrackSearchModal extends FuzzySuggestModal<TFile> {
	/** Promise 的 resolve 函数，用于返回用户选择的歌曲文件 */
	private resolve!: ((value: TFile | null) => void) | null;
	/** 可搜索的歌曲文件列表 */
	private items: TFile[] = [];
	/** 当前正在播放的歌曲文件（用于高亮显示） */
	private currentTrack: TFile | null = null;
	/** 标记用户是否已通过点击选择了项目（用于区分点击选择和取消） */
	private chosen: boolean = false;
	/** 插件实例引用，用于访问设置和歌曲数据 */
	private plugin: MusicPlayerPlugin;
	/** 封面图片缓存，避免重复获取同一首歌曲的封面 */
	private coverCache: Map<string, string> = new Map();
	/** 专辑封面缓存，按专辑名称缓存（同一专辑的歌曲共享封面） */
	private albumCoverCache: Map<string, string> = new Map();
	/** 用于跟踪正在加载的封面请求，以便在选择时取消 */
	private loadingPromises: Set<Promise<void>> = new Set();
	/** 用于标记是否应该停止加载（选择时设置） */
	private shouldStopLoading: boolean = false;
	/** Intersection Observer 实例，用于检测可见元素 */
	private observer: IntersectionObserver | null = null;

	/**
	 * 构造函数
	 * 
	 * @param app Obsidian 应用实例
	 * @param plugin 插件实例
	 * @param allTracks 所有可搜索的歌曲文件列表
	 * @param currentTrack 当前正在播放的曲目（可选，用于高亮显示）
	 */
	constructor(
		app: App,
		plugin: MusicPlayerPlugin,
		allTracks: TFile[],
		currentTrack: TFile | null = null
	) {
		super(app);
		this.app = app;
		this.plugin = plugin;
		this.items = allTracks;
		this.currentTrack = currentTrack;
		this.modalEl.addClass("music-player");
	}

	/**
	 * 获取可搜索的项目列表
	 * @returns 返回所有歌曲文件数组
	 */
	getItems(): TFile[] {
		return this.items;
	}

	/**
	 * 获取项目的显示文本（用于搜索匹配）
	 * 
	 * 返回包含歌曲名、艺术家名和专辑名的字符串，支持在这三个字段中搜索
	 * 
	 * @param item 歌曲文件对象
	 * @returns 返回包含歌曲名、艺术家名和专辑名的搜索文本
	 */
	getItemText(item: TFile): string {
		const trackId = getOrCreateTrackId(item.path, this.plugin.settings);
		const track = this.plugin.settings.tracks[trackId];
		const parts: string[] = [];
		
		// 添加曲目标题（如果没有则使用文件名）
		parts.push(track?.title || item.basename);
		
		// 添加艺术家名（如果存在）
		if (track?.artist) {
			parts.push(track.artist);
		}
		
		// 添加专辑名（如果存在）
		if (track?.album) {
			parts.push(track.album);
		}
		
		// 用空格连接所有部分，模糊搜索可以在任何字段中匹配
		return parts.join(' ');
	}

	/**
	 * 获取歌曲的封面图片 URL
	 * 
	 * 从歌曲文件所在文件夹中查找封面图片
	 * 使用缓存机制，避免重复查找同一首歌曲的封面
	 * 支持专辑缓存优化（同一专辑的歌曲共享封面）
	 * 
	 * @param file 歌曲文件对象
	 * @returns 返回封面图片的 URL，如果没有封面则返回 null
	 */
	async getCoverImageUrl(file: TFile): Promise<string | null> {
		// 如果应该停止加载，直接返回 null
		if (this.shouldStopLoading) {
			return null;
		}

		// 检查缓存中是否已有该歌曲的封面
		if (this.coverCache.has(file.path)) {
			return this.coverCache.get(file.path) || null;
		}

		// 优化：如果同一专辑的其他歌曲已经有封面，直接复用
		const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
		const track = this.plugin.settings.tracks[trackId];
		if (track?.album) {
			const albumCover = this.albumCoverCache.get(track.album);
			if (albumCover) {
				this.coverCache.set(file.path, albumCover);
				return albumCover;
			}
		}

		// 再次检查是否应该停止加载
		if (this.shouldStopLoading) {
			return null;
		}

		// 获取封面（优先文件夹中的 cover 文件，其次内嵌封面）
		const coverUrl = await getTrackCover(this.app, file) || null;
		
		// 最后一次检查是否应该停止加载
		if (this.shouldStopLoading) {
			return null;
		}

		if (coverUrl) {
			// 将封面 URL 存入缓存
			this.coverCache.set(file.path, coverUrl);
			
			// 如果该歌曲有专辑信息，也缓存到专辑缓存中
			if (track?.album) {
				this.albumCoverCache.set(track.album, coverUrl);
			}
			
			return coverUrl;
		}

		// 如果没有找到封面，返回 null
		return null;
	}

	/**
	 * 渲染搜索建议项
	 * 
	 * 为每个搜索结果项创建自定义的 UI，包括：
	 * - 封面图片（异步加载）
	 * - 歌曲标题
	 * - 艺术家和专辑信息
	 * - 当前播放歌曲的高亮样式
	 * 
	 * @param item 模糊匹配结果对象，包含歌曲文件和匹配信息
	 * @param el 要渲染到的 DOM 元素
	 */
	renderSuggestion(item: FuzzyMatch<TFile>, el: HTMLElement): void {
		const file = item.item;
		const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
		const track = this.plugin.settings.tracks[trackId];
		// 检查是否是当前正在播放的曲目
		const isActive = !!(this.currentTrack && file.path === this.currentTrack.path);
		
		// 添加容器类，用于样式控制
		el.addClass("playlist-item");
		// 如果是当前播放的歌曲，添加激活状态类
		if (isActive) {
			el.addClass("is-active");
		}

		// 先调用父类方法生成基础结构（这会创建 suggestion-content 等必要的元素）
		super.renderSuggestion(item, el);
		
		// 查找 suggestion-content 容器，如果不存在，尝试直接使用 el 的内容
		let contentEl = el.querySelector(".suggestion-content") as HTMLElement;
		if (!contentEl) {
			// 如果找不到 suggestion-content，直接使用 el 本身
			contentEl = el;
			// 清空 el 的内容，准备重新创建
			el.empty();
		}

		// 使用工具函数渲染播放列表项内容
		renderTrackItemContent(contentEl, {
			file,
			track,
			isActive,
			coverCache: this.coverCache,
			observer: this.observer,
		});
		
		// 如果 observer 还没创建，会在 setupIntersectionObserver 中统一观察
	}

	/**
	 * 当用户从列表中选择歌曲时调用（点击或按 Enter）
	 * 
	 * @param item 被选择的歌曲文件
	 * @param evt 鼠标或键盘事件对象
	 */
	onChooseItem(item: TFile, _evt: MouseEvent | KeyboardEvent): void {
		// 立即停止所有封面加载
		this.shouldStopLoading = true;
		this.loadingPromises.clear();
		
		// 立即设置 chosen 标志，必须在任何异步操作之前
		// 这用于区分是通过列表选择还是通过取消操作
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
	 * 处理用户取消操作的情况（按 Escape 或关闭对话框）
	 */
	onClose(): void {
		// 停止所有封面加载
		this.shouldStopLoading = true;
		this.loadingPromises.clear();
		
		// 断开 Intersection Observer
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		
		super.onClose();
		
		// 延迟检查，给 onChooseItem 一个机会先执行
		// 这样可以避免重复处理
		window.setTimeout(() => {
			// 如果已经通过 onChooseItem 选择了，不再处理
			if (this.chosen) {
				this.chosen = false;
				return;
			}
			
			// 用户取消了（按了 Escape 或关闭了对话框）
			if (this.resolve) {
				const resolve = this.resolve;
				this.resolve = null;
				resolve(null);
			}
		}, 0);
	}

	/**
	 * 当封面容器可见时加载封面
	 * 
	 * @param coverContainer 封面容器元素
	 * @param file 歌曲文件
	 * @param track 歌曲元数据
	 */
	private loadCoverWhenVisible(coverContainer: HTMLElement, file: TFile, track: { title?: string } | undefined): void {
		// 如果已经有缓存，直接加载
		if (this.coverCache.has(file.path)) {
			const coverUrl = this.coverCache.get(file.path);
			if (coverUrl && coverContainer.parentElement) {
				coverContainer.empty();
				const coverImg = coverContainer.createEl("img");
				coverImg.src = coverUrl;
				coverImg.alt = track?.title || file.basename;
			}
			return;
		}

		// 创建加载 Promise
		const loadPromise = (async () => {
			try {
				// 检查是否应该停止加载
				if (this.shouldStopLoading) {
					return;
				}

				const coverUrl = await this.getCoverImageUrl(file);

				// 再次检查是否应该停止加载
				if (this.shouldStopLoading) {
					return;
				}

				// 检查容器是否仍然存在（防止在加载过程中元素被移除）
				if (coverUrl && coverContainer.parentElement) {
					// 清空占位符
					coverContainer.empty();
					// 创建图片元素并设置源
					const coverImg = coverContainer.createEl("img");
					coverImg.src = coverUrl;
					coverImg.alt = track?.title || file.basename;
				}
			} catch (err) {
				if (!this.shouldStopLoading) {
					console.error(`获取封面失败 (${file.path}):`, err);
				}
			}
		})();

		// 将 Promise 添加到跟踪集合中
		this.loadingPromises.add(loadPromise);
		
		// 在 Promise 完成后从集合中移除
		loadPromise.finally(() => {
			this.loadingPromises.delete(loadPromise);
		}).catch(() => {
			// Ignore errors
		});
	}

	/**
	 * 设置 Intersection Observer 来检测可见元素
	 */
	private setupIntersectionObserver(): void {
		// 如果已经存在 observer，先断开
		if (this.observer) {
			this.observer.disconnect();
		}

		// 创建新的 Intersection Observer
		this.observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting && !this.shouldStopLoading) {
						const coverContainer = entry.target as HTMLElement;
						const trackPath = coverContainer.getAttribute("data-track-path");
						if (!trackPath) return;

						// 检查是否已经有封面
						if (this.coverCache.has(trackPath)) {
							const coverUrl = this.coverCache.get(trackPath);
							if (coverUrl && coverContainer.parentElement) {
								coverContainer.empty();
								const coverImg = coverContainer.createEl("img");
								coverImg.src = coverUrl;
								const file = this.items.find(f => f.path === trackPath);
								if (file) {
									const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
									const track = this.plugin.settings.tracks[trackId];
									coverImg.alt = track?.title || file.basename;
								}
							}
							// 停止观察，因为已经加载完成
							this.observer?.unobserve(coverContainer);
							return;
						}

						// 加载封面
						const file = this.items.find(f => f.path === trackPath);
						if (file) {
							const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
							const track = this.plugin.settings.tracks[trackId];
							this.loadCoverWhenVisible(coverContainer, file, track);
							// 停止观察，因为已经开始加载
							this.observer?.unobserve(coverContainer);
						}
					}
				});
			},
			{
				// 提前 100px 开始加载，提升用户体验
				rootMargin: '100px',
				threshold: 0.01,
			}
		);

		// 观察所有已存在的封面容器
		window.setTimeout(() => {
			if (this.observer && this.modalEl) {
				const coverContainers = this.modalEl.querySelectorAll('[data-track-path]');
				coverContainers.forEach((container) => {
					this.observer?.observe(container);
				});
			}
		}, 0);
	}

	/**
	 * 显示搜索模态框并等待用户选择
	 * 
	 * @returns 返回 Promise，解析为用户选择的歌曲文件，如果取消则返回 null
	 */
	async prompt(): Promise<TFile | null> {
		// 重置状态
		this.shouldStopLoading = false;
		this.loadingPromises.clear();
		
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.chosen = false;
			this.open();
			
			// 在模态框打开后设置 Intersection Observer
			window.setTimeout(() => {
				this.setupIntersectionObserver();
			}, 100);
		});
	}
}

