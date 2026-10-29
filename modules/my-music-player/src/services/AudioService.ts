/**
 * 音频元素管理服务
 * 
 * 负责管理 HTMLAudioElement 的生命周期，包括：
 * - 创建音频元素
 * - 绑定事件监听器
 * - 清理音频元素
 * - 管理音量和播放速度
 */

import { App } from "obsidian";
import { TFile } from "obsidian";

/**
 * 音频事件处理器接口
 * 
 * 定义音频元素需要绑定的各种事件回调函数
 */
export interface AudioEventHandlers {
	/** 播放时间更新时的回调 */
	onTimeUpdate: () => void;
	/** 元数据加载完成时的回调 */
	onLoadedMetadata: () => void;
	/** 播放结束时的回调 */
	onEnded: () => void;
}

/**
 * 音频服务类
 * 
 * 负责管理 HTMLAudioElement 的完整生命周期，包括创建、配置、事件绑定和清理。
 * 提供音频播放控制方法（播放、暂停、跳转、音量、速率等）。
 */
export class AudioService {
	/** 当前音频元素实例 */
	private audioElement: HTMLAudioElement | null = null;
	/** 当前使用的 Blob URL（用于释放资源） */
	private currentBlobUrl: string | null = null;
	/** 当前绑定到 audioElement 的事件处理器引用（用于正确移除监听器） */
	private currentHandlers: AudioEventHandlers | null = null;

	/**
	 * seek 完成后若已贴在媒体末尾（含解码对齐把 currentTime 推到 duration），
	 * 部分环境不会触发 ended；此处补发与 ended 相同的回调。
	 */
	private readonly onSeekedEmitEndedIfAtClose = (): void => {
		const el = this.audioElement;
		const h = this.currentHandlers;
		if (!el || !h) return;
		const d = el.duration;
		const t = el.currentTime;
		if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t)) return;
		if (el.ended) {
			h.onEnded();
			return;
		}
		// 解码对齐后可能停在 duration 却无法进入 ended；用极小余量判断“已在末尾”
		if (t > 0.02 && t >= d - 1e-4) {
			h.onEnded();
		}
	};

	/**
	 * 创建音频服务实例
	 * 
	 * @param app - Obsidian App 实例
	 */
	constructor(private app: App) {}

	/**
	 * 创建并初始化音频元素
	 * 
	 * 如果已存在音频元素，会先清理旧的元素。创建新元素后会绑定所有事件监听器。
	 * 
	 * 使用 Blob URL 来播放音频，这样不会直接占用文件，允许文件被重命名或删除。
	 * 
	 * @param trackFile - 要播放的音乐文件
	 * @param volume - 初始音量（0-1）
	 * @param playbackRate - 初始播放速率（0.25-4.0）
	 * @param handlers - 事件处理器对象
	 * @returns 创建的音频元素
	 */
	async createAudioElement(
		trackFile: TFile,
		volume: number,
		playbackRate: number,
		handlers: AudioEventHandlers
	): Promise<HTMLAudioElement> {
		// 清理旧的音频元素和 Blob URL（异步，等待清理完成）
		await this.cleanup();

		// 读取文件到内存并创建 Blob URL
		// 这样播放时不会直接占用文件，允许文件被重命名或删除
		try {
			const binary = await this.app.vault.readBinary(trackFile);
			const blob = new Blob([binary], { type: this.getMimeType(trackFile.extension) });
			const blobUrl = URL.createObjectURL(blob);
			this.currentBlobUrl = blobUrl;

			// 创建新的音频元素
			this.audioElement = new Audio(blobUrl);
			this.audioElement.volume = volume;
			this.audioElement.playbackRate = playbackRate;

			// 记录当前事件处理器引用，方便 cleanup 时正确移除
			this.currentHandlers = handlers;

			// 绑定事件监听器
			this.audioElement.addEventListener("timeupdate", handlers.onTimeUpdate);
			this.audioElement.addEventListener("loadedmetadata", handlers.onLoadedMetadata);
			this.audioElement.addEventListener("ended", handlers.onEnded);
			this.audioElement.addEventListener("seeked", this.onSeekedEmitEndedIfAtClose);

			return this.audioElement;
		} catch (error) {
			console.error(`创建音频元素失败，回退到直接文件路径: ${trackFile.path}`, error);
			// 如果创建 Blob URL 失败，回退到使用文件路径
			const url = this.app.vault.getResourcePath(trackFile);
			this.audioElement = new Audio(url);
			this.audioElement.volume = volume;
			this.audioElement.playbackRate = playbackRate;

			// 记录当前事件处理器引用，方便 cleanup 时正确移除
			this.currentHandlers = handlers;

			// 绑定事件监听器
			this.audioElement.addEventListener("timeupdate", handlers.onTimeUpdate);
			this.audioElement.addEventListener("loadedmetadata", handlers.onLoadedMetadata);
			this.audioElement.addEventListener("ended", handlers.onEnded);
			this.audioElement.addEventListener("seeked", this.onSeekedEmitEndedIfAtClose);

			return this.audioElement;
		}
	}

	/**
	 * 将 seek 目标时间限制在 duration 略小处。
	 * 若 currentTime 恰好等于 duration，常见实现不会触发 ended，且 play() 无法继续播放，表现为“卡死”。
	 * ε 需足够大以吸收 MP3 等格式 seek 对齐把位置推到末尾的行为。
	 */
	private clampSeekTimeToPlayableEnd(time: number, duration: number): number {
		if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return 0;
		const epsilon = Math.min(0.28, Math.max(duration * 0.0025, 0.002));
		const maxTime = Math.max(0, duration - epsilon);
		return Math.min(Math.max(time, 0), maxTime);
	}

	/**
	 * 根据文件扩展名获取 MIME 类型
	 *
	 * @param extension - 文件扩展名（不含点）
	 * @returns MIME 类型字符串
	 */
	private getMimeType(extension: string): string {
		const ext = extension?.toLowerCase() || '';
		const mimeTypes: Record<string, string> = {
			'mp3': 'audio/mpeg',
			'flac': 'audio/flac',
			'wav': 'audio/wav',
			'ogg': 'audio/ogg',
			'm4a': 'audio/mp4',
			'aac': 'audio/aac',
			'opus': 'audio/opus',
			'wma': 'audio/x-ms-wma',
		};
		return mimeTypes[ext] || 'audio/mpeg';
	}

	/**
	 * 获取当前音频元素
	 * 
	 * @returns 当前音频元素，如果不存在则返回 null
	 */
	getAudioElement(): HTMLAudioElement | null {
		return this.audioElement;
	}

	/**
	 * 清理音频元素
	 * 
	 * 暂停播放、移除事件监听器、释放 Blob URL 并清空引用。

	* 在创建新音频元素或服务销毁时调用。
	 * 
	 * 注意：此方法会优雅地处理正在播放的音频，避免 AbortError。
	 * 如果音频正在播放，会先暂停并等待一小段时间，让 play() Promise 有时间完成或被正确处理。
	 */
	async cleanup(): Promise<void> {
		if (this.audioElement) {
			// 如果音频正在播放，先暂停并等待一小段时间
			// 这样可以避免在 play() Promise 还在进行时调用 pause() 导致的 AbortError
			if (!this.audioElement.paused) {
				this.audioElement.pause();
				// 等待一小段时间，让 play() Promise 有时间完成或被正确处理
				// 10ms 足够让 Promise 进入错误处理流程
				await new Promise(resolve => window.setTimeout(resolve, 10));
			}
			
			// 移除事件监听器
			// 注意：必须使用与 addEventListener 相同的函数引用
			if (this.currentHandlers) {
				this.audioElement.removeEventListener("timeupdate", this.currentHandlers.onTimeUpdate);
				this.audioElement.removeEventListener("loadedmetadata", this.currentHandlers.onLoadedMetadata);
				this.audioElement.removeEventListener("ended", this.currentHandlers.onEnded);
				this.audioElement.removeEventListener("seeked", this.onSeekedEmitEndedIfAtClose);
			}

			this.audioElement = null;
			this.currentHandlers = null;
		}
		
		// 释放 Blob URL，避免内存泄漏
		if (this.currentBlobUrl) {
			URL.revokeObjectURL(this.currentBlobUrl);
			this.currentBlobUrl = null;
		}
	}

	/**
	 * 暂停音频播放
	 */
	pause(): void {
		this.audioElement?.pause();
	}

	/**
	 * 开始播放音频
	 * 
	 * @returns Promise，在播放开始时解析
	 */
	async play(): Promise<void> {
		if (!this.audioElement) {
			return;
		}
		
		try {
			await this.audioElement.play();
		} catch (error) {
			// 如果 play() 被 pause() 中断，这是正常情况，不需要报错
			// 例如：切换曲目时，旧音频元素的 play() 可能被 cleanup() 中的 pause() 中断
			if (error instanceof DOMException && error.name === 'AbortError') {
				console.debug('播放被中断（可能是切换曲目导致的）:', error.message);
				return;
			}
			// 其他错误需要抛出
			throw error;
		}
	}

	/**
	 * 设置音量
	 * 
	 * 音量值会被限制在 0-1 范围内。
	 * 
	 * @param volume - 音量值（0-1）
	 */
	setVolume(volume: number): void {
		if (this.audioElement) {
			this.audioElement.volume = Math.max(0, Math.min(1, volume));
		}
	}

	/**
	 * 设置播放速度
	 * 
	 * 播放速率会被限制在 0.25-4.0 范围内。
	 * 
	 * @param rate - 播放速率（0.25-4.0）
	 */
	setPlaybackRate(rate: number): void {
		if (this.audioElement) {
			this.audioElement.playbackRate = Math.max(0.25, Math.min(4.0, rate));
		}
	}

	/**
	 * 跳转到指定播放位置
	 * 
	 * 根据比例（0-1）跳转到对应的播放位置。
	 * 
	 * @param ratio - 播放位置比例（0-1，0 为开始，1 为结束）
	 */
	seekToRatio(ratio: number): void {
		if (!this.audioElement) return;
		const clamped = Math.min(Math.max(ratio, 0), 1);
		const duration = this.audioElement.duration;
		if (!Number.isFinite(duration) || duration <= 0) return;
		const target = clamped * duration;
		this.audioElement.currentTime = this.clampSeekTimeToPlayableEnd(target, duration);
	}

	/**
	 * 快进指定秒数
	 * 
	 * @param seconds - 要快进的秒数（正数）
	 */
	seekForward(seconds: number): void {
		if (!this.audioElement) return;
		const duration = this.audioElement.duration;
		if (!Number.isFinite(duration) || duration <= 0) return;
		const newTime = this.audioElement.currentTime + seconds;
		this.audioElement.currentTime = this.clampSeekTimeToPlayableEnd(newTime, duration);
	}

	/**
	 * 快退指定秒数
	 * 
	 * @param seconds - 要快退的秒数（正数）
	 */
	seekBackward(seconds: number): void {
		if (!this.audioElement) return;
		const newTime = Math.max(this.audioElement.currentTime - seconds, 0);
		this.audioElement.currentTime = newTime;
	}
}

