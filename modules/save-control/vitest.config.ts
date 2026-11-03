import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // storage/targets 链上有 `import from 'obsidian'`（TFile 等只在 Obsidian
    // 运行时存在）——单测里解析到编译期桩。
    alias: [
      { find: /^obsidian$/, replacement: path.resolve(__dirname, 'obsidian-stub.js') },
    ],
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**'],
  },
});
