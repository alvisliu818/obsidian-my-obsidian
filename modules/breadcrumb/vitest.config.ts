import { defineConfig } from 'vitest/config';

/**
 * 面包屑模块的单测配置。
 *
 * 只有纯逻辑（codeOutline / headingTree）进单测——DOM 与 Obsidian 宿主行为
 * 由 `tests/smoke.cjs`（真实构建产物 + DOM 桩）覆盖。codeOutline 不 import
 * obsidian，因此这里不需要别名。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
