/**
 * terminal 懒包入口（聚合主仓内存优化）：@xterm/* + tmp-promise 注册表。
 * 独立 esbuild 构建 → lazy/terminal-xterm.js，imports.ts 的 BUNDLE 工厂
 * 经运行时动态 require 首次触碰加载。键 = BUNDLE 的模块名。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const registry: Record<string, unknown> = {
  "@xterm/addon-canvas": require("@xterm/addon-canvas"),
  "@xterm/addon-fit": require("@xterm/addon-fit"),
  "@xterm/addon-ligatures": require("@xterm/addon-ligatures"),
  "@xterm/addon-search": require("@xterm/addon-search"),
  "@xterm/addon-serialize": require("@xterm/addon-serialize"),
  "@xterm/addon-unicode11": require("@xterm/addon-unicode11"),
  "@xterm/addon-web-links": require("@xterm/addon-web-links"),
  "@xterm/addon-webgl": require("@xterm/addon-webgl"),
  "@xterm/xterm": require("@xterm/xterm"),
  "tmp-promise": require("tmp-promise"),
};
export = registry;
