/**
 * MOBILE_BUILD=full：把 Node/Electron 内建模块解析到轻量替身。
 *
 * 与 scripts/mobile-build-plugin.mjs（精简版，裁剪模块）不同：整包模式
 * 保留所有模块，只在构建期把顶层 `require("electron")` / `import "fs"`
 * 换成 src/mobile-node-stub.ts，避免移动端加载 main.js 时直接抛错。
 * 桌面常规构建不注册这个插件。
 */
import path from 'node:path';

const STUB = path.resolve('src/mobile-node-stub.ts');
const STUBBED = new Set([
  'electron', 'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'sqlite', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

function isStubbed(spec) {
  const s = spec.startsWith('node:') ? spec.slice(5) : spec;
  // `fs/promises`、`node:timers/promises` 这类子路径按根模块名匹配
  return STUBBED.has(s) || STUBBED.has(s.split('/')[0]);
}

export function mobileFullNodePlugin() {
  return {
    name: 'mobile-full-node-stub',
    setup(build) {
      build.onResolve({ filter: /^node:|^electron$|^[a-z_][a-z0-9_]*(\/[a-z0-9_/-]+)?$/ }, (args) => {
        // dataview 把本地 utils 伪装成裸 `util`，由 dataviewUtilResolver 接；
        // 这里不能抢（否则 canonicalizeVarName 等命名导入找不到）。
        const importer = (args.importer ?? '').split(path.sep).join('/');
        if (/^util(\/|$)/.test(args.path) && importer.includes('/modules/dataview/')) return undefined;
        if (!isStubbed(args.path)) return undefined;
        return { path: STUB };
      });
    },
  };
}
