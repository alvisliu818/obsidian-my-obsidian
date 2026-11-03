/**
 * 版本快照存储：Node fs 版的上游 storage.ts。
 *
 * 上游把快照放在库内 `<snapshotFolder>/<vault 路径>/<时间戳>.json`，靠
 * vault adapter 读写。统一后（库内 + 库外）快照全部落在一个**版本存储根**
 * （默认 E:/HOME/Runtime/save-control-versions，设置可改）下，按文件绝对
 * 路径镜像出的目录树分文件夹：
 *
 *   <root>/<absPathKey>/<时间戳>.json
 *
 * key 由 targets.snapshotKeyFor / absPathKey 产生，记录格式与上游完全相同
 * （{timestamp, content, name, favorite?}），所以列举、恢复、对比的代码
 * 两边共用。
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
  /** 目录/文件甄别用；缺省时按「不以 .json 结尾 = 目录」兜底。 */
  statSync?(p: string): { isDirectory(): boolean };
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

/** 生产用 Node fs、测试用注入 fs 的统一出口（storage 的迁移/清理也走这里）。 */
export function fsLike(): ExternalFsLike {
  return fsMod();
}

function join(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/[\\/]+/g, "/")
    .replace(/^\/\//, "/");
}

/** 版本存储根的默认位置：E:\HOME\Runtime 下的子文件夹（机器本地运行数据）。 */
export const DEFAULT_VERSION_ROOT = "E:/HOME/Runtime/save-control-versions";

/**
 * 解析版本存储根目录（绝对路径）。
 *
 * 设置留空 = 默认根（E:/HOME/Runtime/save-control-versions）；绝对路径按
 * 原样用；相对路径相对库根解析。
 */
export function resolveVersionRoot(opts: {
  /** 设置里的 versionStorageFolder：空 = 默认根。 */
  configured: string;
  /** 库根（vault.adapter.basePath），相对路径与某些兜底要用。 */
  vaultBase: string;
}): string {
  const configured = (opts.configured ?? "").trim();
  if (configured) {
    if (/^[A-Za-z]:[\\/]/.test(configured) || configured.startsWith("/")) {
      return configured.replace(/[\\/]+$/, "");
    }
    const base = opts.vaultBase.replace(/[\\/]+$/, "");
    return `${base}/${configured.replace(/^[\\/]+/, "")}`;
  }
  return DEFAULT_VERSION_ROOT;
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

/** 逐级建目录（绝对路径两种形态都要保住前缀）。 */
export function ensureDir(dir: string): void {
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
    pruneEmptyDirs(root, filePath.replace(/[\\/]+/g, "/").split("/").slice(0, -1).join("/"));
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

/** 从 startDir 向上清理空目录，但绝不删根（root 本身与根之外的都不动）。 */
export function pruneEmptyDirs(root: string, startDir: string): void {
  const fs = fsMod();
  let dir = startDir.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
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

/**
 * 把目录 from 整体搬到 to（迁移用，可重入）：
 *
 *   - to 不存在 → 直接 rename（同盘瞬间完成）；
 *   - to 已存在（上次迁移中断）→ 逐文件补齐缺的，齐全后删空源目录；
 *   - rename 失败（跨盘等）→ 复制内容到 to 再删源，逐文件进行，
 *     失败的文件留在原地，下次启动重试。
 *
 * 返回是否全部搬完（源目录已消失）。
 */
export function moveDirFs(from: string, to: string): boolean {
  const fs = fsMod();
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const src = norm(from);
  const dst = norm(to);
  if (src === dst) return true;
  try {
    if (!fs.existsSync(src)) return true;
    if (!fs.existsSync(dst)) {
      ensureDir(dst.split("/").slice(0, -1).join("/"));
      try {
        fs.renameSync?.(src, dst);
        return true;
      } catch {
        ensureDir(dst); // 跨盘 rename 失败：落个目录接着按文件复制
      }
    }
    let allMoved = true;
    for (const n of fs.readdirSync(src)) {
      const s = `${src}/${n}`;
      const d = `${dst}/${n}`;
      const isDir = fs.statSync ? fs.statSync(s).isDirectory() : !n.endsWith(".json");
      if (isDir) {
        if (!moveDirFs(s, d)) allMoved = false;
        continue;
      }
      if (fs.existsSync(d)) continue; // 目标已有同名快照：不覆盖，源里的稍后随目录清掉
      try {
        fs.writeFileSync(d, fs.readFileSync(s, "utf8"), "utf8");
      } catch {
        allMoved = false;
      }
    }
    if (allMoved) {
      try {
        fs.rmSync?.(src, { recursive: true, force: true });
      } catch {
        allMoved = false;
      }
    }
    return allMoved;
  } catch (e) {
    console.error("[save-control] move dir failed", src, dst, e);
    return false;
  }
}
