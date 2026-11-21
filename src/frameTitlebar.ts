/**
 * 顶栏右键窗口菜单开关（用户 2026-11-21「自定义菜单用开关控制,不去掉了」）：
 * suppress 开时，无边框窗口标题栏条（.titlebar）与工作区标签条空白区右键的
 * 自绘「最小化/还原/关闭」菜单被拦掉（什么都不弹）；关时恢复 Obsidian 原生
 * 行为（菜单照弹）。标签本身（.workspace-tab-header）的原生标签右键菜单
 * （关闭/关闭其他等）两种状态都不受影响。默认关 = 原生行为。
 * 由宿主设置 suppressTitlebarMenu 经 setTitlebarMenuSuppressed 驱动。
 */
let listener: ((ev: MouseEvent) => void) | null = null;

const handler = (ev: MouseEvent): void => {
	const t = ev.target as HTMLElement | null;
	if (!t) return;
	if (!t.closest('.titlebar, .workspace-tab-header-container')) return;
	if (t.closest('.workspace-tab-header')) return; // 标签右键 = 原生标签菜单
	ev.preventDefault();
	ev.stopPropagation();
};

export function setTitlebarMenuSuppressed(on: boolean): void {
	if (on && !listener) {
		listener = handler;
		document.addEventListener('contextmenu', listener, true);
	} else if (!on && listener) {
		document.removeEventListener('contextmenu', listener, true);
		listener = null;
	}
}
