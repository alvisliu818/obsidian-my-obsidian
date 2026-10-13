/**
 * 库外文件的搜索桥（合并新增；上游 omnisearch 只索引库内文件）。
 *
 * 库外文件没有 vault 路径，用 `ext:<绝对路径>` 作为索引里的伪路径：
 *   - 以 `ext:` 开头的路径永远不会与 vault 路径撞车（vault 路径不含冒号段）；
 *   - 扩展名/basename 的常规推导（split('.') / split('/')）对它依然成立，
 *     上游按扩展名分流索引的代码不用改；
 *   - 打开结果时在 openNote 里拦截，交给 logseq 模块的 openExternalEntry
 *     （软依赖：logseq 模块不在时回退系统默认应用）。
 */

export const EXTERNAL_DOC_PREFIX = 'ext:'

export function isExternalDocPath(path: string): boolean {
  return path.startsWith(EXTERNAL_DOC_PREFIX)
}

export function toExternalDocPath(abs: string): string {
  return EXTERNAL_DOC_PREFIX + abs.replace(/\\/g, '/')
}

export function absFromExternalDocPath(path: string): string {
  return path.slice(EXTERNAL_DOC_PREFIX.length)
}
