/**
 * MOBILE_BUILD 精简包裁剪：只保留指定模块，其余模块与宿主 helper 走空 stub。
 *
 * - MOBILE_BUILD=vt  ：宿主壳 + EasySync + 虚拟文档树
 * - MOBILE_BUILD=core：在 vt 基础上再加 MD Editor（块编辑器）+ Code Editor（Monaco）
 *
 * 与 mobile-full-node-plugin 配合：本插件负责模块裁剪与 descriptors 改写，
 * Node/Electron 内建由那边解析到 src/mobile-node-stub.ts。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const STUB = path.resolve('src/mobile-stub.ts');
const HOST_MAIN = path.resolve('src/main.ts');
const MONACO_STATIC = path.resolve('src/mobile-monaco-static.ts');

const KEEP_EASY = [/modules\/easy-sync\//];
const KEEP_VT = [...KEEP_EASY, /modules\/virtual-tree\//];
// breadcrumb：md editor 笔记顶部的面包屑栏（.bcn-bar）。移动端此前被 stub 掉，
// 而自带 .block-editor-breadcrumb 又被 CSS 隐藏 → 顶部整条空白（2026-11-25 实报）。
const KEEP_CORE = [...KEEP_VT, /modules\/md-editor\//, /modules\/code-editor\//, /modules\/breadcrumb\//];
// 2026-11-25 用户组合包：EasySync + 虚拟文档树（含 GitHub/Gitee 挂载）+
// MD Editor / Code Editor（挂载文件与库内代码的编辑路由）+ Save Control
// （移动端快照存库内插件目录）。
const KEEP_GIT_SAVE = [...KEEP_CORE, /modules\/save-control\//];

// 注意：extensionRegistry 必须保留真实实现——virtual-tree 直接 import 它的
// registerFreeExtensions/takeOverExtensions；stub 掉会让虚拟树加载失败。
const HOST_HELPERS = [
  'dataviewBridge', 'windowFrame',
  'remoteBootstrap', 'atLinkSuggest', 'libraryInitPatch',
];

function shouldStub(spec, keep, helpers) {
  const s = spec.split(path.sep).join('/');
  if (keep.some((re) => re.test(s))) return false;
  if (/\/modules\//.test(s)) return true;
  if (helpers.some((h) => s === `./${h}` || s.endsWith(`/${h}`) || s.endsWith(`/${h}.ts`))) return true;
  return false;
}

const ENTRY = {
  easy: `\t\t{
\t\t\tid: "easy-sync",
\t\t\tname: "EasySync",
\t\t\tmanifest: { version: "1.7.1" },
\t\t\tmigrateFrom: "easy-sync",
\t\t\tsummary: "双向 OneDrive 同步：冲突保护、移动端支持、可选的设置/插件同步。",
\t\t\tdesktopOnly: false,
\t\t\tcls: EasySyncPlugin as unknown as ModuleDescriptor["cls"],
\t\t},`,
  tree: `\t\t{
\t\t\t// MOBILE_BUILD：虚拟文档树保留为移动端模块。
\t\t\tid: "virtual-tree",
\t\t\tname: "Virtual Tree",
\t\t\tsummary: "虚拟文档树：库内/库外挂载、嵌套挂载、新建笔记、图片/视频查看与打开方式菜单。",
\t\t\tdesktopOnly: false,
\t\t\tcls: VirtualTreePlugin as unknown as ModuleDescriptor["cls"],
\t\t},`,
  md: `\t\t{
\t\t\t// MOBILE_BUILD=core：块编辑器 / 外部文件视图。
\t\t\tid: "md-editor",
\t\t\tname: "MD Editor",
\t\t\tsummary: "块文档 Markdown 编辑器、代码文件视图与虚拟文档树的编辑路由。",
\t\t\tdesktopOnly: false,
\t\t\tcls: LogseqEditorPlugin as unknown as ModuleDescriptor["cls"],
\t\t},`,
  code: `\t\t{
\t\t\t// MOBILE_BUILD=core：Monaco 编辑器基建。
\t\t\tid: "code-editor",
\t\t\tname: "Code Editor",
\t\t\tsummary: "Monaco 代码编辑器基建：代码块/代码文件的语法高亮与编辑。",
\t\t\tdesktopOnly: false,
\t\t\tcls: CodeEditorPlugin as unknown as ModuleDescriptor["cls"],
\t\t},`,
  crumb: `\t\t{
\t\t\t// MOBILE_BUILD=core/git-save：笔记顶部面包屑栏（.bcn-bar），
\t\t\t// 填掉 md editor 顶部空白（自带 block-editor-breadcrumb 被 CSS 隐藏）。
\t\t\tid: "breadcrumb",
\t\t\tname: "Breadcrumb Nav",
\t\t\tsummary: "笔记顶部的面包屑（文件 › 标题 / 块层级）。",
\t\t\tdesktopOnly: false,
\t\t\tcls: BreadcrumbNavPlugin as unknown as ModuleDescriptor["cls"],
\t\t},`,
  save: `\t\t{
\t\t\t// MOBILE_BUILD=git-save：保存控制 + 版本历史（移动端快照存库内插件目录）。
\t\t\tid: "save-control",
\t\t\tname: "Save Control",
\t\t\tsummary: "自动保存节奏控制 + 文件版本历史；移动端快照存库内插件目录。",
\t\t\tdesktopOnly: false,
\t\t\tcls: SaveControlPlugin as unknown as ModuleDescriptor["cls"],
\t\t},`,
};

/** 用源码里的 descriptors 起点/终点标记做整段替换。 */
function cropDescriptors(src, modules) {
  const startMark = '\treadonly descriptors: ModuleDescriptor[] = [';
  const start = src.indexOf(startMark);
  if (start < 0) throw new Error('[mobile] descriptors 起点未找到');
  const end = src.indexOf('\n\t];', start);
  if (end < 0) throw new Error('[mobile] descriptors 终点未找到');
  const kept = `\treadonly descriptors: ModuleDescriptor[] = [\n${modules.join('\n')}`;
  return src.slice(0, start) + kept + src.slice(end);
}

function makePlugin(keep, modules, name, helpers, staticMonaco = false) {
  return () => ({
    name,
    setup(build) {
      build.onResolve({ filter: /modules\/|lazyMonaco|codeFileView|dataviewBridge|windowFrame|remoteBootstrap|atLinkSuggest|libraryInitPatch/ }, (args) => {
        // core：Monaco 懒包改用静态模块（移动端没有 require 懒加载能力）
        if (staticMonaco && /(^|\/)lazyMonaco(\.ts)?$/.test(args.path.split(path.sep).join('/'))) {
          return { path: MONACO_STATIC };
        }
        if (shouldStub(args.path, keep, helpers)) return { path: STUB };
        return undefined;
      });
      build.onLoad({ filter: /main\.ts$/ }, async (args) => {
        if (path.resolve(args.path) !== HOST_MAIN) return undefined;
        const original = await readFile(args.path, 'utf8');
        return { contents: cropDescriptors(original, modules), loader: 'ts' };
      });
    },
  });
}

export const mobileEasyPlugin = makePlugin(
  KEEP_EASY,
  [ENTRY.easy],
  'mobile-easy-sync-only',
  [...HOST_HELPERS, 'codeFileView'],
);

export const mobileVtPlugin = makePlugin(
  KEEP_VT,
  [ENTRY.easy, ENTRY.tree],
  'mobile-vt-only-easysync-tree',
  [...HOST_HELPERS, 'codeFileView'],
);

export const mobileCorePlugin = makePlugin(
  KEEP_CORE,
  [ENTRY.easy, ENTRY.tree, ENTRY.md, ENTRY.code, ENTRY.crumb],
  'mobile-core-easysync-tree-md-code',
  // core 必须保留真实 codeFileView：它注册库内 .py/.ts 等扩展名的 CodeMirror 视图，
  // stub 掉会导致打开代码文件落到 empty 占位视图。
  HOST_HELPERS,
  true,
);

export const mobileGitSavePlugin = makePlugin(
  KEEP_GIT_SAVE,
  [ENTRY.easy, ENTRY.tree, ENTRY.md, ENTRY.code, ENTRY.crumb, ENTRY.save],
  'mobile-git-save-easysync-tree-code-savecontrol',
  // 与 core 同：保留真实 codeFileView（库内代码扩展名视图），Monaco 懒包改静态。
  HOST_HELPERS,
  true,
);
