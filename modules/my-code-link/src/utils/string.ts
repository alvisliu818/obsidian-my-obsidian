/**
 * Remove any common leading whitespace from every line in text.
 * Mimics Python's textwrap.dedent.
 */
export function dedent(text: string): string {
	const lines = text.split('\n');
	const indents = lines
		.filter((line) => line.trim().length > 0)
		.map((line) => line.match(/^\s*/)![0]);

	if (indents.length === 0) {
		return lines.map(() => '').join('\n');
	}

	let common = indents[0] ?? '';
	for (let i = 1; i < indents.length; i++) {
		const indent = indents[i] ?? '';
		let j = 0;
		while (j < common.length && j < indent.length && common[j] === indent[j]) {
			j++;
		}
		common = common.substring(0, j);
		if (common === '') break;
	}

	const margin = common;
	return lines
		.map((line) => {
			if (line.trim().length === 0) return '';
			return line.startsWith(margin) ? line.substring(margin.length) : line;
		})
		.join('\n');
}

/**
 * Capitalize the first letter of a string.
 */
export function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Capitalize a language name, replacing underscores with spaces.
 */
export function capitalizeLang(lang: string): string {	const specialMap: Record<string, string> = {
		cpp: "C++",
		c_sharp: "C#",
		tsx: "TSX",
		javascript: "JavaScript",
		typescript: "TypeScript",
		json: "JSON",
		html: "HTML",
		css: "CSS",
		scss: "SCSS",
		yaml: "YAML",
		xml: "XML",
		php: "PHP",
		lua: "Lua",
	};

	const special: string | undefined = specialMap[lang.toLowerCase()];
	if (special) {
		return special;
	}

	return lang
		.split("_")
		.map((part) => capitalize(part))
		.join(" ");
}

/** 行锚(#L42)预览窗口的上下文行数:目标行上下各取多少行。 */
export const LINE_ANCHOR_CONTEXT = 5;

/**
 * 行锚预览窗口:以目标行为中心取上下文行,每行带 1-based 文件行号前缀
 * (等宽对齐)——预览里一眼可辨目标行,与编辑器 gutter 的心智模型一致。
 * 行号越界收进文件范围;不 dedent,保留原缩进。
 */
export function lineWindow(
	text: string,
	line: number,
	context: number = LINE_ANCHOR_CONTEXT
): string {
	const lines = text.split(/\r?\n/);
	if (lines.length === 0) {
		return "";
	}
	const center = Math.min(Math.max(Math.floor(line), 1), lines.length);
	const from = Math.max(0, center - 1 - context);
	const to = Math.min(lines.length, center + context);
	const width = String(to).length;
	const out: string[] = [];
	for (let i = from; i < to; i++) {
		out.push(`${String(i + 1).padStart(width)} | ${lines[i] ?? ""}`);
	}
	return out.join("\n");
}
