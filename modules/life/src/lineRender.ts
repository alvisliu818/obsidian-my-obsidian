/**
 * 对比视图的行级渲染(2026-11-22 用户:差异里要渲染内容,不能只是原文)。
 *
 * 约束:两栏按行对齐、行高固定,所以这里只产出**行内** HTML(span/strong/em/
 * code 等),绝不产生块级元素;文本一律先转义,只有本文件生成的标签会进 DOM。
 *
 * - Markdown「渲染」模式:逐行轻量 Markdown(标题/粗斜体/行内代码/链接/列表/
 *   引用/任务框),围栏代码块整段交给 Monaco 着色;
 * - Markdown「Monaco」模式:整段按 markdown 语言交给 Monaco colorize,再按行切分;
 * - 代码文件:整段按语言交给 Monaco colorize,再按行切分(跨行 token 不中断);
 * - Monaco 不可用:全部退化为纯文本转义。
 *
 * colorize 由调用方注入(宿主 monaco.editor.colorize),本文件不 import Monaco,
 * 保证纯函数可测、也避免在无 DOM 的测试环境拉起 Monaco。
 */

export type ColorizeFn = (text: string, languageId: string) => Promise<string>;

export interface RenderOptions {
	/** Markdown 渲染方式:editor = 行内渲染(默认),monaco = Monaco 源码着色 */
	mdMode: 'editor' | 'monaco';
	/** Monaco colorize;缺失时退化为纯文本 */
	colorize?: ColorizeFn;
	/** 代码文件的 Monaco 语言 id(非代码/未知为 null) */
	languageId?: string | null;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const isMarkdownPath = (path: string): boolean => /\.md$/i.test(path);

/** 整段文本 → Monaco 着色 → 按行切分(Monaco 每行后加 <br/>,末尾会多一条)。 */
async function colorizeToLines(
	lines: string[],
	languageId: string,
	colorize?: ColorizeFn,
): Promise<string[]> {
	if (!colorize || !languageId) return lines.map(escapeHtml);
	try {
		const html = await colorize(lines.join('\n'), languageId);
		const parts = html.split(/<br\s*\/?>/i);
		while (parts.length > lines.length && parts[parts.length - 1].trim() === '') parts.pop();
		return lines.map((text, i) => parts[i] ?? escapeHtml(text));
	} catch {
		return lines.map(escapeHtml);
	}
}

/** 行内 Markdown → HTML(先转义,再套标签;代码片段用占位符保护)。 */
function renderInline(text: string): string {
	let esc = escapeHtml(text);
	const codes: string[] = [];
	esc = esc.replace(/`([^`]+)`/g, (_m, code: string) => {
		codes.push(`<code class="vl-md-code">${code}</code>`);
		return `\u0000${codes.length - 1}\u0000`;
	});
	esc = esc.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="vl-md-link">🖼 $1</span>');
	esc = esc.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) =>
		`<span class="vl-md-link">${b || a}</span>`,
	);
	esc = esc.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="vl-md-link">$1</span>');
	esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	esc = esc.replace(/__([^_]+)__/g, '<strong>$1</strong>');
	esc = esc.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
	esc = esc.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
	esc = esc.replace(/~~([^~]+)~~/g, '<del>$1</del>');
	esc = esc.replace(/==([^=]+)==/g, '<mark>$1</mark>');
	return esc.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

/** 单行 Markdown(块级前缀转成行内样式,保证固定行高)。 */
export function renderMarkdownLine(line: string): string {
	const heading = /^(\s*)(#{1,6})\s+(.*)$/.exec(line);
	if (heading) {
		return `${heading[1]}<span class="vl-md-h vl-md-h${heading[2].length}">${renderInline(heading[3])}</span>`;
	}
	const task = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/.exec(line);
	if (task) {
		const box = task[3].toLowerCase() === 'x' ? '☑' : '☐';
		return `${task[1]}<span class="vl-md-bullet">${box}</span> ${renderInline(task[4])}`;
	}
	const bullet = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
	if (bullet) {
		const mark = /\d/.test(bullet[2]) ? bullet[2] : '•';
		return `${bullet[1]}<span class="vl-md-bullet">${mark}</span> ${renderInline(bullet[3])}`;
	}
	const quote = /^(\s*)>\s?(.*)$/.exec(line);
	if (quote) return `${quote[1]}<span class="vl-md-quote">▏</span> ${renderInline(quote[2])}`;
	if (/^\s*(?:[-*_])(?:\s*[-*_]){2,}\s*$/.test(line)) {
		return `<span class="vl-md-hr">${escapeHtml(line)}</span>`;
	}
	return renderInline(line);
}

/** Markdown 全文 → 每行 HTML;围栏代码块整段用 Monaco 着色。 */
export async function renderMarkdownLines(
	lines: string[],
	colorize?: ColorizeFn,
): Promise<string[]> {
	const out: string[] = new Array(lines.length).fill('');
	const blocks: Array<{ start: number; end: number; lang: string; content: string[] }> = [];
	let open: { start: number; lang: string } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const fence = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/.exec(lines[i]);
		if (fence) {
			out[i] = `<span class="vl-md-fence">${escapeHtml(lines[i])}</span>`;
			if (open) {
				blocks.push({
					start: open.start + 1,
					end: i,
					lang: open.lang,
					content: lines.slice(open.start + 1, i),
				});
				open = null;
			} else {
				open = { start: i, lang: fence[2] ?? '' };
			}
			continue;
		}
		if (open) continue; // 代码块内容稍后整段渲染
		out[i] = renderMarkdownLine(lines[i]);
	}
	if (open) {
		blocks.push({
			start: open.start + 1,
			end: lines.length,
			lang: open.lang,
			content: lines.slice(open.start + 1),
		});
	}
	for (const block of blocks) {
		const rendered = await colorizeToLines(block.content, block.lang, colorize);
		for (let k = 0; k < rendered.length; k++) out[block.start + k] = rendered[k];
	}
	return out;
}

/** 按文件类型渲染全文行:Markdown(行内 / Monaco)/ 代码 Monaco / 纯文本。 */
export async function renderFileLines(
	path: string,
	lines: string[],
	opts: RenderOptions,
): Promise<string[]> {
	if (isMarkdownPath(path) && opts.mdMode === 'monaco') {
		return colorizeToLines(lines, 'markdown', opts.colorize);
	}
	if (opts.languageId) return colorizeToLines(lines, opts.languageId, opts.colorize);
	if (isMarkdownPath(path)) return renderMarkdownLines(lines, opts.colorize);
	return lines.map(escapeHtml);
}
