/**
 * MOBILE_BUILD esbuild 插件：把聚合包裁成「主插件壳 + easy-sync」。
 *
 * 设计目标：desktop 常规构建零改动。所有裁剪只在本插件注册时生效，
 * 且只在 MOBILE_BUILD=1 时由 esbuild.mjs 注册。
 *
 * 两步：
 *  1) onLoad 改写 src/main.ts —— 把 `readonly descriptors: ModuleDescriptor[] = [...]`
 *     整段替换为只含 easy-sync 那一项（用源码里的唯一标记定位，不做脆弱的
 *     大段正则）。easy-sync 的 require 桥与所有壳机制原样保留。
 *  2) onResolve 把「其它模块入口」与「模块专属 helper」的 specifier 重定向
 *     到 src/mobile-stub.ts。被裁掉的模块源码因此根本不进入构建图。
 *
 * 注意：easy-sync 自身必须放行（它自包含，只依赖 obsidian）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const STUB = path.resolve("src/mobile-stub.ts");

/** 保留的真实模块 specifier（片段匹配）——只有 easy-sync。 */
const KEEP_MODULE = /modules\/easy-sync\//;

/**
 * 需要重定向到 stub 的 specifier。
 *  - 所有 `../modules/<任意>/src/main`（及已知变体 main.ts / package 入口）
 *  - md-editor 的 ExternalCodeView、code-editor 的两个 exec helper
 *  - 宿主 src/ 下会拉入模块代码的 helper
 * easy-sync 由上面的 KEEP_MODULE 先行放行。
 */
function shouldStub(spec) {
  const s = spec.split(path.sep).join("/");
  // easy-sync 与其内部文件：放行（自包含）
  if (s.includes("modules/easy-sync/")) return false;
  // 任何模块入口 / 模块内文件
  if (/\/modules\//.test(s)) return true;
  // 宿主 helper（相对 specifier 与其绝对解析形式都覆盖）
  const helpers = [
    "codeFileView", "dataviewBridge", "extensionRegistry", "windowFrame",
    "remoteBootstrap", "atLinkSuggest", "libraryInitPatch",
  ];
  if (helpers.some((h) => s === `./${h}` || s.endsWith(`/${h}`) || s.endsWith(`/${h}.ts`))) return true;
  return false;
}

/** 从 main.ts 源码里定位 descriptors 数组并替换为单元素版本。 */
function cropDescriptors(src) {
  const startMark = "\treadonly descriptors: ModuleDescriptor[] = [";
  const start = src.indexOf(startMark);
  if (start < 0) throw new Error("[mobile] descriptors 起点未找到");
  // 数组结束：从 start 起第一个顶格 tab 的 `\t];`
  const end = src.indexOf("\n\t];", start);
  if (end < 0) throw new Error("[mobile] descriptors 终点未找到");
  const onlyEasySync = `\treadonly descriptors: ModuleDescriptor[] = [
\t\t{
\t\t\t// MOBILE_BUILD：只保留 easy-sync，其余模块在构建期被裁剪。
\t\t\tid: "easy-sync",
\t\t\tname: "EasySync",
\t\t\tmanifest: { version: "1.7.1" },
\t\t\tmigrateFrom: "easy-sync",
\t\t\tsummary: "双向 OneDrive 同步：冲突保护、移动端支持、可选的设置/插件同步。",
\t\t\tdesktopOnly: false,
\t\t\tcls: EasySyncPlugin as unknown as ModuleDescriptor["cls"],
\t\t},`;
  return src.slice(0, start) + onlyEasySync + src.slice(end);
}

export function mobileSlimPlugin() {
  const HOST_MAIN = path.resolve("src/main.ts");
  return {
    name: "mobile-slim-only-easysync",
    setup(build) {
      // onResolve 先于 onLoad：把非 easy-sync 的模块/helper 指向 stub。
      // filter 用宽松匹配，真正判断在回调里做（namespace 为空=磁盘路径解析）。
      build.onResolve({ filter: /modules\/|codeFileView|dataviewBridge|extensionRegistry|windowFrame|remoteBootstrap|atLinkSuggest|libraryInitPatch/ }, (args) => {
        if (shouldStub(args.path)) return { path: STUB };
        return undefined;
      });
      // onLoad 改写宿主 src/main.ts 的 descriptors——必须精确匹配宿主文件，
      // 绝不能命中 modules/*/src/main.ts（easy-sync 自己的入口也长这样）。
      build.onLoad({ filter: /main\.ts$/ }, async (args) => {
        if (path.resolve(args.path) !== HOST_MAIN) return undefined;
        const original = await readFile(args.path, "utf8");
        const contents = cropDescriptors(original);
        return { contents, loader: "ts" };
      });
    },
  };
}
