import { moment } from 'obsidian';
import { resolvePluginLanguage } from './language';
import type { PluginLanguage, ResolvedLanguage } from './language';

export type { PluginLanguage, ResolvedLanguage } from './language';

const messages = {
	'en': {
		language: 'Language',
		languageDescription: 'Choose the language used by this plugin only.',
		followObsidian: 'Follow Obsidian',
		simplifiedChinese: '简体中文',
		english: 'English',
		audio: 'Audio',
		video: 'Video',
		whenSwitchingPages: 'When switching pages',
		navigationDescription: 'Choose what happens to the {media} player after opening another note, file, or tab.',
		continuePlayback: 'Continue playback',
		pausePlayback: 'Pause playback',
		closePlayer: 'Close player',
		videoDisplay: 'Video player display',
		videoDisplayDescription: 'Choose whether the floating video player shows only compact controls or the video picture.',
		compactControls: 'Compact controls',
		showVideo: 'Show video picture',
		videoSize: 'Expanded video size',
		videoSizeDescription: 'Drag the bottom-right corner of the expanded player to resize it. The last size is saved automatically.',
		resetVideoSize: 'Reset size',
		enableVideoResize: 'Allow video resizing',
		enableVideoResizeDescription: 'Show an external double-corner drag handle that resizes the expanded player while preserving the video aspect ratio.',
		resizeVideoPlayer: 'Resize video player',
		closeMediaPlayer: 'Close {media} player',
		mediaTimestampPlayer: '{media} timestamp player',
		noEmbeddedMedia: 'No embedded {media} file was found in the current note.',
		ambiguousMedia: 'Multiple {media} files were found. Add a {media} alias to this timestamp.',
		duplicateAlias: 'The {media} alias "{id}" is declared more than once.',
		unknownAlias: 'The {media} alias "{id}" was not found in this note.',
		selectionFailed: 'The {media} file could not be selected.',
		playbackBlocked: 'Playback was blocked. Select the timestamp again.',
		mediaLoadFailed: 'The {media} file could not be loaded.',
	},
	'zh-CN': {
		language: '语言',
		languageDescription: '仅设置此插件所使用的界面语言。',
		followObsidian: '跟随 Obsidian',
		simplifiedChinese: '简体中文',
		english: 'English',
		audio: '音频',
		video: '视频',
		whenSwitchingPages: '切换页面时',
		navigationDescription: '打开其他笔记、文件或标签页后，选择如何处理{media}播放器。',
		continuePlayback: '继续播放',
		pausePlayback: '暂停播放',
		closePlayer: '关闭播放器',
		videoDisplay: '视频播放器显示方式',
		videoDisplayDescription: '选择悬浮视频播放器只显示紧凑控件，还是同时显示视频画面。',
		compactControls: '紧凑控件',
		showVideo: '显示视频画面',
		videoSize: '展开视频尺寸',
		videoSizeDescription: '拖动展开播放器右下角可以调整大小，插件会自动保存最后一次使用的尺寸。',
		resetVideoSize: '重置大小',
		enableVideoResize: '允许拖动调整视频大小',
		enableVideoResizeDescription: '在展开视频播放器右下角外侧显示双折角拖动柄，并保持视频原始宽高比进行缩放。',
		resizeVideoPlayer: '调整视频播放器大小',
		closeMediaPlayer: '关闭{media}播放器',
		mediaTimestampPlayer: '{media}时间码播放器',
		noEmbeddedMedia: '当前笔记中没有找到嵌入的{media}文件。',
		ambiguousMedia: '当前笔记包含多个{media}文件，请为时间码指定{media}别名。',
		duplicateAlias: '{media}别名“{id}”在当前笔记中重复声明。',
		unknownAlias: '当前笔记中没有找到{media}别名“{id}”。',
		selectionFailed: '无法选择对应的{media}文件。',
		playbackBlocked: '播放被阻止，请再次点击时间码。',
		mediaLoadFailed: '无法加载{media}文件。',
	},
} as const;

export type MessageKey = keyof typeof messages.en;

export function resolveLanguage(language: PluginLanguage): ResolvedLanguage {
	return resolvePluginLanguage(language, moment.locale());
}

export function translate(
	language: PluginLanguage,
	key: MessageKey,
	parameters: Record<string, string> = {},
): string {
	let value: string = messages[resolveLanguage(language)][key];
	for (const [name, replacement] of Object.entries(parameters)) {
		value = value.replaceAll(`{${name}}`, replacement);
	}
	return value;
}
