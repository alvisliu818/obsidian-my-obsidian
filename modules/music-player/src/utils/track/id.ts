/**
 * 曲目 ID 工具模块
 * 
 * 提供曲目 ID 生成和管理的工具函数
 */

/**
 * 生成曲目 ID（基于文件路径的简单哈希）
 * 
 * 使用文件路径生成一个稳定的、唯一的 ID。
 * 使用简单的字符串哈希算法，确保相同路径总是生成相同的 ID。
 * 
 * @param filePath - 文件路径
 * @returns 曲目 ID（16 位十六进制字符串）
 */
export function generateTrackId(filePath: string): string {
	// 使用简单的字符串哈希算法
	// 这个算法确保相同路径总是生成相同的 ID
	let hash = 0;
	for (let i = 0; i < filePath.length; i++) {
		const char = filePath.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // 转换为 32 位整数
	}
	
	// 转换为正数并格式化为 16 位十六进制字符串
	const positiveHash = Math.abs(hash);
	return positiveHash.toString(16).padStart(16, '0');
}

/**
 * 从文件路径获取或生成曲目 ID
 * 
 * 如果设置中已存在该路径的 ID，返回现有 ID；
 * 否则生成新 ID 并添加到 trackIndex 中。
 * 
 * @param filePath - 文件路径
 * @param settings - 插件设置
 * @returns 曲目 ID
 */
export function getOrCreateTrackId(
	filePath: string,
	settings: { trackIndex: Record<string, string> }
): string {
	// 查找是否已存在该路径的 ID
	for (const [trackId, path] of Object.entries(settings.trackIndex)) {
		if (path === filePath) {
			return trackId;
		}
	}
	
	// 如果不存在，生成新 ID
	const trackId = generateTrackId(filePath);
	settings.trackIndex[trackId] = filePath;
	return trackId;
}

/**
 * 从曲目 ID 获取文件路径
 * 
 * @param trackId - 曲目 ID
 * @param settings - 插件设置
 * @returns 文件路径，如果 ID 不存在则返回 null
 */
export function getTrackPath(
	trackId: string,
	settings: { trackIndex: Record<string, string> }
): string | null {
	return settings.trackIndex[trackId] || null;
}

/**
 * 检查曲目 ID 是否有效（路径是否存在）
 * 
 * @param trackId - 曲目 ID
 * @param settings - 插件设置
 * @returns 如果 ID 有效返回 true，否则返回 false
 */
export function isValidTrackId(
	trackId: string,
	settings: { trackIndex: Record<string, string> }
): boolean {
	return trackId in settings.trackIndex;
}

