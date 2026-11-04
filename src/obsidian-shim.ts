/**
 * 懒包的 obsidian 桥（聚合主仓内存优化）。
 *
 * 懒加载分包（lazy/*.js）经裸 node require 加载，没有插件加载器的模块映射，
 * require('obsidian') 解析不到。宿主主 bundle 启动时把 obsidian API 挂到
 * globalThis.__lgpObsidianApi（它自己的 require('obsidian') 走插件加载器），
 * 本 shim 在懒包构建时以 esbuild alias 内联。
 *
 * 注意保持 ESM 具名导出形态（不要用 module.exports——会覆盖懒包入口自身的
 * 导出）。成员清单按需扩充；default 是 Proxy 兜底，命名空间导入也能取到
 * 任意成员。
 */

const obsidian = (globalThis as { __lgpObsidianApi?: Record<string, unknown> }).__lgpObsidianApi;

export const Platform = obsidian?.Platform;
export const FileSystemAdapter = obsidian?.FileSystemAdapter;
export const MarkdownView = obsidian?.MarkdownView;
export const TFile = obsidian?.TFile;
export const TFolder = obsidian?.TFolder;
export const Notice = obsidian?.Notice;
export const Modal = obsidian?.Modal;
export const Setting = obsidian?.Setting;
export const PluginSettingTab = obsidian?.PluginSettingTab;
export const Menu = obsidian?.Menu;
export const requestUrl = obsidian?.requestUrl;
export const addIcon = obsidian?.addIcon;

export default new Proxy(
	{} as Record<string, unknown>,
	{
		get(_t, prop: string) {
			return obsidian?.[prop];
		},
	},
);
