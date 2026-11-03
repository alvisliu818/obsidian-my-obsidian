/**
 * 文件名点击重命名开关（2026-11-04 用户需求）。
 *
 * 背景：Obsidian 1.15 的 `.view-header-title` 是 contenteditable="true"，
 * 点一下就聚焦进重命名编辑（focus 是 mousedown 的默认行为，事件拦截拦不住
 * —— 标题元素与各级祖先都没有 click 监听器，DOMDebugger 实测为零）。
 * 所以"关掉重命名"的正确姿势是把标题设回 contenteditable=false：点击不再
 * 聚焦编辑，虚拟树的标题点击同级面板（logseq headerPath 的 click 监听）
 * 照常工作。
 *
 * 锁的边界：只在标题元素上打 `data-lgp-title-lock` + contenteditable=false；
 * 开关切回"开"时只摘自己打的锁（core 自己的状态不动）。核心重开视图/重渲染
 * 会重写标题属性 —— 由观察器（childList）+ 布局事件随时补锁。
 */
import type { App } from 'obsidian';

const LOCK_ATTR = 'data-lgp-title-lock';
const SELECTOR = '.view-header-title';

/** 按开关状态套/摘锁：enabled=false = 锁住不可编辑。幂等。 */
export function applyTitleRenameLock(_app: App | null, enabled: boolean): void {
	sweep(document, enabled);
}

/** 布局事件/观察器调用的轻量补扫。 */
export function sweepTitleRenameLock(enabled: boolean): void {
	sweep(document, enabled);
}

function sweep(doc: Document, enabled: boolean): void {
	try {
		for (const el of doc.querySelectorAll<HTMLElement>(SELECTOR)) {
			if (enabled) {
				// 只摘自己打的锁，并还原锁前的 contenteditable 值（core 对文件视图
				// 是 "true"——已打开的视图解锁即恢复可编辑，不用等重渲染）
				if (el.getAttribute(LOCK_ATTR) === '1') {
					const prev = el.dataset['lgpTitlePrev'] ?? '';
					if (prev) el.setAttribute('contenteditable', prev);
					else el.removeAttribute('contenteditable');
					el.removeAttribute(LOCK_ATTR);
					delete el.dataset['lgpTitlePrev'];
				}
			} else {
				if (el.getAttribute(LOCK_ATTR) === '1') continue; // 已锁
				const prev = el.getAttribute('contenteditable') ?? '';
				// 原生可编辑（"true"）或未声明（点击聚焦语义）→ 锁成不可编辑
				el.setAttribute('contenteditable', 'false');
				el.setAttribute(LOCK_ATTR, '1');
				el.dataset['lgpTitlePrev'] = prev;
			}
		}
	} catch {
		/* 窗口销毁竞态 */
	}
}

/**
 * 常驻观察：新视图/重渲染出现标题就按当前开关补锁。返回卸载函数。
 * 只挂主窗文档（弹窗里的市场等场景无文件名标题；编辑器页签都在主窗）。
 */
export function startTitleRenameObserver(app: App, isEnabled: () => boolean): () => void {
	applyTitleRenameLock(app, isEnabled());
	let timer = 0;
	const schedule = (): void => {
		if (timer) return;
		timer = window.setTimeout(() => {
			timer = 0;
			sweepTitleRenameLock(isEnabled());
		}, 200);
	};
	const mo = new MutationObserver(schedule);
	mo.observe(document.documentElement, { childList: true, subtree: true });
	const onLayout = (): void => sweepTitleRenameLock(isEnabled());
	app.workspace.on('layout-change', onLayout);
	app.workspace.on('active-leaf-change', onLayout);
	return () => {
		if (timer) window.clearTimeout(timer);
		mo.disconnect();
		app.workspace.off('layout-change', onLayout);
		app.workspace.off('active-leaf-change', onLayout);
		// 模块卸载 = 恢复原生可编辑
		applyTitleRenameLock(app, true);
	};
}
