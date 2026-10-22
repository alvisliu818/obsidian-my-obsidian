import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // 单测 import 的 src 里 `import from "obsidian"` —— 真正的 API 只在
    // Obsidian 里存在,这里替换成编译期替身。
    alias: [{ find: /^obsidian$/, replacement: path.resolve(__dirname, "obsidian-stub.js") }],
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "tests/e2e/**",
    ],
  },
});
