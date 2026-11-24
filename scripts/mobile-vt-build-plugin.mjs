/**
 * MOBILE_BUILD=vt：移动端精简包，只保留 EasySync + 虚拟文档树（virtual-tree）。
 *
 * 与 mobile-full-node-plugin 配合使用：本插件负责把其它模块的源码/宿主 helper
 * 重定向到空 stub，并把宿主 descriptors 裁成两项；Node/Electron 内建由
 * mobile-full-node-plugin 解析到 src/mobile-node-stub.ts。
 *
 * 为什么不用 mobile 分支的 mobile-build-plugin：那一版只留 easy-sync，而且
 * 宿主源码已漂移（descriptors 结构/标记不同）；这里直接在 main 上维护。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const STUB = path.resolve('src/mobile-stub.ts');
const HOST_MAIN = path.resolve('src/main.ts');

/** 保留的真实模块目录。 */
const KEEP = [/modules\/easy-sync\//, /modules\/virtual-tree\//];

/** 宿主 helper：会把模块实现/桌面能力拉进主 bundle 的，一律 stub。 */
// 注意：extensionRegistry 必须保留真实实现——virtual-tree 直接 import 它的
// registerFreeExtensions/takeOverExtensions；stub 掉会让虚拟树加载失败。
const HOST_HELPERS = [
  'codeFileView', 'dataviewBridge', 'windowFrame',
  'remoteBootstrap', 'atLinkSuggest', 'libraryInitPatch',
];

function shouldStub(spec) {
  const s = spec.split(path.sep).join('/');
  if (KEEP.some((re) => re.test(s))) return false;
  if (/\/modules\//.test(s)) return true;
  if (HOST_HELPERS.some((h) => s === `./${h}` || s.endsWith(`/${h}`) || s.endsWith(`/${h}.ts`))) return true;
  return false;
}

/** 用源码里的 descriptors 起点/终点标记做整段替换。 */
function cropDescriptors(src) {
  const startMark = '\treadonly descriptors: ModuleDescriptor[] = [';
  const start = src.indexOf(startMark);
  if (start < 0) throw new Error('[mobile-vt] descriptors 起点未找到');
  const end = src.indexOf('\n\t];', start);
  if (end < 0) throw new Error('[mobile-vt] descriptors 终点未找到');
  const kept = `\treadonly descriptors: ModuleDescriptor[] = [
\t\t{
\t\t\tid: "easy-sync",
\t\t\tname: "EasySync",
\t\t\tmanifest: { version: "1.7.1" },
\t\t\tmigrateFrom: "easy-sync",
\t\t\tsummary: "双向 OneDrive 同步：冲突保护、移动端支持、可选的设置/插件同步。",
\t\t\tdesktopOnly: false,
\t\t\tcls: EasySyncPlugin as unknown as ModuleDescriptor["cls"],
\t\t},
\t\t{
\t\t\t// MOBILE_BUILD=vt：虚拟文档树单独保留为移动端可用模块。
\t\t\tid: "virtual-tree",
\t\t\tname: "Virtual Tree",
\t\t\tsummary: "虚拟文档树：库内/库外挂载、嵌套挂载、新建笔记、图片/视频查看与打开方式菜单。",
\t\t\tdesktopOnly: false,
\t\t\tcls: VirtualTreePlugin as unknown as ModuleDescriptor["cls"],
\t\t},`;
  return src.slice(0, start) + kept + src.slice(end);
}

export function mobileVtPlugin() {
  return {
    name: 'mobile-vt-only-easysync-tree',
    setup(build) {
      build.onResolve({ filter: /modules\/|codeFileView|dataviewBridge|windowFrame|remoteBootstrap|atLinkSuggest|libraryInitPatch/ }, (args) => {
        if (shouldStub(args.path)) return { path: STUB };
        return undefined;
      });
      build.onLoad({ filter: /main\.ts$/ }, async (args) => {
        if (path.resolve(args.path) !== HOST_MAIN) return undefined;
        const original = await readFile(args.path, 'utf8');
        return { contents: cropDescriptors(original), loader: 'ts' };
      });
    },
  };
}
