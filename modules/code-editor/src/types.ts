/**
 * code-editor 模块的共享类型（2026-10-27 模块拆分，Step B）。
 *
 * 分层：code-editor 与 doc-tree 同为底层（零跨模块静态依赖），logseq 与宿主
 * 依赖两者。这里放 LSP 服务规格与 host 的结构化面——不 import logseq 的
 * main/types（模块独立启停的前提：禁用 code-editor 时 monaco 与 LSP 子进程
 * 全部不加载），调用方传完整插件实例时按结构兼容。
 */
import type { App } from 'obsidian';

/** LSP 服务器规格（设置面；编辑 UI 在 logseq settings/lspServerModal）。 */
export interface LspServerSpec {
  /** 唯一 id；内置 pyright 固定 'pyright'，用户添加的自取 */
  id: string;
  /** 匹配的 languageId（即文件扩展名小写），如 ['python']、['ts','tsx'] */
  languages: string[];
  /** node = 用系统 node.exe 跑 JS 脚本（复用终端的 node 发现）；direct = 直接 spawn 可执行文件 */
  launch: 'node' | 'direct';
  /** node 模式：脚本路径（相对插件目录或绝对）；direct 模式：可执行文件名/路径 */
  command: string;
  /** 追加参数（如 ['--stdio']） */
  args: string[];
  enabled: boolean;
  /** generic 服务器按 section 回复的静态 workspace/configuration（pyright 内置语义不需要） */
  config?: { section: string; value: unknown }[];
  /** 内置预设（不可删除，仅可禁用） */
  builtin?: boolean;
}

/**
 * LSP 宿主对调用方的结构化视图：lspHost/monacoLspBridge 只读
 * app.vault.adapter、manifest.dir 与 lsp 设置段。logseq 的插件实例结构兼容
 * （Plugin 带 manifest/app，BlockEditorSettings 含这两字段），直接传 this。
 */
export interface LspHostLike {
  app: App;
  manifest: { dir?: string };
  settings: { lspEnabled: boolean; lspServers: LspServerSpec[] };
}

/** codeBlockRun 只消费块的身份（WeakMap key）与 text；完整块模型归块编辑器域。 */
export interface RunBlockLike {
  text: string;
}
