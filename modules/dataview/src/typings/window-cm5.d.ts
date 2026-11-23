/**
 * dataview 收编适配（2026-11-23）：CM5 全局对象形状。
 *
 * dataviewjs 代码高亮经 window.CodeMirror（Obsidian 编辑器挂的 CM5 实例）
 * 注册/注销 javascript 模式（main.ts 的 registerDataviewjsCodeHighlighting）。
 * 上游 tsconfig check:false 从不门禁类型，聚合仓标准是模块自带 tsconfig 零
 * 错误——这里补上 Window 增强声明（仅类型层，零运行时影响）。
 */
declare global {
	interface Window {
		CodeMirror: {
			defineMode(name: string, mode: (config: unknown) => unknown): unknown;
			getMode(config: unknown, spec: string): unknown;
		};
	}
}

export {};
