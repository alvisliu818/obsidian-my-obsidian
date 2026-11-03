import { DataAdapter } from "obsidian";
import { SaveControlPlugin } from "./main";
import {
  DEFAULT_VERSION_ROOT,
  deleteExternalSnapshot,
  fsLike,
  listExternalSnapshots,
  moveDirFs,
  pruneEmptyDirs,
  readExternalSnapshot,
  resolveVersionRoot,
  saveExternalSnapshot,
} from "./externalStore";
import { absPathKey, decodeAbsKey, normalizeKey } from "./targets";

export type SnapshotRecord = {
  timestamp: string; // ISO
  content: string;
  name: string;
  favorite?: boolean;
};

/**
 * 一个路径/目录是不是快照存储的绝对路径形态。
 *
 * 库内流程传 vault 相对路径（由 getSnapshotDirPath 映射进版本存储根），
 * 库外流程直接传快照目录的绝对路径（targets.snapshotKeyFor 拼出）——
 * 据此区分两种入参身份，无需登记表。
 */
export function isExternalSnapshotPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
}

/** 库根（vault.adapter.basePath）。 */
export function getVaultBase(plugin: SaveControlPlugin): string {
  const adapter = plugin.app.vault.adapter as unknown as {
    basePath?: string;
    getBasePath?: () => string;
  };
  return (typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath) ?? "";
}

/** 版本存储根（绝对路径）：所有快照——库内与库外——的统一存放位置。 */
export function getVersionRoot(plugin: SaveControlPlugin): string {
  return resolveVersionRoot({
    configured: plugin.settings.versionStorageFolder,
    vaultBase: getVaultBase(plugin),
  });
}

export function normalizeRecord(raw: Record<string, unknown>): SnapshotRecord {
  return {
    timestamp: String(raw.timestamp ?? ""),
    content: String(raw.content ?? ""),
    name: String(raw.name ?? raw.reason ?? ""),
    favorite: Boolean(raw.favorite),
  };
}

const LEGACY_SNAPSHOT_ROOT = ".versions(SH)";

/**
 * 旧版库内快照根（迁移源 + 预览临时文件的落点）。统一存储后新快照不再进
 * 库，这个目录只剩历史残留，由 migrateLegacySnapshots 搬空。
 */
export function getSnapshotRoot(plugin: SaveControlPlugin): string {
  return plugin.settings.snapshotFolder || LEGACY_SNAPSHOT_ROOT;
}

/**
 * 快照目录寻址：入参既可以是 vault 相对路径（库内流程），也可以是根下的
 * 绝对目录（库外流程，原样返回）。库内路径映射为
 * `<版本存储根>/<absPathKey(vaultBase + 路径)>`——按文件绝对路径分文件夹。
 */
export function getSnapshotDirPath(plugin: SaveControlPlugin, p: string): string {
  if (isExternalSnapshotPath(p)) return p;
  const normalized = p.replace(/^\/+/, "");
  return `${getVersionRoot(plugin)}/${absPathKey(`${getVaultBase(plugin)}/${normalized}`)}`;
}

export function getSnapshotFilePath(plugin: SaveControlPlugin, p: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/:/g, "-");
  return `${getSnapshotDirPath(plugin, p)}/${safeTimestamp}.json`;
}

export async function saveSnapshotContent(
  plugin: SaveControlPlugin,
  p: string,
  timestamp: string,
  content: string,
  name: string
) {
  const root = getVersionRoot(plugin);
  const dirPath = getSnapshotDirPath(plugin, p);
  // 统一走 Node fs：目录由 saveExternalSnapshot 内部逐级创建。
  saveExternalSnapshot(root, keyUnderRoot(root, dirPath), timestamp, content, name);
}

/** 绝对快照目录 → 根下的键（去掉根前缀）。 */
export function keyUnderRoot(root: string, dirPath: string): string {
  const normRoot = root.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const normDir = dirPath.replace(/[\\/]+/g, "/");
  if (normDir === normRoot) return "";
  return normDir.startsWith(normRoot + "/") ? normDir.slice(normRoot.length + 1) : normDir;
}

export async function listSnapshotsForFile(
  plugin: SaveControlPlugin,
  p: string
): Promise<(SnapshotRecord & { filePath: string })[]> {
  const root = getVersionRoot(plugin);
  const key = keyUnderRoot(root, getSnapshotDirPath(plugin, p));
  return listExternalSnapshots(root, key).sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
}

export async function readSnapshotContent(
  _plugin: SaveControlPlugin,
  filePath: string
): Promise<SnapshotRecord | null> {
  // 快照文件路径在统一存储后恒为绝对路径（fs 文件）。参数仅为调用方签名一致。
  return readExternalSnapshot(filePath);
}

export async function deleteSnapshotFile(
  plugin: SaveControlPlugin,
  filePath: string
): Promise<boolean> {
  return deleteExternalSnapshot(getVersionRoot(plugin), filePath);
}

/**
 * 按快照名滚转：只动这个名字的快照，超出 keepCount 的最旧一批被删。
 *
 * `protectFavorites` 默认 true —— 收藏是用户显式的「别删」信号，滚转不该
 * 越过它；autosave 的滚转沿用上游旧行为（不保护），故显式传 false。
 * 列表已是按时间戳降序，所以直接切尾。
 */
export async function deleteOldestSnapshotsByName(
  plugin: SaveControlPlugin,
  vaultRelativePath: string,
  keepCount: number,
  name: string,
  protectFavorites = true
): Promise<void> {
  const snapshots = await listSnapshotsForFile(plugin, vaultRelativePath);
  const pool = snapshots.filter(s => s.name === name && (!protectFavorites || !s.favorite));

  if (pool.length <= keepCount) return;

  const toDelete = pool.slice(keepCount);
  for (const s of toDelete) {
    await deleteSnapshotFile(plugin, s.filePath);
  }
}

export async function deleteOldestAutosaves(
  plugin: SaveControlPlugin,
  vaultRelativePath: string,
  keepCount: number
): Promise<void> {
  await deleteOldestSnapshotsByName(plugin, vaultRelativePath, keepCount, "autosave", false);
}

export async function updateSnapshotLabel(
  _plugin: SaveControlPlugin,
  filePath: string,
  newLabel: string
): Promise<boolean> {
  // 快照文件在统一存储后恒为绝对路径，fs 直改。
  try {
    const fs = fsLike();
    if (!fs.existsSync(filePath)) return false;
    const record = normalizeRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
    record.name = newLabel;
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function toggleSnapshotFavorite(
  _plugin: SaveControlPlugin,
  filePath: string
): Promise<boolean> {
  try {
    const fs = fsLike();
    if (!fs.existsSync(filePath)) return false;
    const record = normalizeRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
    record.favorite = !record.favorite;
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    return record.favorite;
  } catch {
    return false;
  }
}

export async function savePreRestoreBackup(
  plugin: SaveControlPlugin,
  p: string,
  content: string
) {
  const root = getVersionRoot(plugin);
  const key = keyUnderRoot(root, getSnapshotDirPath(plugin, p));

  // If a pre-restore backup already exists, don't overwrite it —
  // preserve the original unsaved content until the user explicitly restores it.
  const existing = listExternalSnapshots(root, key);
  if (existing.some((s) => s.name === "pre-restore")) return;

  const timestamp = new Date().toISOString();
  await saveSnapshotContent(plugin, p, timestamp, content, "pre-restore");
}

async function resolvePath(adapter: DataAdapter, path: string): Promise<string | null> {
  const parts = path.replace(/\\/g, "/").split("/").filter(p => p);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      return null;
    }
  }
  return current || null;
}

export async function renameSnapshotFolder(adapter: DataAdapter, oldName: string, newName: string): Promise<boolean> {
  if (oldName === newName) return true;

  const resolvedOld = await resolvePath(adapter, oldName);
  if (!resolvedOld) return true;

  const parentDir = newName.substring(0, newName.lastIndexOf("/"));
  if (parentDir) {
    const parts = parentDir.replace(/\\/g, "/").split("/").filter(p => p);
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!(await adapter.exists(currentPath))) {
        try {
          await adapter.mkdir(currentPath);
        } catch {
          // ignore
        }
      }
    }
  }

  try {
    await adapter.rename(resolvedOld, newName);

    if (resolvedOld !== newName && await adapter.exists(resolvedOld)) {
      try {
        await adapter.remove(resolvedOld);
      } catch {
        // ignore — best effort cleanup
      }
    }

    const oldParent = resolvedOld.substring(0, resolvedOld.lastIndexOf("/"));
    if (oldParent) {
      let dir = oldParent;
      while (dir) {
        if (!(await adapter.exists(dir))) break;
        let listResult: { files: string[]; folders: string[] } | undefined;
        try {
          listResult = await adapter.list(dir);
        } catch {
          break;
        }
        const files = listResult.files || [];
        const folders = listResult.folders || [];
        if (files.length > 0 || folders.length > 0) break;
        const parent = dir.split("/").slice(0, -1).join("/");
        try {
          await adapter.rmdir(dir, false);
        } catch {
          break;
        }
        if (parent === dir) break;
        dir = parent;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export async function deleteSnapshotDirForFile(
  plugin: SaveControlPlugin,
  p: string
): Promise<void> {
  // 库外文件没有 vault delete 事件；其快照清理走 EVENT_EXTERNAL_DELETED。
  if (isExternalSnapshotPath(p)) return;
  const root = getVersionRoot(plugin);
  const dirPath = getSnapshotDirPath(plugin, p);
  try {
    const fs = fsLike();
    if (fs.existsSync(dirPath)) fs.rmSync?.(dirPath, { recursive: true, force: true });
    pruneEmptyDirs(root, dirPath.split("/").slice(0, -1).join("/"));
  } catch (e) {
    console.error("[save-control] snapshot dir cleanup failed", dirPath, e);
  }
}

export function getExportFolderPath(plugin: SaveControlPlugin): string {
  return plugin.settings.exportFolder || "Exported versions";
}

export async function ensureExportDir(plugin: SaveControlPlugin): Promise<void> {
  const dirPath = getExportFolderPath(plugin);
  const adapter = plugin.app.vault.adapter;

  const parts = dirPath.split("/");
  let currentPath = "";
  for (const part of parts) {
    if (!part) continue;
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (!(await adapter.exists(currentPath))) {
      try {
        await adapter.mkdir(currentPath);
      } catch {
        // concurrent creation
      }
    }
  }
}

export async function exportSnapshotToVault(
  plugin: SaveControlPlugin,
  fileName: string,
  content: string
): Promise<void> {
  const dirPath = getExportFolderPath(plugin);
  const filePath = `${dirPath}/${fileName}`;
  const adapter = plugin.app.vault.adapter;

  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash > 0) {
    const parentDir = filePath.substring(0, lastSlash);
    const parts = parentDir.split("/");
    let currentPath = "";
    for (const part of parts) {
      if (!part) continue;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!(await adapter.exists(currentPath))) {
        try {
          await adapter.mkdir(currentPath);
        } catch {
          // concurrent creation
        }
      }
    }
  }

  await adapter.write(filePath, content);
}

export async function renameExportFolder(adapter: DataAdapter, oldName: string, newName: string): Promise<boolean> {
  if (oldName === newName) return true;

  const resolvedOld = await resolvePath(adapter, oldName);
  if (!resolvedOld) return true;

  const parentDir = newName.substring(0, newName.lastIndexOf("/"));
  if (parentDir) {
    const parts = parentDir.replace(/\\/g, "/").split("/").filter(p => p);
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!(await adapter.exists(currentPath))) {
        try {
          await adapter.mkdir(currentPath);
        } catch {
          // ignore
        }
      }
    }
  }

  try {
    await adapter.rename(resolvedOld, newName);

    if (resolvedOld !== newName && await adapter.exists(resolvedOld)) {
      try {
        await adapter.remove(resolvedOld);
      } catch {
        // ignore — best effort cleanup
      }
    }

    const oldParent = resolvedOld.substring(0, resolvedOld.lastIndexOf("/"));
    if (oldParent) {
      let dir = oldParent;
      while (dir) {
        if (!(await adapter.exists(dir))) break;
        let listResult: { files: string[]; folders: string[] } | undefined;
        try {
          listResult = await adapter.list(dir);
        } catch {
          break;
        }
        const files = listResult.files || [];
        const folders = listResult.folders || [];
        if (files.length > 0 || folders.length > 0) break;
        const parent = dir.split("/").slice(0, -1).join("/");
        try {
          await adapter.rmdir(dir, false);
        } catch {
          break;
        }
        if (parent === dir) break;
        dir = parent;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export async function renameTempVersionFolder(adapter: DataAdapter, oldName: string, newName: string): Promise<boolean> {
  if (oldName === newName) return true;

  const resolvedOld = await resolvePath(adapter, oldName);
  if (!resolvedOld) return true;

  const parentDir = newName.substring(0, newName.lastIndexOf("/"));
  if (parentDir) {
    const parts = parentDir.replace(/\\/g, "/").split("/").filter(p => p);
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!(await adapter.exists(currentPath))) {
        try {
          await adapter.mkdir(currentPath);
        } catch {
          // ignore
        }
      }
    }
  }

  try {
    await adapter.rename(resolvedOld, newName);

    if (resolvedOld !== newName && await adapter.exists(resolvedOld)) {
      try {
        await adapter.remove(resolvedOld);
      } catch {
        // ignore — best effort cleanup
      }
    }

    const oldParent = resolvedOld.substring(0, resolvedOld.lastIndexOf("/"));
    if (oldParent) {
      let dir = oldParent;
      while (dir) {
        if (!(await adapter.exists(dir))) break;
        let listResult: { files: string[]; folders: string[] } | undefined;
        try {
          listResult = await adapter.list(dir);
        } catch {
          break;
        }
        const files = listResult.files || [];
        const folders = listResult.folders || [];
        if (files.length > 0 || folders.length > 0) break;
        const parent = dir.split("/").slice(0, -1).join("/");
        try {
          await adapter.rmdir(dir, false);
        } catch {
          break;
        }
        if (parent === dir) break;
        dir = parent;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createSearchRegex(query: string): RegExp {
  if (!query) return /(?!)/gi;

  if (query.includes("*") || query.includes("?") || query.includes("\\")) {
    let pattern = "";
    for (let i = 0; i < query.length; i++) {
      const c = query[i];
      if (c === "\\" && i + 1 < query.length) {
        const next = query[i + 1];
        if (next === "?") { pattern += "\\?"; i++; }
        else if (next === "*") { pattern += "\\*"; i++; }
        else if (next === "\\") { pattern += "\\\\"; i++; }
        else { pattern += "\\\\"; }
      } else if (c === "?") {
        pattern += ".";
      } else if (c === "*") {
        pattern += ".*";
      } else {
        pattern += /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
      }
    }
    return new RegExp(pattern, "gi");
  }

  try {
    return new RegExp(query, "gi");
  } catch {
    return new RegExp(escapeRegex(query), "gi");
  }
}

function getMatchRanges(content: string, query: string): { start: number; end: number }[] {
  if (!query || !content) return [];

  const regex = createSearchRegex(query);

  const ranges: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }

  return ranges;
}

function generateSnippet(content: string, query: string): string {
  const ranges = getMatchRanges(content, query);
  if (ranges.length === 0) return content.slice(0, 200);

  const first = ranges[0];
  const snippetLen = 200;
  const halfSnippet = Math.floor(snippetLen / 2);
  let start = Math.max(0, first.start - halfSnippet);
  let end = Math.min(content.length, first.end + halfSnippet);

  let snippet = content.slice(start, end);
  if (start > 0) snippet = "\u2026" + snippet;
  if (end < content.length) snippet = snippet + "\u2026";

  return snippet;
}

/**
 * 快照文件 → 原文件的身份与显示路径。
 *
 * 统一存储后快照都在版本存储根下，目录树就是原文件绝对路径的镜像；反解：
 *   - 补回盘符冒号得到原绝对路径；
 *   - 在库根之下（Windows 大小写不敏感）→ 身份 = vault 相对路径（与
 *     perFileSettings 的键、getActiveFile().path 一致），显示也用相对路径；
 *   - 库外 → 身份 = normalizeKey(abs)，显示用原绝对路径。
 */
export function snapshotFileIdentity(
  plugin: SaveControlPlugin,
  filePath: string
): { identity: string; display: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const root = getVersionRoot(plugin).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const prefix = root + "/";
  if (!normalized.startsWith(prefix)) return { identity: "", display: "" };
  const afterRoot = normalized.slice(prefix.length);
  const lastSlash = afterRoot.lastIndexOf("/");
  if (lastSlash < 0) return { identity: "", display: "" };
  const abs = decodeAbsKey(afterRoot.slice(0, lastSlash));
  const vaultBase = getVaultBase(plugin).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const absNorm = abs.toLowerCase();
  const baseNorm = vaultBase.toLowerCase();
  if (vaultBase && (absNorm === baseNorm || absNorm.startsWith(baseNorm + "/"))) {
    const rel = abs.slice(vaultBase.length).replace(/^\/+/, "");
    return { identity: rel, display: rel };
  }
  return { identity: normalizeKey(abs), display: abs };
}

export type SearchMatch = SnapshotRecord & {
  filePath: string;
  path: string;
  snippet: string;
  isCurrentFile: boolean;
};

export async function searchSnapshots(
  plugin: SaveControlPlugin,
  query: string
): Promise<SearchMatch[]> {
  if (!query.trim()) return [];

  const root = getVersionRoot(plugin).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const results: SearchMatch[] = [];
  const queryTrimmed = query.trim();
  // 当前文件的身份：库内 = vault 路径，库外 = normalizeKey(abs)。
  const activeTarget = plugin.getActiveTarget();
  const currentIdentity = activeTarget
    ? activeTarget.kind === "vault"
      ? activeTarget.key
      : normalizeKey(activeTarget.abs ?? activeTarget.key)
    : "";

  const fs = fsLike();
  if (fs.existsSync(root)) {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const full = `${dir}/${n}`;
        let isDir = false;
        try {
          isDir = fs.statSync ? fs.statSync(full).isDirectory() : !n.endsWith(".json");
        } catch {
          continue;
        }
        if (isDir) {
          stack.push(full);
          continue;
        }
        if (!n.endsWith(".json")) continue;
        try {
          const record = normalizeRecord(JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>);
          const { identity, display } = snapshotFileIdentity(plugin, full);
          const isCurrentFile = identity !== "" && identity === currentIdentity;

          const ranges = getMatchRanges(record.content, queryTrimmed);
          if (ranges.length > 0) {
            const snippet = generateSnippet(record.content, queryTrimmed);
            results.push({ ...record, filePath: full, path: display, snippet, isCurrentFile });
            continue;
          }
          if (getMatchRanges(display, queryTrimmed).length > 0) {
            results.push({ ...record, filePath: full, path: display, snippet: display, isCurrentFile });
            continue;
          }
          const localTimeStr = new Date(record.timestamp).toLocaleString();
          if (getMatchRanges(localTimeStr, queryTrimmed).length > 0) {
            results.push({ ...record, filePath: full, path: display, snippet: localTimeStr, isCurrentFile });
          }
        } catch {
          // skip invalid files
        }
      }
    }
  }

  results.sort((a, b) => {
    if (a.isCurrentFile !== b.isCurrentFile) {
      return a.isCurrentFile ? -1 : 1;
    }
    if (!!a.favorite !== !!b.favorite) {
      return a.favorite ? -1 : 1;
    }
    return a.timestamp > b.timestamp ? -1 : 1;
  });

  return results;
}

/**
 * 旧版库内快照（<vault>/<snapshotFolder>/<vault 路径>/）一次性搬进统一版本
 * 存储根（<root>/<absPathKey(vaultBase + vault 路径)>/）。
 *
 * - 可重入：目标目录已存在时按文件合并（不覆盖同名快照），源搬空才删；
 * - rename 优先（同盘瞬间），跨盘回退逐文件复制；
 * - snapshotFolder 下的 .tmp（预览临时文件）与空壳目录不动；
 * - 与新根互嵌时跳过（用户把根设进旧目录里的极端配置，搬了只会套娃）。
 */
export async function migrateLegacySnapshots(plugin: SaveControlPlugin): Promise<void> {
  const vaultBase = getVaultBase(plugin);
  if (!vaultBase) return;
  const legacyRel = getSnapshotRoot(plugin);
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const legacyAbs = norm(`${vaultBase}/${legacyRel}`);
  const root = norm(getVersionRoot(plugin));
  if (legacyAbs === root || root.startsWith(legacyAbs + "/") || legacyAbs.startsWith(root + "/")) return;

  const fs = fsLike();
  if (!fs.existsSync(legacyAbs)) return;

  // 收集含 .json 的目录（= 每个有版本的文件）。
  const fileDirs: string[] = [];
  const stack: string[] = [legacyAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    let hasJson = false;
    for (const n of names) {
      const full = `${dir}/${n}`;
      let isDir = false;
      try {
        isDir = fs.statSync ? fs.statSync(full).isDirectory() : !n.endsWith(".json");
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else if (n.endsWith(".json")) hasJson = true;
    }
    if (hasJson) fileDirs.push(dir);
  }

  let moved = 0;
  let failed = 0;
  for (const dir of fileDirs) {
    const rel = dir.slice(legacyAbs.length + 1);
    const targetDir = `${root}/${absPathKey(`${vaultBase}/${rel}`)}`;
    if (moveDirFs(dir, targetDir)) moved++;
    else failed++;
  }

  // 自底向上清掉搬空的目录；旧根本身搬空（没有 .tmp 之类的残留）也一并清掉。
  for (const dir of fileDirs) {
    let cur = dir.split("/").slice(0, -1).join("/");
    while (cur && cur !== legacyAbs && cur.startsWith(legacyAbs + "/")) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(cur);
      } catch {
        break;
      }
      if (names.length > 0) break;
      try {
        fs.rmSync?.(cur, { recursive: true, force: true });
      } catch {
        break;
      }
      cur = cur.split("/").slice(0, -1).join("/");
    }
  }
  try {
    if (fs.readdirSync(legacyAbs).length === 0) {
      fs.rmSync?.(legacyAbs, { recursive: true, force: true });
    }
  } catch {
    // 旧根删不掉就留着（空壳无害）
  }

  if (moved > 0 || failed > 0) {
    const where = root === DEFAULT_VERSION_ROOT ? "默认根" : root;
    if (failed > 0) {
      console.warn(`[save-control] 旧快照迁移不完整：成功 ${moved}，失败 ${failed}（留在 ${legacyAbs}，下次启动重试）`);
    } else {
      console.log(`[save-control] 已把 ${moved} 个文件的旧快照迁到 ${where}`);
    }
  }
}
export async function writeTempVersionFile(
  plugin: SaveControlPlugin,
  sourceFilePath: string,
  timestamp: string,
  content: string
): Promise<string> {
  const root = getSnapshotRoot(plugin);
  const tmpDir = `${root}/.tmp`;
  const adapter = plugin.app.vault.adapter;

  if (!(await adapter.exists(tmpDir))) {
    await adapter.mkdir(tmpDir);
  }

  const sourceName = sourceFilePath.split("/").pop() || "unknown";
  const baseName = sourceName.replace(/\.[^.]+$/, "");
  const ext = sourceName.includes(".") ? sourceName.split(".").pop()! : "md";
  const safeTs = timestamp.replace(/:/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const fileName = `${baseName}_${safeTs}_${random}.${ext}`;
  const filePath = `${tmpDir}/${fileName}`;

  await adapter.write(filePath, content);
  return filePath;
}

export async function deleteTempVersionFile(
  plugin: SaveControlPlugin,
  tempFilePath: string
): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  try {
    if (await adapter.exists(tempFilePath)) {
      await adapter.remove(tempFilePath);
    }
  } catch {
    // ignore
  }
}


