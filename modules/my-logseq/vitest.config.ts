import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // 2026-10-27 发现：src 下混着 133 个未跟踪的 tsc emit 残骸（*.js / *.test.js），
    // Node ESM resolve 先吃 .js —— 改 .ts 的行为被旧产物毒化（实测：parser.js 里
    // 还是改前的代码，TRACE 完全不出现）。esbuild 不受影响（resolveExtensions
    // .ts 优先），只有 vitest 中招。这里把 .ts 提到 .js 前面。
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    // Unit tests import src modules that `import from 'obsidian'` —
    // resolve it to the compile-time stub (the real API only exists in Obsidian).
    alias: [
      { find: /^obsidian$/, replacement: path.resolve(__dirname, 'obsidian-stub.js') },
      // monaco-editor 同理:renderTree → codeBlockEdit → monaco.ts 的链要能
      // 解析,但编辑器本体只在 Obsidian 运行时存在(e2e 才真正创建)。
      { find: /^monaco-editor$/, replacement: path.resolve(__dirname, '../my-code-editor/monaco-stub.js') },
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
      // 残骸 .test.js（tsc emit 产物）不收集——vitest 吃旧 jsdom 缺失版本
      // 的既有问题（"Errors 3→6"）就是这么来的；正式测试只认 .test.ts。
      '**/*.test.js',
    ],
  },
});
