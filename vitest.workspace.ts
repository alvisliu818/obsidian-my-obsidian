/**
 * 根级 vitest 工作区（2026-11-07）。
 *
 * 动机：各模块的 vitest.config.ts 带着各自的 obsidian/electron/monaco stub
 * 别名——从仓库根裸跑 `vitest run modules/<mod>`（不带 --root）不会加载
 * 模块配置，凡 import 图里碰到 'obsidian'（npm 包只有类型没有运行时入口）
 * 的测试文件全部 collection 失败，症状是「Failed to resolve entry for
 * package obsidian」。曾误判为历史遗留；实际 8 个失败文件在正确调用
 * （--root modules/virtual-tree）下 17/17 全过。
 *
 * 本工作区把每个模块配置登记为独立 project：根目录任意 `vitest run`
 * （带或不带路径过滤器）都会按各模块自己的配置跑，裸调不再是陷阱。
 * `yarn test` 脚本仍按模块 --root 隔离跑，不受影响。
 */
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'modules/code-editor/vitest.config.ts',
  'modules/code-link/vitest.config.ts',
  'modules/index-core/vitest.config.ts',
  'modules/latex-delimiter-renderer/vitest.config.ts',
  'modules/md-editor/vitest.config.ts',
  'modules/obsidian-git/vitest.config.ts',
  'modules/omnisearch/vitest.config.ts',
  'modules/plugin-market/vitest.config.ts',
  'modules/ribbon-organizer/vitest.config.ts',
  'modules/save-control/vitest.config.ts',
  'modules/unified-search/vitest.config.ts',
  'modules/virtual-tree/vitest.config.ts',
]);
