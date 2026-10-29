import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // vite 5.4 把 node:sqlite 当包名解析（Failed to load url sqlite）。
    // 测试环境 alias 到 CJS shim（原生 require 透传）；插件 bundle 不受影响。
    alias: [
      {
        find: /^node:sqlite$/,
        replacement: path.resolve(__dirname, "node-sqlite-shim.cjs"),
      },
    ],
  },
  test: {
    // node:sqlite 只在 Node ≥22.13 免 flag 可用（本机 22.14；renderer 是 Node 24）
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
  },
});
