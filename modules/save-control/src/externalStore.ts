/**
 * 版本快照存储：路径布局 + 基于 VersionFs 的读写原语。
 *
 * 上游把快照放在库内 `<snapshotFolder>/<vault 路径>/<时间戳>.json`，靠
 * vault adapter 读写。统一后（库内 + 库外）快照全部落在一个**版本存储根**
 * （桌面默认 E:/HOME/Runtime/save-control-versions，移动端是库内插件目录）
 * 下，按文件路径镜像出的目录树分文件夹：
 *
 *   <root>/<key>/<时间戳>.json
 *
 * key 由 targets.snapshotKeyFor / absPathKey 产生，记录格式与上游完全相同
 * （{timestamp, content, name, favorite?}），所以列举、恢复、对比的代码
 * 两边共用。
 *
 * 2026-11-25：存储原语改为基于 VersionFs 的异步接口（桌面 Node fs /
 * 移动端 vault adapter 双后端，见 versionFs.ts）。
 */

import { __setVersionFsForTest, type VersionFs } from "./versionFs";

/** 快照记录：与上游 storage.ts 的 SnapshotRecord 一致。 */
export type SnapshotRecord = {
  timestamp: string; // ISO
  content: string;
  name: string;
  favorite?: boolean;
};

/** 旧版同步 fs 形状（仅测试注入用，生产参见 versionFs.ts）。 */
export interface ExternalFsLike {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts: { recursive: true }): void;
  writeFileSync(p: string, data: string, enc: "utf8"): void;
  readFileSync(p: string, enc: "utf8"): string;
  readdirSync(p: string): string[];
  unlinkSync?(p: string): void;
  renameSync?(from: string, to: string): void;
  rmSync?(p: string, opts: { recursive: true; force: true }): void;
  statSync?(p: string): { isDirectory(): boolean };
}

/** 把同步测试 fs 包成异步 VersionFs（测试注入用）。 */
export function versionFsFromSync(fs: ExternalFsLike): VersionFs {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = (p: string): string => {
    const n = norm(p);
    const i = n.lastIndexOf("/");
    return i > 0 ? n.slice(0, i) : "";
  };
  const mkdirp = (p: string): void => {
    const parts = norm(p).split("/").filter(Boolean);
    let cur = norm(p).startsWith("/") ? "/" : "";
    for (const part of parts) {
      cur = cur === "/" ? `/${part}` : cur ? `${cur}/${part}` : part;
      if (!fs.existsSync(cur)) fs.mkdirSync(cur, { recursive: true });
    }
  };
  return {
    async exists(p) {
      return fs.existsSync(norm(p));
    },
    async mkdirp(p) {
      mkdirp(p);
    },
    async listNames(p) {
      try {
        return fs.readdirSync(norm(p));
      } catch {
        return [];
      }
    },
    async readText(p) {
      try {
        return fs.readFileSync(norm(p), "utf8");
      } catch {
        return null;
      }
    },
    async writeText(p, data) {
      mkdirp(parent(p));
      fs.writeFileSync(norm(p), data, "utf8");
      return true;
    },
    async removeFile(p) {
      if (!fs.existsSync(norm(p))) return false;
      fs.unlinkSync?.(norm(p));
      return true;
    },
    async removeTree(p) {
      fs.rmSync?.(norm(p), { recursive: true, force: true });
    },
    async rename(from, to) {
      if (!fs.existsSync(norm(from))) return true;
      mkdirp(parent(to));
      fs.renameSync?.(norm(from), norm(to));
      return true;
    },
  };
}

/** 测试注入点；传 null 恢复生产后端（生产后端由调用方显式传入）。 */
export function __setFsForTest(fs: ExternalFsLike | null): void {
  __setVersionFsForTest(fs ? versionFsFromSync(fs) : null);
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

/** 目录下的条目分类：快照文件一律 .json，其余按目录处理。 */
function isSnapshotFileName(name: string): boolean {
  return name.endsWith(".json");
}

export async function saveExternalSnapshot(
  fs: VersionFs,
  root: string,
  key: string,
  timestamp: string,
  content: string,
  name: string,
): Promise<boolean> {
  const dir = externalSnapshotDir(root, key);
  await fs.mkdirp(dir);
  const record: SnapshotRecord = { timestamp, content, name };
  const ok = await fs.writeText(externalSnapshotFilePath(root, key, timestamp), JSON.stringify(record, null, 2));
  if (!ok) console.error("[save-control] external snapshot write failed", key);
  return ok;
}

/** 列某个库外文件的全部快照（新的在前）。 */
export async function listExternalSnapshots(
  fs: VersionFs,
  root: string,
  key: string,
): Promise<(SnapshotRecord & { filePath: string })[]> {
  const dir = externalSnapshotDir(root, key);
  const names = (await fs.listNames(dir)).filter(isSnapshotFileName).sort().reverse();
  const out: (SnapshotRecord & { filePath: string })[] = [];
  for (const n of names) {
    const filePath = join(dir, n);
    try {
      const json = await fs.readText(filePath);
      if (json) out.push({ ...normalizeRecord(JSON.parse(json) as Record<string, unknown>), filePath });
    } catch {
      // 单条读不动不该让整个列表失败
    }
  }
  return out;
}

export async function readExternalSnapshot(fs: VersionFs, filePath: string): Promise<SnapshotRecord | null> {
  try {
    const json = await fs.readText(filePath);
    if (!json) return null;
    return normalizeRecord(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function deleteExternalSnapshot(
  fs: VersionFs,
  root: string,
  filePath: string,
): Promise<boolean> {
  const ok = await fs.removeFile(filePath);
  if (ok) await pruneEmptyDirs(fs, root, filePath.replace(/[\\/]+/g, "/").split("/").slice(0, -1).join("/"));
  return ok;
}

/** 只保留最近的 keepCount 个 autosave 快照（0 = 不限制）。 */
export async function deleteOldestExternalAutosaves(
  fs: VersionFs,
  root: string,
  key: string,
  keepCount: number,
): Promise<void> {
  if (keepCount <= 0) return;
  const all = await listExternalSnapshots(fs, root, key);
  const autosaves = all.filter((s) => s.name === "autosave");
  for (const s of autosaves.slice(Math.max(0, keepCount))) {
    await deleteExternalSnapshot(fs, root, s.filePath);
  }
}

/** 库外文件被改名/移动后，把它的快照目录也搬过去（键跟着变）。 */
export async function renameExternalSnapshotDir(
  fs: VersionFs,
  root: string,
  oldKey: string,
  newKey: string,
): Promise<boolean> {
  const from = externalSnapshotDir(root, oldKey);
  const to = externalSnapshotDir(root, newKey);
  if (from === to) return true;
  if (!(await fs.exists(from))) return true;
  const ok = await fs.rename(from, to);
  if (!ok) console.error("[save-control] external snapshot rename failed", oldKey, newKey);
  return ok;
}

/** 从 startDir 向上清理空目录，但绝不删根（root 本身与根之外的都不动）。 */
export async function pruneEmptyDirs(fs: VersionFs, root: string, startDir: string): Promise<void> {
  let dir = startDir.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  while (dir && dir !== root && dir.startsWith(root + "/")) {
    const names = await fs.listNames(dir);
    if (names.length > 0) break;
    await fs.removeTree(dir);
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
export async function moveDirFs(fs: VersionFs, from: string, to: string): Promise<boolean> {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const src = norm(from);
  const dst = norm(to);
  if (src === dst) return true;
  try {
    if (!(await fs.exists(src))) return true;
    if (!(await fs.exists(dst))) {
      const renamed = await fs.rename(src, dst);
      if (renamed) return true;
      await fs.mkdirp(dst); // rename 失败：落个目录接着按文件复制
    }
    let allMoved = true;
    for (const n of await fs.listNames(src)) {
      const s = `${src}/${n}`;
      const d = `${dst}/${n}`;
      if (!isSnapshotFileName(n)) {
        if (!(await moveDirFs(fs, s, d))) allMoved = false;
        continue;
      }
      if (await fs.exists(d)) continue; // 目标已有同名快照：不覆盖
      const data = await fs.readText(s);
      if (data === null) {
        allMoved = false;
        continue;
      }
      if (!(await fs.writeText(d, data))) allMoved = false;
    }
    if (allMoved) await fs.removeTree(src);
    return allMoved;
  } catch (e) {
    console.error("[save-control] move dir failed", src, dst, e);
    return false;
  }
}
