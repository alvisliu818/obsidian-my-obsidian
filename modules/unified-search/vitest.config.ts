import { defineConfig } from 'vitest/config';
import path from 'node:path';

// dataview 收编（2026-11-23）：round-trip 测试经 dvImport 调 dataview 自家
// parsePage——上游 tsconfig baseUrl 裸导入（from "data-import/..."）vite 不认，
// 逐前缀别名指入（与根 esbuild.mjs 的 dataviewSrcResolver 同语义）。
const dvSrc = path.resolve(__dirname, '../dataview/src');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: ['api', 'data-import', 'data-index', 'data-model', 'expression', 'query', 'settings', 'status', 'ui', 'util', 'index'].map((p) => ({
      find: p,
      replacement: path.join(dvSrc, p),
    })),
  },
});
