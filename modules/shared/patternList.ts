/**
 * 名单模式（黑白名单）的编译与命中 —— 纯函数，被多处共用：
 *  - 虚拟文档树的隐藏 / 例外名单、只读名单（virtual-tree/mountFilter）；
 *  - 索引忽略的黑名单 / 白名单（shared/indexIgnore，库内扫描与守护进程共用）。
 *
 * 语法（每行一条，三种形态）：
 *   - 纯文本：名字或路径段**整段相等**（`Notes` 不误伤 `Notes2`）；
 *   - 裸正则：出现正则元字符即按正则解释，如 `^\.`、`\.tmp$`；
 *   - `/正则/flags`：flags 可省，默认 `i`；有状态 flag（g/y）会被剥掉，
 *     否则 test() 在连续调用间跳着命中。
 *
 * 不 import obsidian、不碰 fs/DOM：守护进程（MyKernel.cjs）也直接复用。
 */

/** 单条名单模式：纯文本（整段相等）或正则。 */
export interface PatternSpec {
	/** 纯文本形态：整段相等。 */
	literal?: string;
	/** 正则形态。 */
	re?: RegExp;
}

/** 正则元字符：出现任意一个就按正则解释，否则按纯文本段匹配。 */
const REGEX_META = /[\\^$.*+?()[\]{}|]/;

/** 单条模式 → 编译结果；空/非法返回 null（一条坏正则不该弄坏整条链路）。 */
export function patternFrom(raw: string): PatternSpec | null {
	let body = raw.trim();
	if (!body) return null;
	const wrapped = /^\/(.+)\/([a-z]*)$/.exec(body);
	if (wrapped) {
		body = wrapped[1];
		let flags = wrapped[2] || 'i';
		if (!flags.includes('i')) flags += 'i';
		// 有状态的 flag 会让 test() 在连续调用间跳着命中，名单匹配必须无状态
		flags = flags.replace(/[gy]/g, '');
		try {
			return { re: new RegExp(body, flags) };
		} catch {
			return null;
		}
	}
	if (!REGEX_META.test(body)) return { literal: body };
	try {
		return { re: new RegExp(body, 'i') };
	} catch {
		return null;
	}
}

/** 一组名单模式编译；空条目与非法正则直接跳过。 */
export function compilePatternList(list: readonly string[] | undefined): PatternSpec[] {
	const out: PatternSpec[] = [];
	for (const p of list ?? []) {
		const pat = patternFrom(p);
		if (pat) out.push(pat);
	}
	return out;
}

/**
 * 正则命中判定：全路径、裸名字、以及**每一个路径段**都测一遍。
 *
 * 段边界三查是必要的：`[\\/]archive[\\/]` 是「archive 文件夹」的自然写法，
 * 但它匹配不到 `archive/note.md`——文件夹是第一段，前面没有分隔符。给每段
 * 两侧补上合成 `/` 再测，首尾位置才和中间位置行为一致。
 */
export function matchesPathPattern(rel: string, name: string, re: RegExp): boolean {
	if (re.test(rel) || re.test(name)) return true;
	const segments = rel.split('/');
	for (let i = 0; i < segments.length - 1; i++) {
		if (re.test(segments[i])) return true;
		if (re.test(`/${segments[i]}/`)) return true;
	}
	return false;
}

/** 纯文本模式：末段相等，或路径中间某一段相等。 */
function hitsLiteral(rel: string, name: string, literal: string): boolean {
	if (name === literal) return true;
	const segments = rel.split('/');
	for (let i = 0; i < segments.length - 1; i++) {
		if (segments[i] === literal) return true;
	}
	return false;
}

/** 任一条模式命中（纯文本按整段相等，正则走段边界三查）。 */
export function patternsHit(rel: string, name: string, patterns: readonly PatternSpec[]): boolean {
	for (const p of patterns) {
		if (p.literal !== undefined) {
			if (hitsLiteral(rel, name, p.literal)) return true;
		} else if (p.re && matchesPathPattern(rel, name, p.re)) {
			return true;
		}
	}
	return false;
}
