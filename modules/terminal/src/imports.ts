import { deepFreeze, typedKeys } from "@polyipseity/obsidian-plugin-library";

declare const require: typeof window.require;

// 聚合主仓懒分包（2026-11-05）：@xterm/* + tmp-promise 拆独立懒包
// （lazy/terminal-xterm.js，esbuild LAZY_BUNDLES 构建，注册表形态），
// 首次触碰才 require。原上游形态是主 bundle 内联的工厂 map——esbuild 对
// 静态字符串 require 会整体打包进主 bundle（惰性失效），故改为运行时
// 动态 require 懒包注册表。
let lazyRegistry: Record<string, unknown> | null = null;
let lazyPluginDir: string | null = null;

export function initTerminalLazy(pluginDirAbs: string): void {
  lazyPluginDir = pluginDirAbs;
}

function loadLazyRegistry(): Record<string, unknown> {
  if (lazyRegistry === null) {
    if (lazyPluginDir === null) {
      throw new Error("[terminal] lazy xterm registry used before initTerminalLazy()");
    }
    lazyRegistry = require(`${lazyPluginDir}/lazy/terminal-xterm.js`) as Record<string, unknown>;
  }
  return lazyRegistry;
}

// Needed for bundler -- The bundler rewrites these lazy `require()` calls; ESM imports would load the modules eagerly.
const BUNDLE0 = deepFreeze({
  "@xterm/addon-canvas": (): unknown => loadLazyRegistry()["@xterm/addon-canvas"],

  "@xterm/addon-fit": (): unknown => loadLazyRegistry()["@xterm/addon-fit"],

  "@xterm/addon-ligatures": (): unknown => loadLazyRegistry()["@xterm/addon-ligatures"],

  "@xterm/addon-search": (): unknown => loadLazyRegistry()["@xterm/addon-search"],

  "@xterm/addon-serialize": (): unknown => loadLazyRegistry()["@xterm/addon-serialize"],

  "@xterm/addon-unicode11": (): unknown => loadLazyRegistry()["@xterm/addon-unicode11"],

  "@xterm/addon-web-links": (): unknown => loadLazyRegistry()["@xterm/addon-web-links"],

  "@xterm/addon-webgl": (): unknown => loadLazyRegistry()["@xterm/addon-webgl"],

  "@xterm/xterm": (): unknown => loadLazyRegistry()["@xterm/xterm"],

  "tmp-promise": (): unknown => loadLazyRegistry()["tmp-promise"],
});
export const BUNDLE = new Map(Object.entries(BUNDLE0)),
  MODULES =
    typedKeys<
      readonly [
        "@xterm/addon-canvas",
        "@xterm/addon-fit",
        "@xterm/addon-ligatures",
        "@xterm/addon-search",
        "@xterm/addon-serialize",
        "@xterm/addon-unicode11",
        "@xterm/addon-web-links",
        "@xterm/addon-webgl",
        "@xterm/xterm",
        "tmp-promise",
      ]
    >()(BUNDLE0);
