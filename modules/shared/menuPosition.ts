/**
 * Obsidian 1.15 跨窗口菜单坐标补偿（依赖-free，各模块 Menu.showAtPosition 调用方共用）。
 *
 * 实测（1.15.1，e2e 探针 tests/e2e/_diag-browser-menupos.mjs）：showAtPosition
 * 把菜单渲染进 activeDocument 所在窗口（设置 popout modal realm 的独立 OS 窗口），
 * 用的是**调用方视口坐标原样**——框架不做两窗口原点差换算，菜单整体偏移
 * （偏移量 = realm 窗口原点 − 调用窗口原点；探针实测 requested(100,100) →
 * realm 本地 (102,102)，identity + 菜单自带的 2px 设计偏移）。
 *
 * 补偿：减去两窗口 screenX/screenY 差。同窗渲染（无 realm / 老版本行为）时
 * identity，探针验证补偿后视觉落点 = 期望屏幕点 ± 2px。
 *
 * 注意：菜单窗口未覆盖到的屏幕区域菜单会被裁切（框架级限制，插件侧无法解）。
 */
export function compensateMenuPosition(x: number, y: number): { x: number; y: number } {
	try {
		const doc = (globalThis as { activeDocument?: Document }).activeDocument;
		const win = doc?.defaultView;
		if (!win || win === window) return { x, y };
		return { x: x - (win.screenX - window.screenX), y: y - (win.screenY - window.screenY) };
	} catch {
		return { x, y };
	}
}
