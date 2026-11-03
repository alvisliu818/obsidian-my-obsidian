/** 文件名 → 扩展名（不带点、小写）。没有扩展名返回空串。 */
export function extOfName(name: string): string {
  if (!name) return "";
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  // 前置点（.gitignore）不算扩展名
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}
