import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      // store.ts import 的 obsidian API 在测试环境不存在——给编译期桩
      { find: /^obsidian$/, replacement: path.resolve(__dirname, 'obsidian-stub.js') },
    ],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**'],
  },
});
