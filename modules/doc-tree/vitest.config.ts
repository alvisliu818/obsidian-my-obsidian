import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // Unit tests import src modules that `import from 'obsidian'` —
    // resolve it to the compile-time stub (the real API only exists in Obsidian).
    alias: [
      { find: /^obsidian$/, replacement: path.resolve(__dirname, 'obsidian-stub.js') },
      // monaco-editor 同理:renderTree → codeBlockEdit → monaco.ts 的链要能
      // 解析,但编辑器本体只在 Obsidian 运行时存在(e2e 才真正创建)。
      { find: /^monaco-editor$/, replacement: path.resolve(__dirname, 'monaco-stub.js') },
      // `cm-bundle:<pkg>` — strip the prefix; node_modules resolution takes over
      // (the bundling split only matters inside Obsidian, not under vitest).
      { find: /^cm-bundle:/, replacement: '' },
    ],
  },
  test: {
    // Unit tests live next to the code they test; tests/e2e is driven by
    // Playwright against a real Obsidian instance (npm run e2e).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'tests/e2e/**',
    ],
  },
});
