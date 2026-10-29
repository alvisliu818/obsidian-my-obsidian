/**
 * code-editor 模块入口（2026-10-27 Step B 自 logseq 拆出）。
 *
 * 本模块 = Monaco 编辑器基建 + LSP 宿主 + 代码执行器 + 扩展贡献桥
 * （语法 / 颜色主题 / 片段）。分层上与 doc-tree 同为底层：零跨模块静态
 * 依赖，logseq 与宿主依赖本模块——禁用本模块时 monaco 运行时与 LSP 子
 * 进程全部不加载/被释放，这正是拆分动机（LSP 子进程是常驻内存大头）。
 *
 * Monaco 与 LSP 都按需惰性初始化（首次 createEditor / openLspDocument 才
 * 落真资源），所以 onload 无事可做；本入口只承担模块生命周期：被宿主
 * descriptor 装配启停，onunload 释放 monaco 运行时与全部 LSP 子进程。
 *
 * 视图（ExternalCodeView / hybridCodeEditor / CodeDocView）留在 logseq——
 * 它们与块编辑器的 parser / FragmentHost 交织（混合模式），经静态 import
 * 使用本模块（方向合法：上层 → 底层）。
 */
import { Plugin } from 'obsidian';
import { disposeMonaco } from './editor/monaco';
import { shutdownAllLsp } from './lsp/lspHost';

/** The id this instance is re-published under in the app's plugin table. */
export const CODE_EDITOR_ALIAS_ID = 'obsidian-code-editor';

export default class CodeEditorPlugin extends Plugin {
  async onload(): Promise<void> {
    // 惰性：monaco 的 worker/主题在首次 createEditor 时初始化（monaco.ts
    // 的 setupMonaco），LSP 子进程在首次 openLspDocument 时 spawn（lspHost）。
  }

  async onunload(): Promise<void> {
    disposeMonaco();
    void shutdownAllLsp();
  }
}
