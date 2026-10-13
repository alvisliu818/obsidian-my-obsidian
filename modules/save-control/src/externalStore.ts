/**
 * 库外文件的快照存储：Node fs 版的上游 storage.ts。
 *
 * 上游把快照放在库内 `<snapshotFolder>/<vault 路径>/<时间戳>.json`，靠
 * vault adapter 读写。库外文件没有 vault 路径，也不能往用户的文件夹里塞
 * `.versions(SH)`，于是落到插件目录（或设置指定的目录）下：
 *
 *   <root>/<snapshotKey>/<时间戳>.json
 *
 * snapshotKey 由 targets.snapshotKeyFor 产生（转义路径 + 8 位哈希），记录
 * 格式与库内完全相同（{timestamp, content, name, favorite?}），所以列举、
 * 恢复、对比的代码两边共用。
 *
 * fs 走可注入的 NodeFsLike：单测不碰真盘，生产用真 fs。
 */

/** 快照记录：与上游 storage.ts 的 SnapshotRecord 一致。 */
export type SnapshotRecord = {
  timestamp: string; // ISO
  content: string;
  name: string;
  favorite?: boolean;
};

export interface ExternalFsLike {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts: { recursive: true }): void;
  writeFileSync(p: string, data: string, enc: "utf8"): void;
  readFileSync(p: string, enc: "utf8"): string;
  readdirSync(p: string): string[];
  unlinkSync?(p: string): void;
  renameSync?(from: string, to: string): void;
  rmSync?(p: string, opts: { recursive: true; force: true }): void;
}

const hooks: { fs?: ExternalFsLike } = {};

/** 测试注入点；生产用 Node 真 fs。 */
export function __setFsForTest(fs: ExternalFsLike | null): void {
  hooks.fs = fs ?? undefined;
}

function fsMod(): ExternalFsLike {
  if (hooks.fs) return hooks.fs;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval("require")("fs") as ExternalFsLike;
}

function join(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/[\\/]+/g, "/")
    .replace(/^\/\//, "/");
}

/** 解析库外快照根目录（绝对路径）。 */
export function resolveExternalSnapshotRoot(opts: {
  /** 设置里的 externalSnapshotFolder：空 = 插件目录下默认名。 */
  configured: string;
  /** 库根（vault.adapter.basePath）。 */
  vaultBase: string;
  /** 插件目录（manifest.dir，可能相对库根）。 */
  pluginDir: string;
}): string {
  const configured = (opts.configured ?? "").trim();
  if (configured) {
    if (/^[A-Za-z]:[\\/]/.test(configured) || configured.startsWith("/")) return configured.replace(/[\\/]+$/, "");
    const base = opts.vaultBase.replace(/[\\/]+$/, "");
    return `${base}/${configured.replace(/^[\\/]+/, "")}`;
  }
  const dir = opts.pluginDir.replace(/[\\/]+$/, "");
  const base = opts.vaultBase.replace(/[\\/]+$/, "");
  // manifest.dir 通常是 `.obsidian/plugins/<id>`（相对库根）；极端情况下是
  // 绝对路径，那时直接用。
  const abs = /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("/") ? dir : `${base}/${dir}`;
  return join(abs, "save-control-snapshots");
}

export function externalSnapshotDir(root: string, key: string): string {
  return join(root, key);
}

export function externalSnapshotFilePath(root: string, key: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/:/g, "-");
  return join(externalSnapshotDir(root, key), `${safeTimestamp}.json`);
}

export function normalizeRecord(raw: Record<string, unknown>): SnapshotRecord {
  return {
    timestamp: String(raw.timestamp ?? ""),
    content: String(raw.content ?? ""),
    name: String(raw.name ?? raw.reason ?? ""),
    favorite: Boolean(raw.favorite),
  };
}

function ensureDir(dir: string): void {
  const fs = fsMod();
  if (fs.existsSync(dir)) return;
  const parts = dir.replace(/[\\/]+/g, "/").split("/");
  // 绝对路径两种形态都要保住前缀：POSIX 的 "/a/b"（首段空串 → "/"）与
  // Windows 的 "E:/a/b"（首段盘符）。相对路径从 "" 起步。
  let current = parts[0].includes(":") ? parts[0] : parts[0] === "" ? "/" : "";
  for (const part of parts.slice(current ? 1 : 0)) {
    if (!part) continue;
    current = `${current.replace(/\/+$/, "")}/${part}`;
    if (!fs.existsSync(current)) fs.mkdirSync(current, { recursive: true });
  }
}

export function saveExternalSnapshot(
  root: string,
  key: string,
  timestamp: string,
  content: string,
  name: string,
): boolean {
  try {
    const fs = fsMod();
    const dir = externalSnapshotDir(root, key);
    ensureDir(dir);
    const record: SnapshotRecord = { timestamp, content, name };
    fs.writeFileSync(externalSnapshotFilePath(root, key, timestamp), JSON.stringify(record, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[save-control] external snapshot write failed", key, e);
    return false;
  }
}

/** 列某个库外文件的全部快照（新的在前）。 */
export function listExternalSnapshots(root: string, key: string): (SnapshotRecord & { filePath: string })[] {
  const fs = fsMod();
  const dir = externalSnapshotDir(root, key);
  if (!fs.existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
  const out: (SnapshotRecord & { filePath: string })[] = [];
  for (const n of names) {
    const filePath = join(dir, n);
    try {
      const json = fs.readFileSync(filePath, "utf8");
      if (json) out.push({ ...normalizeRecord(JSON.parse(json) as Record<string, unknown>), filePath });
    } catch {
      // 单条读不动不该让整个列表失败
    }
  }
  return out;
}

export function readExternalSnapshot(filePath: string): SnapshotRecord | null {
  try {
    const fs = fsMod();
    if (!fs.existsSync(filePath)) return null;
    const json = fs.readFileSync(filePath, "utf8");
    return normalizeRecord(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function deleteExternalSnapshot(root: string, filePath: string): boolean {
  try {
    const fs = fsMod();
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync?.(filePath);
    removeEmptyDirs(root, filePath);
    return true;
  } catch (e) {
    console.error("[save-control] external snapshot delete failed", filePath, e);
    return false;
  }
}

/** 只保留最近的 keepCount 个 autosave 快照（0 = 不限制）。 */
export function deleteOldestExternalAutosaves(root: string, key: string, keepCount: number): void {
  if (keepCount <= 0) return;
  const all = listExternalSnapshots(root, key);
  const autosaves = all.filter((s) => s.name === "autosave");
  for (const s of autosaves.slice(Math.max(0, keepCount))) {
    deleteExternalSnapshot(root, s.filePath);
  }
}

/** 库外文件被改名/移动后，把它的快照目录也搬过去（键跟着变）。 */
export function renameExternalSnapshotDir(root: string, oldKey: string, newKey: string): boolean {
  try {
    const fs = fsMod();
    const from = externalSnapshotDir(root, oldKey);
    const to = externalSnapshotDir(root, newKey);
    if (!fs.existsSync(from) || from === to) return true;
    ensureDir(to.split("/").slice(0, -1).join("/"));
    fs.renameSync?.(from, to);
    return true;
  } catch (e) {
    console.error("[save-control] external snapshot rename failed", oldKey, newKey, e);
    return false;
  }
}

/** 从被删快照向上清理空目录，但绝不删根。 */
function removeEmptyDirs(root: string, filePath: string): void {
  const fs = fsMod();
  let dir = filePath.replace(/[\\/]+/g, "/").split("/").slice(0, -1).join("/");
  while (dir && dir !== root && dir.startsWith(root + "/")) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      break;
    }
    if (names.length > 0) break;
    try {
      fs.rmSync?.(dir, { recursive: true, force: true });
    } catch {
      break;
    }
    dir = dir.split("/").slice(0, -1).join("/");
  }
}
