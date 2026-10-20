/**
 * 歌词原文预处理：在交给 LRC / 逐字解析器之前归一化内嵌标签文本。
 */

/**
 * 丢弃首个 `[mm:ss.xx]`（含百分秒）之前的全部文本；可跨行或去掉同行左缀。
 * 未出现该模式则原样返回。用于去掉 [ar:]、[hash:]、[language:] 等非演唱内容。
 */
export function stripLeadingLyricsMetadata(text: string): string {
	const match = /\[\d{2}:\d{2}\.\d{2}\]/.exec(text);
	if (!match || match.index === undefined) {
		return text;
	}
	return text.slice(match.index);
}
