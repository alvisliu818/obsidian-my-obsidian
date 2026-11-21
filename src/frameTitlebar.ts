/**
 * 去掉自定义顶栏右键菜单(用户 2026-11-21「你把自定义的去掉就行了」):
 * 无边框窗口的标题栏条(.titlebar)与工作区标签条空白区右键,Obsidian 核心会
 * 弹自绘的「最小化/还原/关闭」窗口菜单——用户不要它。文档级捕获拦截:
 * 命中顶栏区域即 preventDefault + stopPropagation,什么都不弹;
 * 标签本身(.workspace-tab-header)的右键菜单(Obsidian 原生标签菜单:
 * 关闭/关闭其他等)不受影响。
 */
export function suppressFrameTitlebarMenu(): void {
	document.addEventListener(
		'contextmenu',
		(ev) => {
			const t = ev.target as HTMLElement | null;
			if (!t) return;
			if (!t.closest('.titlebar, .workspace-tab-header-container')) return;
			if (t.closest('.workspace-tab-header')) return; // 标签右键 = 原生标签菜单
			ev.preventDefault();
			ev.stopPropagation();
		},
		true,
	);
}
