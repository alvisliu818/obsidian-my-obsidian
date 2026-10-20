/**
 * 文件监听服务
 * 
 * 负责监听文件系统变化（删除、创建、重命名、修改），
 * 当检测到音乐文件变化时，自动触发一致性检查或更新元数据。
 * 根据音乐文件夹设置决定监听范围。
 */

import { App, TAbstractFile, TFile } from "obsidian";
import MusicPlayerPlugin from "@/main";
import { isSupportedAudioExtension, SUPPORTED_AUDIO_FORMATS } from "@/constants";
import { LibraryService } from "./LibraryService";
import { StateService } from "./StateService";
import { type AudioEventHandlers, AudioService } from "./AudioService";
import { LyricsService } from "./LyricsService";

/**
 * 文件监听服务类
 * 
 * 监听音乐文件的变化，并在检测到变化时触发一致性检查。
 * 监听范围根据音乐文件夹设置决定：如果设置了音乐文件夹，只监听该文件夹内的音乐文件；
 * 如果未设置，则监听整个 vault 中的音乐文件。
 */
export class ListenerService {
	private vaultEventListeners: Array<() => void> = [];

	constructor(
		private app: App,
		private plugin: MusicPlayerPlugin,
		private libraryService: LibraryService,
		private stateService?: StateService,
		private audioService?: AudioService,
		private lyricsService?: LyricsService,
		private audioEventHandlers?: AudioEventHandlers
	) {}

	/**
	 * 检查文件是否是音乐文件
	 * 
	 * @param file - 要检查的文件
	 * @returns 如果是音乐文件返回 true，否则返回 false
	 */
	private isMusicFile(file: TAbstractFile): boolean {
		if (!(file instanceof TFile)) {
			return false;
		}
		const ext = file.extension?.toLowerCase() || '';
		return isSupportedAudioExtension(ext);
	}

	/**
	 * 检查文件是否在音乐文件夹中
	 * 
	 * @param file - 要检查的文件
	 * @returns 如果在音乐文件夹中返回 true，否则返回 false
	 */
	private isInMusicFolder(file: TAbstractFile): boolean {
		if (!this.plugin.settings.musicFolder) {
			return true; // 如果没有设置音乐文件夹，则所有文件都算在内
		}
		const folder = this.plugin.settings.musicFolder.replace(/\/$/, "");
		return file.path.startsWith(folder + "/") || file.path === folder;
	}

	/**
	 * 检查路径是否在音乐文件夹中
	 * 
	 * @param path - 要检查的路径
	 * @returns 如果在音乐文件夹中返回 true，否则返回 false
	 */
	private isPathInMusicFolder(path: string): boolean {
		if (!this.plugin.settings.musicFolder) {
			return true; // 如果没有设置音乐文件夹，则所有文件都算在内
		}
		const folder = this.plugin.settings.musicFolder.replace(/\/$/, "");
		return path.startsWith(folder + "/") || path === folder;
	}

	/**
	 * 处理文件删除事件
	 * 
	 * 当检测到音乐文件被删除时，立即清理相关数据。
	 * 
	 * @param filePath - 被删除的文件路径
	 */
	private async handleFileDelete(filePath: string): Promise<void> {
		try {
			// 立即清理已删除的歌曲数据
			await this.libraryService.removeTrackFromLibrary(filePath);
		} catch (error) {
			console.error(`处理文件删除时出错: ${filePath}`, error);
		}
	}

	/**
	 * 处理文件创建事件
	 * 
	 * 当检测到新的音乐文件被创建时，立即提取元数据并添加到库中。
	 * 
	 * @param filePath - 新创建的文件路径
	 */
	private async handleFileCreate(filePath: string): Promise<void> {
		try {
			// 提取元数据并添加到库中（updateTrackMetadata 方法会处理新文件的添加）
			await this.libraryService.updateTrackMetadata(filePath);
			console.debug(`已自动添加新音乐文件到库: ${filePath}`);
		} catch (error) {
			console.error(`处理文件创建时出错: ${filePath}`, error);
		}
	}

	/**
	 * 处理文件修改事件
	 * 
	 * 当检测到音乐文件被修改时，重新提取元数据并更新库中的信息。
	 * 如果当前正在播放该文件，会自动更新当前播放信息。
	 * 
	 * @param filePath - 被修改的文件路径
	 */
	private async handleFileModify(filePath: string): Promise<void> {
		try {
			// 更新文件的元数据
			await this.libraryService.updateTrackMetadata(filePath);
		} catch (error) {
			console.error(`处理文件修改时出错: ${filePath}`, error);
		}
	}

	/**
	 * 处理文件重命名事件
	 * 
	 * 当检测到音乐文件被重命名时，更新库中所有相关的路径引用。
	 * 
	 * 注意：由于现在使用 Blob URL 播放音频，文件不会被直接占用，
	 * 所以重命名操作可以正常进行，不会出现 EBUSY 错误。
	 * 
	 * @param oldPath - 旧的文件路径
	 * @param newPath - 新的文件路径
	 */
	private async handleFileRename(oldPath: string, newPath: string): Promise<void> {
		try {
			// 更新文件重命名后的路径引用
			await this.libraryService.renameTrackInLibrary(oldPath, newPath);
			console.debug(`文件重命名完成: ${oldPath} -> ${newPath}`);
		} catch (error) {
			// 记录错误，但不抛出异常，避免影响其他监听器
			console.error(`处理文件重命名时出错: ${oldPath} -> ${newPath}`, error);
		}
	}

	/**
	 * 设置文件系统监听器
	 * 
	 * 监听文件变化（删除、创建、重命名、修改），
	 * 当检测到音乐文件变化时，自动触发一致性检查或立即处理。
	 * 
	 * 注意：如果之前已经设置过监听器，会先清理旧的监听器再设置新的。
	 */
	public setup(): void {
		// 先清理可能存在的旧监听器，避免重复注册
		this.cleanup();
		// 监听文件删除事件
		// 注意：删除事件在文件被删除前触发，此时文件对象仍然可用
		const deleteHandler = (file: TAbstractFile) => {
			// 检查是否是音乐文件且在音乐文件夹中
			if (file instanceof TFile) {
				const ext = file.extension?.toLowerCase() || '';
				const isMusic = isSupportedAudioExtension(ext);
				if (isMusic && this.isInMusicFolder(file)) {
					// 立即清理已删除的歌曲数据（已自动处理，不需要再检查）
					void this.handleFileDelete(file.path);
					// 删除操作已经自动更新了库，不需要触发一致性检查
				}
			}
		};
		this.app.vault.on('delete', deleteHandler);

		// 监听文件创建事件
		const createHandler = (file: TAbstractFile) => {
			// 检查是否是音乐文件且在音乐文件夹中
			if (this.isMusicFile(file) && this.isInMusicFolder(file)) {
				// 立即提取元数据并添加到库中
				void this.handleFileCreate(file.path);
			}
		};
		this.app.vault.on('create', createHandler);

		// 监听文件重命名事件（包括文件移动）
		// 注意：由于现在使用 Blob URL 播放音频，文件不会被直接占用，
		// 所以重命名操作可以正常进行，不会出现 EBUSY 错误。
		// Obsidian 中文件移动也会触发 rename 事件
		const renameHandler = async (file: TAbstractFile, oldPath: string) => {
			// 检查旧路径和新路径是否是音乐文件
			const wasMusicFile = oldPath && SUPPORTED_AUDIO_FORMATS.some(ext => 
				oldPath.toLowerCase().endsWith(ext)
			);
			const isMusicFile = this.isMusicFile(file);
			
			// 如果都不是音乐文件，直接返回
			if (!wasMusicFile && !isMusicFile) {
				return;
			}

			// 检查旧路径和新路径是否在音乐文件夹中
			const wasInMusicFolder = this.isPathInMusicFolder(oldPath);
			const isInMusicFolder = this.isInMusicFolder(file);

			// 情况1：文件从音乐文件夹移出
			if (wasMusicFile && wasInMusicFolder && !isInMusicFolder) {
				console.debug(`检测到音乐文件从音乐文件夹移出: ${oldPath} -> ${file.path}`);
				// 从库中删除该文件
				await this.handleFileDelete(oldPath);
				return;
			}

			// 情况2：文件移入音乐文件夹
			if (isMusicFile && !wasInMusicFolder && isInMusicFolder) {
				console.debug(`检测到音乐文件移入音乐文件夹: ${oldPath} -> ${file.path}`);
				// 添加到库中
				await this.handleFileCreate(file.path);
				return;
			}

			// 情况3：文件在音乐文件夹内重命名或移动（都在音乐文件夹内）
			if ((wasMusicFile || isMusicFile) && wasInMusicFolder && isInMusicFolder) {
				// 如果文件正在播放，需要更新播放状态和重新创建音频元素
				// 由于使用 Blob URL，文件不会被占用，所以重命名应该可以正常进行
				let wasPlaying = false;
				let savedCurrentTime = 0;
				let savedVolume = 1.0;
				let savedPlaybackRate = 1.0;
				
				if (this.stateService && this.audioService) {
					const state = this.stateService.getState();
					if (state.currentTrack && state.currentTrack.path === oldPath) {
						console.debug(`检测到正在播放的文件被重命名: ${oldPath} -> ${file.path}`);
						
						// 在清理之前保存播放状态
						wasPlaying = state.isPlaying;
						const audioElement = this.audioService.getAudioElement();
						if (audioElement) {
							savedCurrentTime = audioElement.currentTime || 0;
							savedVolume = audioElement.volume ?? state.volume ?? 1.0;
							savedPlaybackRate = audioElement.playbackRate ?? state.playbackRate ?? 1.0;
						} else {
							savedVolume = state.volume ?? 1.0;
							savedPlaybackRate = state.playbackRate ?? 1.0;
						}
						
						// 暂停播放（如果正在播放）
						if (wasPlaying) {
							this.audioService.pause();
							this.stateService.setIsPlaying(false);
						}
						
						// 清理旧的音频元素（释放 Blob URL）
						await this.audioService.cleanup();
					}
				}
				
				// 更新文件重命名后的路径引用
				await this.handleFileRename(oldPath, file.path);
				
				// 如果文件正在播放，重新创建音频元素使用新路径
				if (wasPlaying && this.stateService && this.audioService && this.lyricsService && this.audioEventHandlers && file instanceof TFile) {
					const state = this.stateService.getState();
					if (state.currentTrack && state.currentTrack.path === file.path) {
						console.debug(`重新创建音频元素使用新路径: ${file.path}`);
						
						// 重新创建音频元素使用新路径
						await this.audioService.createAudioElement(
							file,
							savedVolume,
							savedPlaybackRate,
							this.audioEventHandlers
						);
						
						// 恢复播放位置
						const newAudioElement = this.audioService.getAudioElement();
						if (newAudioElement && savedCurrentTime > 0) {
							newAudioElement.currentTime = savedCurrentTime;
						}
						
						// 重新加载歌词
						const { lyrics, extendedLyrics } = this.lyricsService.loadLyrics(file.path);
						this.stateService.setLyrics(lyrics, extendedLyrics);
						
						// 恢复播放
						try {
							await this.audioService.play();
							this.stateService.setIsPlaying(true);
							console.debug(`已恢复播放，使用新路径: ${file.path}`);
						} catch (playError) {
							console.error(`恢复播放时出错: ${file.path}`, playError);
						}
					}
				}
				return;
			}

			// 情况4：文件从非音乐文件夹移动到非音乐文件夹（都不在音乐文件夹内）
			// 这种情况不需要处理，因为文件不在音乐文件夹中
		};
		this.app.vault.on('rename', renameHandler);

		// 监听文件修改事件
		const modifyHandler = (file: TAbstractFile) => {
			// 检查是否是音乐文件且在音乐文件夹中
			if (this.isMusicFile(file) && this.isInMusicFolder(file)) {
				// 立即更新文件的元数据
				// updateTrackMetadata 方法会检查当前是否正在播放该文件，如果是则更新播放信息
				void this.handleFileModify(file.path);
			}
		};
		this.app.vault.on('modify', modifyHandler);

		// 保存监听器移除函数
		// off 的回调形参在 obsidian 1.14.4 类型里收窄为 (...data: unknown[])，
		// 与 on 的具名重载签名不一致，断言仅为过类型检查，运行时不变。
		this.vaultEventListeners.push(
			() => this.app.vault.off('delete', deleteHandler as (...data: unknown[]) => unknown),
			() => this.app.vault.off('create', createHandler as (...data: unknown[]) => unknown),
			() => this.app.vault.off('rename', renameHandler as (...data: unknown[]) => unknown),
			() => this.app.vault.off('modify', modifyHandler as (...data: unknown[]) => unknown)
		);
	}

	/**
	 * 清理文件系统监听器
	 * 
	 * 移除所有已注册的监听器。
	 */
	public cleanup(): void {
		// 移除所有监听器
		this.vaultEventListeners.forEach(remove => remove());
		this.vaultEventListeners = [];
	}
}

