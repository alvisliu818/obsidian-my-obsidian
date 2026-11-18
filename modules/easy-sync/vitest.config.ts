import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // local-scanner 链上有 `import from 'obsidian'`（TFolder 运行时导入 +
    // Vault 类型）——单测里解析到编译期桩（save-control 同款）。
    alias: [
      { find: /^obsidian$/, replacement: path.resolve(__dirname, 'obsidian-stub.js') },
    ],
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**'],
  },
});
