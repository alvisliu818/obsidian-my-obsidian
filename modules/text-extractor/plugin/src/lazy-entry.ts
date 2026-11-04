/**
 * obsidian-text-extract 懒包入口（聚合主仓内存优化）。
 *
 * 独立 esbuild 构建（见根 esbuild.mjs 的懒包段）→ lazy/text-extract.js，
 * 运行时经 lazyTextExtract.ts 的动态 require 首次触碰加载。
 */
export * from 'obsidian-text-extract';
