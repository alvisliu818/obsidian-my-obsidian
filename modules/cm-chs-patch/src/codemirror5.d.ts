/**
 * CM5（CodeMirror 5）兼容类型的最小本地面（聚合仓适配）。
 *
 * 上游从 "codemirror" 导入 @types/codemirror@5 的类型——Obsidian 的 vim
 * 适配器是 CM5 API 面。宿主根装的是 codemirror@6（PnP 解析优先，物理
 * node_modules 的就近兜底在 PnP 下不生效），CM5 的 Editor/Position/静态
 * 方法类型不存在，因此按 vim-utils/vim-types 实际用到的成员内联在此，
 * 三个 import 点改指本模块。运行时零导入：CodeMirror 对象是 Obsidian
 * 提供的全局（CM5 兼容适配器）。
 */
declare module "chsp-codemirror5" {
  export interface Position {
    line: number
    ch: number
  }

  export interface Editor {
    firstLine(): number
    lastLine(): number
    getLine(n: number): string
    getCursor(start?: string | number): Position
  }

  export interface CodeMirrorStatic {
    // CM5 的 Pos 兼具构造器与工厂两种用法（vim-utils 里是 `new Pos(...)`）
    Pos: {
      new (line: number, ch?: number): Position
      (line: number, ch?: number): Position
    }
    isWordChar(ch: string): boolean
  }

  // 值声明（仅类型用——运行时 CodeMirror 是 Obsidian 的全局对象，这里
  // 不产生任何导入），供 `typeof import("chsp-codemirror5")` 取到静态面。
  export const Pos: CodeMirrorStatic["Pos"]
  export const isWordChar: CodeMirrorStatic["isWordChar"]
}
