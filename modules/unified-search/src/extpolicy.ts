/**
 * ext 域（库外挂载文件）收录策略。
 *
 * 背景（2026-10-23 事故）：挂载清单原样灌库，把整个代码仓收了进来——
 * py 21483 / pyc 16072 / pyi 6711 / ts 2611 … 共 4 万多个文件，Obsidian 启动后
 * 以 79MB/s 读 + 38MB/s 写、CPU 跑满地灌库，索引库 1.7GB → 4.1GB，UI 滚不动。
 *
 * 治理（参考 VS Code 的后台索引）：
 *  - 白名单：只收文本类，二进制与生成物（pyc/so/dll/zip/媒体）一律不收；
 *  - 目录排除：依赖/构建产物/版本控制目录整段跳过（不进清单，连 stat 都省）；
 *  - 数量与体积上限：最近修改的 N 个文件优先（VS Code 的 maxResults 同思路），
 *    单文件过大直接跳过——挂载里常有几十 MB 的日志/数据文件；
 *  - 调度：调用方按「空闲才做」的节奏推进（见 main.ts 的 nextIdle）。
 */

export interface ExtEntry {
  abs: string;
  name: string;
  mtime: number;
}

/** 收录白名单（小写无点扩展名）：文本/源码/配置，二进制一律不进 */
const TEXT_EXT = new Set([
  // 笔记与文档
  "md", "org", "txt", "rst", "adoc", "tex",
  // 数据/配置
  "csv", "tsv", "json", "yaml", "yml", "ini", "toml", "xml", "env", "properties", "conf", "cfg",
  // 源码（含 web）
  "c", "h", "cpp", "hpp", "cc", "cs", "java", "kt", "go", "rs", "rb", "php", "py", "pl", "lua",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "vue", "svelte", "css", "scss", "less", "html", "htm",
  "sh", "bash", "zsh", "ps1", "bat", "sql", "gradle", "cmake", "mk",
  // 其它文本
  "log", "diff", "patch", "gitignore", "dockerfile", "license",
]);

/** 目录段黑名单：命中的整条路径跳过（依赖与构建产物是磁盘风暴主力） */
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".obsidian", ".cache", ".yarn", ".pnpm-store",
  "__pycache__", ".venv", "venv", "site-packages", ".mypy_cache", ".pytest_cache",
  "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".svelte-kit",
  ".gradle", ".idea", ".vscode", ".vscode-test", "bin", "obj",
]);

/** 单轮收录上限（清单可能几万条；只取最近修改的一批） */
export const EXT_MAX_FILES = 5000;
/** 单文件体积上限（超过跳过：挂载里常有几十 MB 的日志/数据集） */
export const EXT_MAX_BYTES = 2_000_000;

/** 路径 → 小写无点扩展名（无扩展名返回空串） */
export function extOfPath(abs: string): string {
  const base = abs.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 单条是否可收录（扩展名白名单 + 目录段黑名单） */
export function isExtIndexable(abs: string): boolean {
  if (!TEXT_EXT.has(extOfPath(abs))) return false;
  const norm = abs.replace(/\\/g, "/").toLowerCase();
  for (const seg of norm.split("/")) {
    if (EXCLUDE_DIRS.has(seg)) return false;
  }
  return true;
}

/**
 * 清单 → 实际收录清单：过滤 → 最近修改优先 → 截断到上限。
 * 返回项保持 `{abs, name, mtime}`，调用方再按 mtime 走 stat 门。
 */
export function selectExternalFiles(list: ExtEntry[]): ExtEntry[] {
  const kept = list.filter((e) => e.abs && isExtIndexable(e.abs));
  // mtime 倒序：上限截断时保留最近改动的（比按目录顺序截断有用得多）
  kept.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return kept.length > EXT_MAX_FILES ? kept.slice(0, EXT_MAX_FILES) : kept;
}
