/**
 * 标题栏右键窗口菜单(2026-11-20 用户报「主库右键系统菜单变很丑」)。
 *
 * 背景:Obsidian 1.14+ 的 frameless 标题栏里,标签栏容器是
 * `-webkit-app-region: drag`——drag 区域右键由 **Chromium 原生**弹 Windows
 * 系统窗口菜单(还原/移动/大小/最小化/最大化/关闭):黑框系统样式,与
 * Obsidian 界面格格不入;且该行为在 native 层,JS 的 preventDefault 拦不住
 * (合成输入实验确认 contextmenu 会派发到页面,但真实输入的系统菜单在
 * native 弹,菜单内容不受渲染进程控制)。
 *
 * 方案:把标签栏**空白区**(.workspace-tab-header-spacer)改为 no-drag
 * (非 drag 区 Chromium 不弹系统菜单),在此区域自接管:
 *  - 右键 → Obsidian Menu(最小化/最大化·还原/关闭,风格与界面统一;
 *    关闭走 window.close() 与标题栏 X 同路,保留未保存三选一流程);
 *  - 左键拖动 → 自实现拖窗(electron.remote 同步 IPC,按 rAF 节流;
 *    最大化状态下跳过,不模拟系统「拖动即还原」)。
 *
 * 标签页本体与其余 titlebar 区域保持 drag:拖窗口、标签操作都原样。
 */
import { Menu, Platform, type Plugin } from 'obsidian';

interface ElectronWin {
	isMaximized?: () => boolean;
	minimize?: () => void;
	maximize?: () => void;
	unmaximize?: () => void;
	getBounds?: () => { x: number; y: number; width: number; height: number };
	setBounds?: (b: { x: number; y: number }) => void;
}

function currentWindow(): ElectronWin | null {
	try {
		return ((window as unknown as { electron?: { remote?: { getCurrentWindow?: () => ElectronWin } } }).electron?.remote?.getCurrentWindow?.() ?? null);
	} catch {
		return null;
	}
}

export function setupTitlebarWindowMenu(plugin: Plugin): void {
	if (!Platform.isDesktopApp) return;
	const spacerSel = '.workspace-tab-header-spacer';

	// spacer → no-drag(根除 Chromium 原生系统菜单)
	const style = document.createElement('style');
	style.textContent = `${spacerSel} { -webkit-app-region: no-drag !important; }`;
	document.head.appendChild(style);
	plugin.register(() => style.remove());

	const inSpacer = (target: EventTarget | null): boolean =>
		target instanceof Element && target.closest(spacerSel) !== null;

	// 右键:自定义窗口菜单
	const onCtx = (ev: MouseEvent): void => {
		if (!inSpacer(ev.target)) return;
		ev.preventDefault();
		ev.stopPropagation();
		const win = currentWindow();
		if (!win) return;
		const menu = new Menu();
		menu.addItem((item) => item.setTitle('最小化').onClick(() => win.minimize?.()));
		const maxed = win.isMaximized?.() ?? false;
		menu.addItem((item) => item.setTitle(maxed ? '还原' : '最大化').onClick(() => (maxed ? win.unmaximize?.() : win.maximize?.())));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('关闭').onClick(() => window.close()));
		menu.showAtMouseEvent(ev);
	};
	document.addEventListener('contextmenu', onCtx, true);
	plugin.register(() => document.removeEventListener('contextmenu', onCtx, true));

	// 左键拖动:自实现拖窗(rAF 节流,同步 IPC 每帧至多一次)
	let drag: { mx: number; my: number; wx: number; wy: number } | null = null;
	let pendingFrame = 0;
	const onDown = (ev: MouseEvent): void => {
		if (!inSpacer(ev.target) || ev.button !== 0) return;
		const win = currentWindow();
		if (!win?.getBounds || win.isMaximized?.()) return;
		const b = win.getBounds();
		drag = { mx: ev.screenX, my: ev.screenY, wx: b.x, wy: b.y };
	};
	const onMove = (ev: MouseEvent): void => {
		if (!drag || pendingFrame) return;
		pendingFrame = window.requestAnimationFrame(() => {
			pendingFrame = 0;
			if (!drag) return;
			const dx = ev.screenX - drag.mx;
			const dy = ev.screenY - drag.my;
			if (dx === 0 && dy === 0) return;
			currentWindow()?.setBounds?.({ x: drag.wx + dx, y: drag.wy + dy });
		});
	};
	const onUp = (): void => {
		if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
		pendingFrame = 0;
		drag = null;
	};
	document.addEventListener('mousedown', onDown, true);
	document.addEventListener('mousemove', onMove, true);
	document.addEventListener('mouseup', onUp, true);
	plugin.register(() => {
		document.removeEventListener('mousedown', onDown, true);
		document.removeEventListener('mousemove', onMove, true);
		document.removeEventListener('mouseup', onUp, true);
	});
}
