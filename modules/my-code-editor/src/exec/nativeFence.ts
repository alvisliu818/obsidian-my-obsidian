/**
 * 原生 markdown 管线（CM6 编辑器 + 阅读模式）的围栏代码块解析。
 *
 * 纯函数、零 obsidian 依赖：输入行文本数组，输出块列表。CM 侧
 * (exec/nativeCodeBlockRun.ts) 每次装饰重建时把 doc 各行喂进来；测试侧
 * (tests/nativeFence.test.ts) 直接喂字符串数组。
 *
 * 语言映射沿用 runner.langFromTag 的口径（python / js / shell 三类可运行），
 * runner 的依赖闭包同样是 obsidian-free 的，这里直接复用不复制表。
 */
import { langFromTag } from './runner';

export interface FenceBlock {
	/** 开栅栏行号（1 基，与 CM 的 doc.line(n) 对齐） */
	open: number;
	/** 闭栅栏行号（1 基）；未闭合 = 文档末行 */
	close: number;
	/** info string 的首个 token（小写；未写语言 = 空串） */
	lang: string;
	/** 语言是否可运行（python / javascript / shell） */
	runnable: boolean;
	/**
	 * 可运行块在文档内的序号（0 基，按出现顺序）。用它做运行状态的键：
	 * 比「代码文本哈希」抗编辑（上方改动不换号），比「代码块 hash」稳定。
	 * 不可运行的块为 -1（它们不占号）。
	 */
	ordinal: number;
}

const OPEN_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 扫描全部行，返回按出现顺序排列的围栏块（含不可运行的——闭合扫描需要
 * 完整的配对信息，跳过它们会让后续块的配对错位）。
 */
export function parseFences(lines: readonly string[]): FenceBlock[] {
	const out: FenceBlock[] = [];
	let ordinal = 0;
	let i = 0;
	while (i < lines.length) {
		const m = OPEN_RE.exec(lines[i]);
		if (!m) {
			i++;
			continue;
		}
		const marker = m[1];
		const ch = marker[0];
		const len = marker.length;
		const lang = (m[2] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
		// 闭合 = 同字符、长度不小于开标记、其余是空白。字符放进字符类免转义
		// （反引号/波浪线在 [...] 里都是字面量）。
		const closeRe = new RegExp(`^\\s{0,3}[${ch}]{${len},}\\s*$`);
		let closeIdx = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if (closeRe.test(lines[j])) {
				closeIdx = j;
				break;
			}
		}
		const closed = closeIdx >= 0;
		const runnable = langFromTag(lang) !== null;
		out.push({
			open: i + 1,
			close: closed ? closeIdx + 1 : lines.length,
			lang,
			runnable,
			ordinal: runnable ? ordinal++ : -1,
		});
		i = closed ? closeIdx + 1 : lines.length;
	}
	return out;
}
