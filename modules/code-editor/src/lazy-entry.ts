/**
 * monaco-editor 懒包入口（聚合主仓内存优化）。
 * 独立 esbuild 构建 → lazy/monaco.js，运行时经 editor/lazyMonaco.ts 的
 * 代理命名空间首次触碰加载。
 */
export * from 'monaco-editor';
