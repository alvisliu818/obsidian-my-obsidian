/**
 * 根据本行内所有时间戳，计算每个字/词高亮结束时间：
 * 取严格大于该字「开始时间」的下一个时间戳（即标签流中的后一时间戳），不用下一行时间。
 */
export function resolveCharEndTimes(
	chars: ReadonlyArray<{ time: number }>,
	lineTimeStamps?: ReadonlyArray<number>
): number[] {
	const stamps =
		lineTimeStamps && lineTimeStamps.length > 0
			? [...new Set(lineTimeStamps)].sort((a, b) => a - b)
			: null;

	return chars.map((charData, i) => {
		const t0 = charData.time;
		if (stamps) {
			const nextStamp = stamps.find((t) => t > t0);
			if (nextStamp !== undefined) {
				return nextStamp;
			}
		}
		const rest = chars.slice(i + 1);
		const next = rest.find((c) => c.time > t0);
		if (next !== undefined) {
			return next.time;
		}
		return t0 + 0.12;
	});
}

/**
 * 按真实时间区间 [t0, t1] 线性映射的填充比例（0～1）。
 */
export function linearFillProgress(
	currentTime: number,
	t0: number,
	t1: number
): number {
	if (currentTime <= t0) return 0;
	if (currentTime >= t1) return 1;
	const gap = t1 - t0;
	if (gap <= 0) return 1;
	return (currentTime - t0) / gap;
}
