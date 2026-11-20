/**
 * 库外媒体/图片锚定子系统(renderTree 拆分,2026-11-21):从 renderTree.ts 原样
 * 迁出的媒体相关面——
 *   - 库外媒体解析与 blob URL 缓存(resolveExternalMedia/externalMediaUrl);
 *   - 库外媒体 token 锚定(anchorExternalMedia → applyAnchoredMediaSrcs);
 *   - 库内 img 相对 src 锚定(anchorRelativeImgSrcs → applyAnchoredImgSrcs,
 *     防库内同名劫持);
 *   - 媒体元素点击打开(wireMediaOpen:图片单击/视频双击 → 增强查看器)。
 * 纯机制:依赖 obsidian(TFile/MarkdownRenderer)+virtual-tree 的 extFs/视图
 * 类型,与块渲染管线解耦;renderTree 按 API 名再导出保持消费面稳定。
 */
import { TFile } from 'obsidian';
import { baseOf, exists, extOf, readExternalBinary } from '../../../virtual-tree/src/features/extFs';
import { VIEW_TYPE_IMAGE } from '../../../virtual-tree/src/views/ImageView';
import { VIEW_TYPE_VIDEO } from '../../../virtual-tree/src/views/VideoView';
import type { BlockRenderHost } from '../blocks/renderHost';
import { makeTokenSystem, type AnchorTokenSystem } from '../core/anchorTokens';

/**
 * HTML img 相对 src 锚定 —— 防止库内同名文件劫持。
 *
 * Word/OneNote 导出的笔记用 <img src="media/imageN.png"> 相对路径引用图片。
 * Obsidian MarkdownRenderer 对 HTML img 的 src 走全局链接解析（库根优先，
 * 未命中后全库模糊匹配），库内存在其他笔记的同名 media/imageN.png 时会
 * 渲染出错误的图片（实测：NLP 笔记的 image6 被深度学习笔记的 tensor
 * 截图劫持，库内同名词达 10 处）。
 *
 * 修复：渲染前把能解析到库内文件的相对 src 替换成 token（解析顺序 =
 * md 所在目录优先，其次库根）；渲染后用该文件的资源 URL 恢复。
 * 解析不到文件的 src 原样保留，交给 Obsidian 的默认行为。
 */
export type ImgAnchorToken = { token: string; url: string; /** 库外文件的绝对路径(库内为空);渲染后挂 data-lgp-media-abs 供点击打开。 */ abs?: string };

const IMG_ANCHOR_PREFIX = 'LGIMGANCHOR';
const IMG_EXT_RE = /^(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/** 视频扩展(与 views/VideoView 的 VIDEO_EXTENSIONS 对齐)。 */
export const VIDEO_EXT_RE = /^(mp4|webm|ogv|m4v|mov|mkv|avi|wmv|flv|mpg|mpeg|3gp|ts)$/i;
/** 音频扩展(渲染 `<audio controls>`;双击打开暂无独立视图,仅渲染)。 */
const AUDIO_EXT_RE = /^(mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i;
/** 全部媒体扩展(md/wiki 嵌入的库外解析范围)。 */
const MEDIA_EXT_RE = /^(png|jpe?g|gif|webp|svg|bmp|avif|ico|mp4|webm|ogv|m4v|mov|mkv|avi|wmv|flv|mpg|mpeg|3gp|ts|mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i;

const IMG_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	avif: 'image/avif',
	ico: 'image/x-icon',
};

/** 视频/音频的 MIME(图片走 IMG_MIME)。 */
const AVM_MIME: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	avi: 'video/x-msvideo',
	wmv: 'video/x-ms-wmv',
	flv: 'video/x-flv',
	mpg: 'video/mpeg',
	mpeg: 'video/mpeg',
	'3gp': 'video/3gpp',
	ts: 'video/mp2t',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	m4a: 'audio/mp4',
	flac: 'audio/flac',
	aac: 'audio/aac',
	opus: 'audio/ogg',
	weba: 'audio/webm',
};

function mediaMimeOf(name: string): string {
	const ext = extOf(name);
	return IMG_MIME[ext] ?? AVM_MIME[ext] ?? 'application/octet-stream';
}

/** 库外媒体文件的 blob URL 缓存(同一文件多次渲染复用,上限 80 个)。 */
const externalMediaUrls = new Map<string, string>();

function externalMediaUrl(abs: string): string {
	const hit = externalMediaUrls.get(abs);
	if (hit) return hit;
	const url = URL.createObjectURL(new Blob([readExternalBinary(abs)], { type: mediaMimeOf(baseOf(abs)) }));
	externalMediaUrls.set(abs, url);
	if (externalMediaUrls.size > 80) {
		const oldest = externalMediaUrls.keys().next().value as string;
		const old = externalMediaUrls.get(oldest);
		if (old) URL.revokeObjectURL(old);
		externalMediaUrls.delete(oldest);
	}
	return url;
}

/** blob URL → abs 反查(点击打开用;库内 app:// URL 查不到返回空)。 */
export function absOfExternalMediaUrl(url: string): string {
	if (!url.startsWith('blob:')) return '';
	for (const [abs, u] of externalMediaUrls) {
		if (u === url) return abs;
	}
	return '';
}

/** 文件所在目录(库外 abs;两种分隔符都认)。 */
function externalBaseDir(abs: string): string {
	const norm = abs.replace(/[\\/]+$/, '');
	const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
	return idx > 0 ? norm.slice(0, idx) : norm;
}

/**
 * 库外媒体解析:src 相对 externalAbs 所在目录,一层层往上找(用户指定顺序,
 * 附件目录挂在任意祖先都命中),Node fs 在盘上探测;命中即建 blob URL。
 * 全部未命中返回 null,src 原样保留交还默认行为。
 * 图片/视频/音频统一走这里(md/wiki 形式与 HTML img 共用)。
 */
function resolveExternalMedia(raw: string, baseDir: string): { url: string; abs: string } | null {
	if (!raw || /^(app|https?|data|vault|file|mailto):/i.test(raw) || raw.startsWith('/')) return null;
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		/* 保留原文 */
	}
	const name = decoded.split(/[\\/]/).pop() ?? '';
	if (!MEDIA_EXT_RE.test(extOf(name))) return null;
	const parts = baseDir.split(/[\\/]/).filter(Boolean);
	const tail = decoded.split('/').join('\\');
	for (let i = parts.length; i >= 0; i--) {
		const dir = parts.slice(0, i).join('\\');
		const candidate = dir ? `${dir}\\${tail}` : tail;
		if (exists(candidate)) return { url: externalMediaUrl(candidate), abs: candidate };
	}
	return null;
}

/** 普通链接(非嵌入)指向库外媒体时解析 abs;不建 blob URL(查看器自己读)。 */
export function resolveExternalMediaHref(href: string, externalAbs: string): string {
	if (!href || /^(app|https?|data|vault|file|mailto):/i.test(href) || href.startsWith('/')) return '';
	let decoded = href;
	try {
		decoded = decodeURIComponent(href);
	} catch {
		/* 保留原文 */
	}
	const name = decoded.split(/[\\/]/).pop() ?? '';
	if (!MEDIA_EXT_RE.test(extOf(name))) return '';
	const baseDir = externalBaseDir(externalAbs);
	const parts = baseDir.split(/[\\/]/).filter(Boolean);
	const tail = decoded.split('/').join('\\');
	for (let i = parts.length; i >= 0; i--) {
		const dir = parts.slice(0, i).join('\\');
		const candidate = dir ? `${dir}\\${tail}` : tail;
		if (exists(candidate)) return candidate;
	}
	return '';
}

export type ImgAnchorSystem = AnchorTokenSystem<ImgAnchorToken>;

/** 新的库内 img 锚定系统(每次渲染新建,计数从 0 起)。 */
export function makeImgAnchorSystem(): ImgAnchorSystem {
	return makeTokenSystem<ImgAnchorToken>(IMG_ANCHOR_PREFIX);
}

export function anchorRelativeImgSrcs(
	md: string,
	host: BlockRenderHost,
	sys: ImgAnchorSystem,
): string {
	const file = host.file;
	if (!file) return md; // 片段场景无基准目录，维持现状
	// 库外文件(挂载树打开):host.file 是种子笔记,其目录不可信——以
	// externalAbs 所在目录为基准解析。否则锚定整个失效,src 漏给全局模糊
	// 匹配,被库内同名图片劫持(实测:库外 NLP 笔记被别的笔记的截图顶替)。
	const ext = host as { isExternal?: boolean; externalAbs?: string };
	const externalBase =
		ext.isExternal === true && ext.externalAbs ? externalBaseDir(ext.externalAbs) : null;
	const rewrite = (m: string, pre: string, src: string, post: string): string => {
		let url: string | null = null;
		let abs: string | undefined;
		if (externalBase) {
			const hit = resolveExternalMedia(src, externalBase);
			if (hit) {
				url = hit.url;
				abs = hit.abs;
			}
		} else {
			const resolved = resolveVaultImgUrl(src, file, host);
			url = resolved ? host.app.vault.getResourcePath(resolved) : null;
		}
		if (!url) return m;
		const token = sys.take({ url, abs }).token;
		return `${pre}${token}${post}`;
	};
	return md
		.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, rewrite)
		.replace(/(<img\b[^>]*?\bsrc=')([^']*)(')/gi, rewrite);
}

/** 库内解析:md 所在目录 → 逐级父目录 → 库根(用户指定顺序),再退
 * getFirstLinkpathDest(sourcePath 感知);全未命中返回 null。 */
function resolveVaultImgUrl(raw: string, file: TFile, host: BlockRenderHost): TFile | null {
	if (!raw || /^(app|https?|data|vault|file|mailto):/i.test(raw) || raw.startsWith('/')) return null;
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		/* 保留原文 */
	}
	const dir = file.parent?.path ?? '';
	const parts = dir.split('/');
	for (let i = parts.length; i >= 0; i--) {
		const base = parts.slice(0, i).join('/');
		const p = base ? `${base}/${decoded}` : decoded;
		const found = host.app.vault.getAbstractFileByPath(p);
		if (found instanceof TFile && IMG_EXT_RE.test(found.extension)) return found;
	}
	const dest = host.app.metadataCache.getFirstLinkpathDest(decoded, file.path);
	if (dest instanceof TFile && IMG_EXT_RE.test(dest.extension)) return dest;
	return null;
}

/** 渲染后：把 token src 恢复为锚定文件的资源 URL(库内 app://,库外 blob)。 */
export function applyAnchoredImgSrcs(
	holder: HTMLElement,
	_host: BlockRenderHost,
	sys: ImgAnchorSystem,
): void {
	if (!sys.all().length) return;
	holder.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
		const src = img.getAttribute('src') || '';
		if (!sys.fullRe().exec(src)) return;
		const entry = sys.entryOf(src);
		if (entry?.url) {
			img.setAttribute('src', entry.url);
			// 点击打开查看器要用绝对路径:库外挂 abs,库内留空(wireMediaOpen 不接管)。
			if (entry.abs) img.dataset.lgpMediaAbs = entry.abs;
		}
	});
}

// ---------------------------------------------------------------------------
// 库外媒体嵌入（md `![](rel)` / wiki `![[name]]` / HTML video+audio）的
// token 化渲染。图片 md 形式此前没有任何库外解析(HTML img 有),视频/音频
// 两者皆无——挂载笔记里的 `![clip.mp4](rel)` 全是破图。统一方案:渲染前把
// 能解析到库外文件的媒体嵌入换成「占位 img token」(.png 后缀骗 MarkdownRenderer
// 出 <img>,token 非真实路径不会被链接解析改写),渲染后按 token 换成真正的
// <img>/<video>/<audio> 并填 blob URL,同时挂 data-lgp-media-abs 供点击打开。
// 库内文件不进这条链(MarkdownRenderer 自己就解析得到)。
// ---------------------------------------------------------------------------

export type MediaAnchorToken = {
	token: string;
	kind: 'image' | 'video' | 'audio';
	url: string;
	abs: string;
};

const MEDIA_ANCHOR_PREFIX = 'LGMEDIAANCHOR';
/** 占位 img 的 src:前缀+序号+前缀+.png(渲染成 <img> 才好替换)。 */
const MEDIA_ANCHOR_IMG_RE = new RegExp(`^${MEDIA_ANCHOR_PREFIX}(\\d+)${MEDIA_ANCHOR_PREFIX}\\.png$`);

export type MediaAnchorSystem = AnchorTokenSystem<MediaAnchorToken>;

/** 新的库外媒体锚定系统(每次渲染新建,计数从 0 起)。 */
export function makeMediaAnchorSystem(): MediaAnchorSystem {
	return makeTokenSystem<MediaAnchorToken>(MEDIA_ANCHOR_PREFIX);
}

function mediaKindOfName(name: string): 'image' | 'video' | 'audio' | '' {
	const ext = extOf(name);
	if (IMG_EXT_RE.test(ext)) return 'image';
	if (VIDEO_EXT_RE.test(ext)) return 'video';
	if (AUDIO_EXT_RE.test(ext)) return 'audio';
	return '';
}

/**
 * 渲染前:库外笔记的媒体嵌入 → 占位 token。库内 host 原样返回(md 媒体嵌入
 * 由 MarkdownRenderer 原生渲染)。
 */
export function anchorExternalMedia(
	md: string,
	host: BlockRenderHost,
	sys: MediaAnchorSystem,
): string {
	const ext = host as { isExternal?: boolean; externalAbs?: string };
	if (ext.isExternal !== true || !ext.externalAbs) return md;
	const baseDir = externalBaseDir(ext.externalAbs);

	const push = (srcRaw: string, alt: string): string | null => {
		// md 链接的 src 可能带 URL 编码;wiki 目标是裸名/相对路径。
		const hit = resolveExternalMedia(srcRaw, baseDir);
		if (!hit) return null;
		const kind = mediaKindOfName(baseOf(hit.abs));
		if (!kind) return null;
		const token = sys.take({ kind, url: hit.url, abs: hit.abs }).token;
		return `![${alt}](${token}.png)`;
	};

	return md
		// md 嵌入 `![alt](src)`:src 非协议、媒体扩展 → token。
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) => {
			if (/^(app|https?|data|vault|file|mailto):/i.test(src)) return m;
			return push(src, alt) ?? m;
		})
		// wiki 嵌入 `![[target|W]]`:按文件名/相对路径向上找。
		.replace(/!\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g, (m, target: string) => {
			return push(target.trim(), baseOf(target.trim())) ?? m;
		})
		// HTML video/audio 的 src:token 原样(无 .png,渲染后按 raw 正则匹配)。
		.replace(/(<video\b[^>]*?\bsrc=")([^"]*)(")/gi, (m, pre: string, src: string, post: string) => {
			if (/^(app|https?|data|vault|file|blob|mailto):/i.test(src) || src.startsWith('/')) return m;
			const hit = resolveExternalMedia(src, baseDir);
			if (!hit) return m;
			const token = sys.take({ kind: 'video', url: hit.url, abs: hit.abs }).token;
			return `${pre}${token}${post}`;
		})
		.replace(/(<audio\b[^>]*?\bsrc=")([^"]*)(")/gi, (m, pre: string, src: string, post: string) => {
			if (/^(app|https?|data|vault|file|blob|mailto):/i.test(src) || src.startsWith('/')) return m;
			const hit = resolveExternalMedia(src, baseDir);
			if (!hit) return m;
			const token = sys.take({ kind: 'audio', url: hit.url, abs: hit.abs }).token;
			return `${pre}${token}${post}`;
		});
}

function mediaElFor(entry: MediaAnchorToken): HTMLElement {
	if (entry.kind === 'video') {
		const v = document.createElement('video');
		v.controls = true;
		v.preload = 'metadata';
		v.src = entry.url;
		v.dataset.lgpMediaAbs = entry.abs;
		return v;
	}
	if (entry.kind === 'audio') {
		const a = document.createElement('audio');
		a.controls = true;
		a.preload = 'metadata';
		a.src = entry.url;
		a.dataset.lgpMediaAbs = entry.abs;
		return a;
	}
	const img = document.createElement('img');
	img.src = entry.url;
	img.dataset.lgpMediaAbs = entry.abs;
	return img;
}

/** 渲染后:占位 token → 真正的媒体元素(视频/音频)或直接填 src(图片)。 */
export function applyAnchoredMediaSrcs(holder: HTMLElement, sys: MediaAnchorSystem): void {
	if (!sys.all().length) return;
	holder.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
		const m = MEDIA_ANCHOR_IMG_RE.exec(img.getAttribute('src') || '');
		if (!m) return;
		const entry = sys.entryOf(img.getAttribute('src') || '');
		if (!entry) return;
		img.replaceWith(mediaElFor(entry));
	});
	holder.querySelectorAll<HTMLVideoElement | HTMLAudioElement>('video[src], audio[src]').forEach((el) => {
		const src = el.getAttribute('src') || '';
		if (!sys.fullRe().exec(src)) return;
		const entry = sys.entryOf(src);
		if (!entry) return;
		el.src = entry.url;
		el.dataset.lgpMediaAbs = entry.abs;
	});
}

/**
 * 库外媒体元素的点击打开（块编辑器内的查看器入口）:
 *   - 单击 <img data-lgp-media-abs> → 增强图片查看器(阻止进入块编辑);
 *   - 双击 <video data-lgp-media-abs> → 视频播放器(阻止原生全屏);
 * 单击视频不动——controls 的播放/暂停是原生交互。库内媒体元素没有 abs,
 * 不被接管(原生预览已够,右键菜单/命令面板有增强入口)。
 */
export function wireMediaOpen(holder: HTMLElement, host: BlockRenderHost): void {
	// HTML img 锚定链路(imgAnchorTokens)只有 blob url 没有 abs:统一按 url
	// 反查补齐 data-lgp-media-abs,后面的事件挂载就不用区分两条链路。
	holder.querySelectorAll<HTMLImageElement>('img[src^="blob:"]').forEach((img) => {
		if (!img.dataset.lgpMediaAbs) {
			const abs = absOfExternalMediaUrl(img.getAttribute('src') || '');
			if (abs) img.dataset.lgpMediaAbs = abs;
		}
	});

	const openFor = (el: HTMLElement): void => {
		const abs = el.dataset.lgpMediaAbs;
		if (!abs) return;
		if (el instanceof HTMLVideoElement) {
			void host.plugin.openExternalInView(VIEW_TYPE_VIDEO, { abs, name: baseOf(abs) });
		} else {
			void host.plugin.openExternalInView(VIEW_TYPE_IMAGE, { abs, name: baseOf(abs) });
		}
	};

	holder.querySelectorAll<HTMLElement>('img[data-lgp-media-abs]').forEach((img) => {
		img.addEventListener('click', (e) => {
			// 拖拽改宽结束后的一次「click」不算点击打开(enhanceImages 的
			// resize corner 在真正拖动时置标记)。
			const wrap = img.closest('.lgp-img-wrap') as HTMLElement | null;
			if (wrap?.dataset.lgpResized === '1') {
				delete wrap.dataset.lgpResized;
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			openFor(img);
		});
	});
	holder.querySelectorAll<HTMLVideoElement>('video[data-lgp-media-abs]').forEach((v) => {
		v.addEventListener('dblclick', (e) => {
			e.preventDefault();
			e.stopPropagation();
			openFor(v);
		});
	});
}
