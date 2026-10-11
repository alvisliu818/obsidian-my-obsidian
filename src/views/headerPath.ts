/**
 * 视图头部（标签页下面那条导航条）的完整路径面包屑。
 *
 * 虚拟文档树打开的文件不在库里，Obsidian 只给自定义视图留了一个**空的**
 * `.view-header-title-parent`（原生 FileView 会在这里放 `E2E /` 这样的目录链），
 * 于是标签页下面只剩一个文件名，看不出文件在磁盘上的位置。这里按原生 FileView
 * 的 DOM 结构补上「挂载名 / 子目录 / … /」，观感与库内笔记一致。
 */

import { Notice } from 'obsidian';

export interface HeaderSegment {
	/** 这一段显示的文字 */
	label: string;
	/** 这一段对应的磁盘绝对路径（悬浮提示，点击复制） */
	abs: string;
}

/**
 * 由「挂载相对路径」反推每一段的绝对路径。
 *
 * `rel` 是挂载根起的路径且含文件名（`probe-drag/c1.md`），文件名本身交给
 * 标题，不当面包屑段。`mountLabel` 为空时不显示挂载名那一段（此时退化为
 * 纯子目录链，仍然能说明位置）。
 */
export function headerPathSegments(abs: string, rel: string, mountLabel: string): HeaderSegment[] {
	const full = (abs || '').replace(/\\/g, '/');
	if (!full) return [];
	const relParts = (rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
	relParts.pop(); // 最后一段是文件名本身

	const fileIdx = full.lastIndexOf('/');
	const dirAbs = fileIdx >= 0 ? full.slice(0, fileIdx) : '';
	// dirAbs 去掉尾部 relParts.length 段，剩下的就是挂载根
	const rootParts = dirAbs.split('/');
	if (relParts.length) {
		rootParts.splice(Math.max(0, rootParts.length - relParts.length), relParts.length);
	}
	const root = rootParts.join('/');

	const out: HeaderSegment[] = [];
	if (mountLabel) out.push({ label: mountLabel, abs: root });
	let cur = root;
	for (const part of relParts) {
		cur = cur ? `${cur}/${part}` : part;
		out.push({ label: part, abs: cur });
	}
	return out;
}

/** 把路径段画成原生样式的 view-header 面包屑；重复调用会先清空。 */
export function renderHeaderPath(container: HTMLElement, segments: HeaderSegment[]): void {
	container.empty();
	for (const seg of segments) {
		const span = container.createSpan({ cls: 'view-header-breadcrumb', text: seg.label });
		span.setAttribute('aria-label', seg.label);
		span.setAttribute('draggable', 'true');
		span.title = seg.abs;
		span.addEventListener('click', () => {
			void navigator.clipboard?.writeText(seg.abs).then(
				() => new Notice(`已复制路径：${seg.abs}`),
				() => new Notice(`复制失败：${seg.abs}`),
			);
		});
		container.createSpan({ cls: 'view-header-breadcrumb-separator', text: '/' });
	}
}

/** 视图头部里放面包屑的那个容器（原生 FileView 用它放目录链）。 */
export function headerTitleParent(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>('.view-header-title-parent');
}

/**
 * 刷新视图头部的路径面包屑。
 *
 * 头部由框架装配，`onOpen` 时未必已经挂上，所以画完再在下一帧补一次——
 * 幂等（每次都先清空），多画一次没有副作用。
 */
export function applyHeaderPath(host: HTMLElement, segments: HeaderSegment[]): void {
	const render = (): void => {
		const parent = headerTitleParent(host);
		if (!parent) return;
		renderHeaderPath(parent, segments);
	};
	render();
	window.requestAnimationFrame(render);
}
