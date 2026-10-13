import { DataAdapter } from "obsidian";
import { SaveControlPlugin } from "./main";
import {
  deleteExternalSnapshot,
  listExternalSnapshots,
  readExternalSnapshot,
  resolveExternalSnapshotRoot,
  saveExternalSnapshot,
} from "./externalStore";

export type SnapshotRecord = {
  timestamp: string; // ISO
  content: string;
  name: string;
  favorite?: boolean;
};

/**
 * 一个路径/目录是不是库外快照存储。
 *
 * 库外目标的「路径」是快照目录的**绝对路径**（targets.snapshotKeyFor 拼出，
 * main.snapshotPathFor 生成），而 vault 相对路径永远不以盘符/根斜杠开头——
 * 据此路由 vault adapter 与 Node fs 两套存储，无需登记表。
 */
export function isExternalSnapshotPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
}

export function getExternalSnapshotRoot(plugin: SaveControlPlugin): string {
  const adapter = plugin.app.vault.adapter as unknown as {
    basePath?: string;
    getBasePath?: () => string;
  };
  const vaultBase =
    (typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath) ?? "";
  return resolveExternalSnapshotRoot({
    configured: plugin.settings.externalSnapshotFolder,
    vaultBase,
    pluginDir: plugin.manifest.dir ?? "",
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

export function getSnapshotRoot(plugin: SaveControlPlugin): string {
  return plugin.settings.snapshotFolder || LEGACY_SNAPSHOT_ROOT;
}

export function getSnapshotDirPath(plugin: SaveControlPlugin, vaultRelativePath: string): string {
  // 库外：传入的已经是完整的绝对目录，原样用。
  if (isExternalSnapshotPath(vaultRelativePath)) return vaultRelativePath;
  const normalized = vaultRelativePath.replace(/^\/+/, "");
  return `${getSnapshotRoot(plugin)}/${normalized}`;
}

export function getSnapshotFilePath(plugin: SaveControlPlugin, vaultRelativePath: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/:/g, "-");
  // 库外与库内同构：getSnapshotDirPath 对库外原样返回绝对目录。
  return `${getSnapshotDirPath(plugin, vaultRelativePath)}/${safeTimestamp}.json`;
}

export async function ensureSnapshotDir(plugin: SaveControlPlugin, vaultRelativePath: string) {
  const dirPath = getSnapshotDirPath(plugin, vaultRelativePath);
  if (isExternalSnapshotPath(dirPath)) {
    // externalStore.saveExternalSnapshot 内部 ensureDir，这里无需动作。
    return;
  }
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
        // Safe fallback in case multiple calls try to create it simultaneously
      }
    }
  }
}

export async function saveSnapshotContent(
  plugin: SaveControlPlugin,
  vaultRelativePath: string,
  timestamp: string,
  content: string,
  name: string
) {
  // 库外：Node fs 直写（externalStore 内部建目录）。
  if (isExternalSnapshotPath(vaultRelativePath)) {
    const root = getExternalSnapshotRoot(plugin);
    saveExternalSnapshot(root, vaultRelativePath.slice(root.length + 1).replace(/^\/+/, ""), timestamp, content, name);
    return;
  }
  await ensureSnapshotDir(plugin, vaultRelativePath);

  const record: SnapshotRecord = { timestamp, content, name };
  const filePath = getSnapshotFilePath(plugin, vaultRelativePath, timestamp);
  const adapter = plugin.app.vault.adapter;

  await adapter.write(filePath, JSON.stringify(record, null, 2));
}

export async function listSnapshotsForFile(
  plugin: SaveControlPlugin,
  vaultRelativePath: string
): Promise<(SnapshotRecord & { filePath: string })[]> {
  if (isExternalSnapshotPath(vaultRelativePath)) {
    const root = getExternalSnapshotRoot(plugin);
    const key = vaultRelativePath.slice(root.length + 1).replace(/^\/+/, "");
    return listExternalSnapshots(root, key).sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
  }
  const dirPath = getSnapshotDirPath(plugin, vaultRelativePath);
  const adapter = plugin.app.vault.adapter;

  if (!(await adapter.exists(dirPath))) {
    return [];
  }

  let listResult: { files: string[]; folders: string[] } | undefined;
  try {
    listResult = await adapter.list(dirPath);
  } catch {
    return [];
  }

  const jsonFiles = (listResult.files || [])
    .map((p: string) => p.replace(/\\/g, "/"))
    .filter((p: string) => p.endsWith(".json"))
    .sort();

  const snapshots: (SnapshotRecord & { filePath: string })[] = [];
  for (const p of jsonFiles) {
    const fullVaultPath = p.startsWith(dirPath) ? p : `${dirPath}/${p}`;
    try {
      const json = await adapter.read(fullVaultPath);
      if (json) {
        const record = normalizeRecord(JSON.parse(json) as Record<string, unknown>);
        snapshots.push({
          ...record,
          filePath: fullVaultPath
        });
      }
    } catch {
      // ignore
    }
  }

  snapshots.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
  return snapshots;
}

export async function readSnapshotContent(
  plugin: SaveControlPlugin,
  filePath: string
): Promise<SnapshotRecord | null> {
  // 库外快照是绝对路径的 fs 文件。
  if (isExternalSnapshotPath(filePath)) {
    return readExternalSnapshot(filePath);
  }
  const adapter = plugin.app.vault.adapter;

  if (!(await adapter.exists(filePath))) {
    return null;
  }

  try {
    const json = await adapter.read(filePath);
    return normalizeRecord(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function deleteSnapshotFile(
  plugin: SaveControlPlugin,
  filePath: string
): Promise<boolean> {
  if (isExternalSnapshotPath(filePath)) {
    return deleteExternalSnapshot(getExternalSnapshotRoot(plugin), filePath);
  }
  const adapter = plugin.app.vault.adapter;

  if (await adapter.exists(filePath)) {
    try {
      await adapter.remove(filePath);
      await removeEmptySnapshotDirs(plugin, filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function deleteOldestAutosaves(
  plugin: SaveControlPlugin,
  vaultRelativePath: string,
  keepCount: number
): Promise<void> {
  const snapshots = await listSnapshotsForFile(plugin, vaultRelativePath);
  const autosaves = snapshots.filter(s => s.name === "autosave");

  if (autosaves.length <= keepCount) return;

  const toDelete = autosaves.slice(keepCount);
  for (const s of toDelete) {
    await deleteSnapshotFile(plugin, s.filePath);
  }
}

async function removeEmptySnapshotDirs(plugin: SaveControlPlugin, filePath: string) {
  const adapter = plugin.app.vault.adapter;
  const root = getSnapshotRoot(plugin);

  // Walk upward from the deleted file's folder, removing empty dirs,
  // but never delete the configured snapshot root itself.
  const parts = filePath.replace(/\\/g, "/").split("/");
  parts.pop();
  let dir = parts.join("/");

  while (dir && dir !== root && dir.startsWith(root + "/")) {
    if (!(await adapter.exists(dir))) break;

    let listResult: { files: string[]; folders: string[] } | undefined;
    try {
      listResult = await adapter.list(dir);
    } catch {
      break;
    }

    const remainingFiles = (listResult.files || []).filter((p: string) => {
      const name = p.replace(/\\/g, "/").split("/").pop() || "";
      return !name.startsWith(".");
    });
    const remainingFolders = (listResult.folders || []).filter((p: string) => {
      const name = p.replace(/\\/g, "/").split("/").pop() || "";
      return !name.startsWith(".");
    });

    if (remainingFiles.length > 0 || remainingFolders.length > 0) break;

    try {
      await adapter.rmdir(dir, false);
    } catch {
      break;
    }

    dir = dir.split("/").slice(0, -1).join("/");
  }
}

export async function updateSnapshotLabel(
  plugin: SaveControlPlugin,
  filePath: string,
  newLabel: string
): Promise<boolean> {
  // 库外快照：fs 直改。
  if (isExternalSnapshotPath(filePath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = eval("require")("fs") as {
        existsSync(p: string): boolean;
        readFileSync(p: string, enc: "utf8"): string;
        writeFileSync(p: string, data: string, enc: "utf8"): void;
      };
      if (!fs.existsSync(filePath)) return false;
      const record = normalizeRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
      record.name = newLabel;
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
  }
  const adapter = plugin.app.vault.adapter;

  if (await adapter.exists(filePath)) {
    try {
      const json = await adapter.read(filePath);
      const record = normalizeRecord(JSON.parse(json) as Record<string, unknown>);
      record.name = newLabel;
      await adapter.write(filePath, JSON.stringify(record, null, 2));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function toggleSnapshotFavorite(
  plugin: SaveControlPlugin,
  filePath: string
): Promise<boolean> {
  if (isExternalSnapshotPath(filePath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = eval("require")("fs") as {
        existsSync(p: string): boolean;
        readFileSync(p: string, enc: "utf8"): string;
        writeFileSync(p: string, data: string, enc: "utf8"): void;
      };
      if (!fs.existsSync(filePath)) return false;
      const record = normalizeRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
      record.favorite = !record.favorite;
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
      return record.favorite;
    } catch {
      return false;
    }
  }
  const adapter = plugin.app.vault.adapter;
  if (await adapter.exists(filePath)) {
    try {
      const json = await adapter.read(filePath);
      const record = normalizeRecord(JSON.parse(json) as Record<string, unknown>);
      record.favorite = !record.favorite;
      await adapter.write(filePath, JSON.stringify(record, null, 2));
      return record.favorite;
    } catch {
      return false;
    }
  }
  return false;
}

export async function savePreRestoreBackup(
  plugin: SaveControlPlugin,
  vaultRelativePath: string,
  content: string
) {
  const dirPath = getSnapshotDirPath(plugin, vaultRelativePath);
  const adapter = plugin.app.vault.adapter;

  // If a pre-restore backup already exists, don't overwrite it —
  // preserve the original unsaved content until the user explicitly restores it.
  if (await adapter.exists(dirPath)) {
    try {
      const listResult = await adapter.list(dirPath);
      for (const p of listResult.files || []) {
        const fullPath = p.replace(/\\/g, "/");
        const fullVaultPath = fullPath.startsWith(dirPath) ? fullPath : `${dirPath}/${fullPath}`;
        if (fullVaultPath.endsWith(".json")) {
          try {
            const json = await adapter.read(fullVaultPath);
            const record = normalizeRecord(JSON.parse(json) as Record<string, unknown>);
            if (record.name === "pre-restore") {
              return;
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const timestamp = new Date().toISOString();
  await saveSnapshotContent(plugin, vaultRelativePath, timestamp, content, "pre-restore");
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
  vaultRelativePath: string
): Promise<void> {
  // 库外文件没有 vault delete 事件；其快照清理走 EVENT_EXTERNAL_DELETED。
  if (isExternalSnapshotPath(vaultRelativePath)) return;
  const dirPath = getSnapshotDirPath(plugin, vaultRelativePath);
  const adapter = plugin.app.vault.adapter;

  if (!(await adapter.exists(dirPath))) return;

  let listResult: { files: string[]; folders: string[] } | undefined;
  try {
    listResult = await adapter.list(dirPath);
  } catch {
    return;
  }

  for (const p of listResult.files || []) {
    const fullPath = p.replace(/\\/g, "/");
    const fullVaultPath = fullPath.startsWith(dirPath) ? fullPath : `${dirPath}/${fullPath}`;
    try {
      await adapter.remove(fullVaultPath);
    } catch {
      // ignore
    }
  }

  for (const p of listResult.folders || []) {
    const fullPath = p.replace(/\\/g, "/");
    const fullVaultPath = fullPath.startsWith(dirPath) ? fullPath : `${dirPath}/${fullPath}`;
    try {
      await adapter.rmdir(fullVaultPath, false);
    } catch {
      // ignore
    }
  }

  try {
    await adapter.rmdir(dirPath, false);
  } catch {
    // ignore
  }

  const parentDir = dirPath.substring(0, dirPath.lastIndexOf("/"));
  await removeEmptyParentDirs(plugin, parentDir);
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

export function derivePathFromSnapshotFile(plugin: SaveControlPlugin, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  // 库外快照：目录名就是快照键（ext_..._<hash>）。返回值与
  // getActiveFile().path（= 快照目录绝对路径）一致，isCurrentFile 才能对上。
  if (isExternalSnapshotPath(normalized)) {
    const extRoot = getExternalSnapshotRoot(plugin).replace(/\\/g, "/");
    const prefix = extRoot + "/";
    if (!normalized.startsWith(prefix)) return "";
    const afterRoot = normalized.slice(prefix.length);
    const lastSlash = afterRoot.lastIndexOf("/");
    if (lastSlash < 0) return "";
    return afterRoot.slice(0, lastSlash);
  }
  const root = getSnapshotRoot(plugin);
  const prefix = root + "/";
  if (!normalized.startsWith(prefix)) return "";
  const afterRoot = normalized.slice(prefix.length);
  const lastSlash = afterRoot.lastIndexOf("/");
  if (lastSlash < 0) return "";
  return afterRoot.slice(0, lastSlash);
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

  const root = getSnapshotRoot(plugin);
  const adapter = plugin.app.vault.adapter;
  const results: SearchMatch[] = [];
  const queryTrimmed = query.trim();
  const currentFilePath = plugin.getActiveFile()?.path ?? "";

  await walkJsonFiles(adapter, root, async (filePath) => {
    try {
      const json = await adapter.read(filePath);
      const record = normalizeRecord(JSON.parse(json) as Record<string, unknown>);
      const derivedPath = derivePathFromSnapshotFile(plugin, filePath);

      const ranges = getMatchRanges(record.content, queryTrimmed);
      if (ranges.length > 0) {
        const snippet = generateSnippet(record.content, queryTrimmed);
        results.push({
          ...record,
          filePath,
          path: derivedPath,
          snippet,
          isCurrentFile: derivedPath === currentFilePath,
        });
        return;
      }
      if (getMatchRanges(derivedPath, queryTrimmed).length > 0) {
        results.push({
          ...record,
          filePath,
          path: derivedPath,
          snippet: derivedPath,
          isCurrentFile: derivedPath === currentFilePath,
        });
        return;
      }

      const localTimeStr = new Date(record.timestamp).toLocaleString();
      if (getMatchRanges(localTimeStr, queryTrimmed).length > 0) {
        results.push({
          ...record,
          filePath,
          path: derivedPath,
          snippet: localTimeStr,
          isCurrentFile: derivedPath === currentFilePath,
        });
        return;
      }
    } catch {
      // skip invalid files
    }
  });

  // 库外快照根（若存在）也走一遍，同样的匹配逻辑。
  if (plugin.settings.externalFilesEnabled) {
    const extRoot = getExternalSnapshotRoot(plugin).replace(/\\/g, "/");
    const extRootNorm = extRoot.replace(/\/+$/, "");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = eval("require")("fs") as {
      existsSync(p: string): boolean;
      readdirSync(p: string): string[];
      readFileSync(p: string, enc: "utf8"): string;
    };
    if (fs.existsSync(extRootNorm)) {
      const stack: string[] = [extRootNorm];
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
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            isDir = (eval("require")("fs") as { statSync(p: string): { isDirectory(): boolean } }).statSync(full).isDirectory();
          } catch {
            continue;
          }
          if (isDir) {
            stack.push(full);
          } else if (n.endsWith(".json")) {
            try {
              const record = normalizeRecord(JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>);
              const derivedPath = derivePathFromSnapshotFile(plugin, full);
              const snippet = generateSnippet(record.content, queryTrimmed);
              const matchedContent = getMatchRanges(record.content, queryTrimmed).length > 0;
              const matchedPath = getMatchRanges(derivedPath, queryTrimmed).length > 0;
              if (matchedContent || matchedPath) {
                results.push({
                  ...record,
                  filePath: full,
                  path: derivedPath,
                  snippet: matchedContent ? snippet : derivedPath,
                  isCurrentFile: derivedPath === currentFilePath,
                });
              }
            } catch {
              // skip invalid files
            }
          }
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

export async function removeEmptyParentDirs(plugin: SaveControlPlugin, dirPath: string) {
  const snapshotRoot = getSnapshotRoot(plugin);
  let currentDir = dirPath.replace(/\\/g, "/");

  while (currentDir && currentDir !== snapshotRoot && currentDir.startsWith(snapshotRoot + "/")) {
    if (!(await plugin.app.vault.adapter.exists(currentDir))) break;

    let isDirEmpty = false;
    try {
      const listResult = await plugin.app.vault.adapter.list(currentDir);
      const files = listResult.files || [];
      const folders = listResult.folders || [];
      isDirEmpty = files.length === 0 && folders.length === 0;
    } catch {
      break;
    }

    if (!isDirEmpty) break;

    try {
      await plugin.app.vault.adapter.rmdir(currentDir, false);
    } catch {
      break;
    }

    currentDir = currentDir.split("/").slice(0, -1).join("/");
  }
}

async function walkJsonFiles(
  adapter: DataAdapter,
  dirPath: string,
  callback: (filePath: string) => Promise<void>
): Promise<void> {
  if (!(await adapter.exists(dirPath))) return;

  const jsonFiles: string[] = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let listResult: { files: string[]; folders: string[] };
    try {
      listResult = await adapter.list(current);
    } catch {
      continue;
    }

    for (const folder of listResult.folders || []) {
      const full = folder.replace(/\\/g, "/");
      stack.push(full.startsWith(current) ? full : `${current}/${full}`);
    }

    for (const file of listResult.files || []) {
      const full = file.replace(/\\/g, "/");
      const fullPath = full.startsWith(current) ? full : `${current}/${full}`;
      if (fullPath.endsWith(".json")) {
        jsonFiles.push(fullPath);
      }
    }
  }

  await Promise.all(jsonFiles.map(callback));
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


