/**
 * 标题栏 spacer 接管，受「顶栏右键窗口菜单」开关控制（2026-11-21 终版）。
 *
 * 背景:Obsidian 1.14+ 的 frameless 标题栏里,标签栏空白区
 * (.workspace-tab-header-spacer)是 `-webkit-app-region: drag`——drag 区域
 * 右键由 Chromium 弹 Windows 完整系统窗口菜单（还原/移动/大小/最小化/
 * 最大化/关闭）,样式与 Obsidian 界面格格不入（2026-11-20 用户报「很丑」）。
 *
 * 开关语义（用户 2026-11-21「主窗口本来就有完整系统菜单,不需要写代码」）:
 *  - 开（suppressTitlebarMenu=true）→ 接管 spacer:改 no-drag(根除原生菜单),
 *    右键弹 Obsidian 简版菜单（最小化/最大化·还原/关闭;关闭走 window.close()
 *    与标题栏 X 同路,保留未保存三选一流程）,左键拖窗自实现（no-drag 后
 *    spacer 失去原生拖窗;electron.remote 同步 IPC,按 rAF 节流;最大化状态
 *    跳过,不模拟系统「拖动即还原」）。
 *  - 关（false/缺省）→ **完全放手**:样式与监听器全部撤除,spacer 恢复
 *    drag——右键完整系统菜单、左键拖窗都是主窗口原生行为,零代码。
 *
 * 标签页本体与其余 titlebar 区域永远不动:拖窗口、标签操作、标签右键菜单
 * 两种状态下都原样。
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

/** 开关的运行时入口:设置页 toggle 与 onload 初始态都走这里(幂等)。 */
let applyTakeover: ((on: boolean) => void) | null = null;

export function setTitlebarMenuSuppressed(on: boolean): void {
	applyTakeover?.(on);
}

export function setupTitlebarWindowMenu(plugin: Plugin, initial: boolean): void {
	if (!Platform.isDesktopApp) return;
	const spacerSel = '.workspace-tab-header-spacer';

	// spacer → no-drag(根除 Chromium 原生系统菜单;关=撤样式恢复 drag)
	const style = document.createElement('style');
	style.textContent = `${spacerSel} { -webkit-app-region: no-drag !important; }`;

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

	let applied = false;
	const apply = (on: boolean): void => {
		if (on === applied) return;
		applied = on;
		if (on) {
			document.head.appendChild(style);
			document.addEventListener('contextmenu', onCtx, true);
			document.addEventListener('mousedown', onDown, true);
			document.addEventListener('mousemove', onMove, true);
			document.addEventListener('mouseup', onUp, true);
		} else {
			style.remove();
			document.removeEventListener('contextmenu', onCtx, true);
			document.removeEventListener('mousedown', onDown, true);
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
		}
	};
	apply(initial);
	applyTakeover = apply;
	plugin.register(() => {
		apply(false);
		applyTakeover = null;
	});
}
