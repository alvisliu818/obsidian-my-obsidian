/**
 * 判断单段歌词文本更接近「逐字/卡拉 OK」还是「逐句 LRC」。
 *
 * 逐字：同一行内出现尖括号时间戳 <mm:ss.xx>，或一行内出现两个及以上 [mm:ss.xx]。
 * 逐句：通常每行仅一个行首 [mm:ss.xx]，且无尖括号时间戳。
 */
export function isTimestampedKaraokeLyrics(text: string): boolean {
	if (!text?.trim()) return false;
	if (/<\d{2}:\d{2}\.\d{2}>/.test(text)) return true;
	for (const line of text.split(/\r?\n/)) {
		const tags = line.match(/\[\d{2}:\d{2}\.\d{2}\]/g);
		if (tags && tags.length >= 2) return true;
	}
	return false;
}
