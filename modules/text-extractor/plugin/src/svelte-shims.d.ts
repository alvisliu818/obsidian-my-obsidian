/**
 * 聚合仓适配：tsc 程序不含 svelte 编译，.svelte 导入按通用组件模块兜底
 * （LangSelector 由 esbuild 的模块级 esbuild-svelte 实例在打包期编译）。
 * 本模块组件是 svelte 3 class 组件——settings.ts 用 `new LangSelector({
 * target })` 实例化，类型上声明成可构造类。
 */
declare module '*.svelte' {
  const component: new (
    options: { target: Element; props?: Record<string, unknown> },
  ) => unknown
  export default component
}
