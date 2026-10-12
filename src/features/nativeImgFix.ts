/**
 * 原生 markdown 视图的 HTML img 相对 src 修正。
 *
 * 背景：Word/OneNote 导出的笔记用 <img src="media/imageN.png"> 相对路径引用
 * 图片。Obsidian 原生渲染（实时预览/阅读视图）对 HTML img 的 src 做**全局**
 * 解析（库根优先，未命中后全库模糊匹配），不做「相对当前文件目录」的就近
 * 解析。当库内存在其他笔记的同名 media/imageN.png 时（实测一个主库同名词
 * 超过 10 处），图片内容被别的文件顶替——渲染出完全无关的截图。
 *
 * 本钩子对所有 markdown 渲染生效（registerMarkdownPostProcessor），渲染后把
 * 能锚定到「当前文件所在目录」的相对 src 重写为正确资源 URL：
 * - 分支 1：src 仍是原始相对路径 → 直接锚定重写；
 * - 分支 2：src 已被 Obsidian 重写为劫持目标 → 从 section 源文本反推原始
 *   构造序列（HTML img / md 图 / wiki 嵌入），与 DOM img 按文档序配对，仅对
 *   HTML img 位置做锚定重写（md 图与 wiki 嵌入的解析本来就就近优先，无需修）。
 * 数量不齐（渲染失败/懒加载节流）时保守跳过，不猜。
 */

import { TFile, type MarkdownPostProcessorContext, type Plugin } from 'obsidian';

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
/**
 * 文本中的图片构造（按出现顺序）：HTML img / markdown 图 / wiki 嵌入。
 * 与渲染 DOM 的 img 元素一一对应（Obsidian 对每个构造输出恰好一个 img）。
 */
const CONSTRUCT_RE =
	/<img\b[^>]*?\bsrc="([^"]+)"[^>]*>|!\[[^\]]*\]\(([^)\s]+)[^)]*\)|!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

export function registerNativeImgFix(plugin: Plugin): void {
	const resolveCache = new Map<string, string | null>();

	const resolve = (raw: string, dir: string): string | null => {
		if (!raw || /^(app|https?|data|vault|file|mailto):/i.test(raw) || raw.startsWith('/')) return null;
		const key = dir + '|' + raw;
		const cached = resolveCache.get(key);
		if (cached !== undefined) return cached;
		let decoded = raw;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			/* 保留原文 */
		}
		let result: string | null = null;
		const candidates = dir ? [dir + '/' + decoded, decoded] : [decoded];
		for (const candidate of candidates) {
			const f = plugin.app.vault.getAbstractFileByPath(candidate);
			if (f instanceof TFile && IMG_EXT_RE.test(f.extension)) {
				result = plugin.app.vault.getResourcePath(f);
				break;
			}
		}
		resolveCache.set(key, result);
		return result;
	};

	plugin.registerMarkdownPostProcessor(
		(el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			const imgs = Array.from(el.querySelectorAll('img'));
			if (!imgs.length) return;
			const file = ctx.sourcePath ? plugin.app.vault.getAbstractFileByPath(ctx.sourcePath) : null;
			if (!(file instanceof TFile)) return;
			const dir = file.parent?.path ?? '';

			// 分支 1：src 仍是原始相对路径（未被 Obsidian 重写）→ 直接锚定
			let fixedAny = false;
			for (const img of imgs) {
				const fixed = resolve(img.getAttribute('src') || '', dir);
				if (fixed) {
					img.setAttribute('src', fixed);
					fixedAny = true;
				}
			}
			if (fixedAny) return;

			// 分支 2：src 已被全局解析重写 → section 源文本反推配对
			const info = ctx.getSectionInfo(el);
			const text = info?.text;
			if (!text) return;
			const constructs: { kind: 'html' | 'other'; raw: string }[] = [];
			CONSTRUCT_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = CONSTRUCT_RE.exec(text)) !== null) {
				if (m[1] !== undefined) constructs.push({ kind: 'html', raw: m[1] });
				else constructs.push({ kind: 'other', raw: m[2] ?? m[3] ?? '' });
			}
			if (!constructs.length || constructs.length !== imgs.length) return;
			for (let i = 0; i < imgs.length; i++) {
				if (constructs[i].kind !== 'html') continue;
				const fixed = resolve(constructs[i].raw, dir);
				if (fixed) imgs[i].setAttribute('src', fixed);
			}
		},
	);
}
