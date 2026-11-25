/**
 * 版本快照的存储后端抽象（2026-11-25 移动端支持）。
 *
 * 桌面端快照落在库外的绝对路径根（E:/HOME/Runtime/...），走 Node fs；
 * 移动端没有 Node fs、也没有库根绝对路径，改走 vault adapter，根目錄放在
 * `<configDir>/plugins/<插件 id>/save-versions`（库内隐藏目录，随插件数据
 * 同进退，且被 autoVersion 的「自身产物」过滤覆盖，不会自我递归快照）。
 *
 * 所有方法都是异步的：adapter 只有异步 API，为了让桌面/移动共用一套调用，
 * Node fs 版本也包成 Promise。调用方（externalStore/storage）本来就是异步
 * 上下文，同步调用点只在测试里。
 */

import { Platform, type DataAdapter } from "obsidian";

export interface VersionFs {
  exists(p: string): Promise<boolean>;
  /** 逐级建目录（已存在是 no-op）。 */
  mkdirp(p: string): Promise<void>;
  /** 目录下的直接子项名（文件 + 目录）；目录不存在返回 []。 */
  listNames(p: string): Promise<string[]>;
  readText(p: string): Promise<string | null>;
  writeText(p: string, data: string): Promise<boolean>;
  removeFile(p: string): Promise<boolean>;
  /** 递归删除目录（缺省实现按逐层删除）。 */
  removeTree(p: string): Promise<void>;
  rename(from: string, to: string): Promise<boolean>;
}

/** 路径归一：正斜杠、去尾部斜杠。 */
export function normPath(p: string): string {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function parentOf(p: string): string {
  const norm = normPath(p);
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : "";
}

function baseNameOf(p: string): string {
  const norm = normPath(p);
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/** 移动端判定：Platform.isMobileApp 是权威；app.isMobile 是旧版兜底。 */
export function isMobileStorage(app: unknown): boolean {
  const a = app as { isMobile?: boolean } | null | undefined;
  return Platform.isMobileApp === true || a?.isMobile === true;
}

// ------------------------------------------------------------------
// Node fs 后端（桌面）
// ------------------------------------------------------------------

interface NodeFsLike {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts: { recursive: true }): void;
  writeFileSync(p: string, data: string, enc: "utf8"): void;
  readFileSync(p: string, enc: "utf8"): string;
  readdirSync(p: string): string[];
  unlinkSync?(p: string): void;
  renameSync?(from: string, to: string): void;
  rmSync?(p: string, opts: { recursive: true; force: true }): void;
}

function nodeFs(): NodeFsLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req = (eval("require") as (id: string) => unknown) as (id: string) => NodeFsLike;
    return req("fs");
  } catch {
    return null;
  }
}

/** 空实现：Node fs 不可用时所有操作退化为 no-op（绝不抛给调用方）。 */
const NOOP_FS: VersionFs = {
  async exists() {
    return false;
  },
  async mkdirp() {
    /* no-op */
  },
  async listNames() {
    return [];
  },
  async readText() {
    return null;
  },
  async writeText() {
    return false;
  },
  async removeFile() {
    return false;
  },
  async removeTree() {
    /* no-op */
  },
  async rename() {
    return false;
  },
};

export function nodeVersionFs(): VersionFs {
  const fs = nodeFs();
  if (!fs) return NOOP_FS;
  const mkdirp = (p: string): void => {
    const parts = normPath(p).split("/").filter(Boolean);
    let cur = normPath(p).startsWith("/") ? "/" : "";
    for (const part of parts) {
      cur = cur === "/" ? `/${part}` : cur ? `${cur}/${part}` : part;
      if (!fs.existsSync(cur)) fs.mkdirSync(cur, { recursive: true });
    }
  };
  return {
    async exists(p) {
      try {
        return fs.existsSync(normPath(p));
      } catch {
        return false;
      }
    },
    async mkdirp(p) {
      try {
        mkdirp(p);
      } catch {
        /* 建目录失败由后续写操作报错/降级 */
      }
    },
    async listNames(p) {
      try {
        return fs.readdirSync(normPath(p));
      } catch {
        return [];
      }
    },
    async readText(p) {
      try {
        return fs.readFileSync(normPath(p), "utf8");
      } catch {
        return null;
      }
    },
    async writeText(p, data) {
      try {
        mkdirp(parentOf(p));
        fs.writeFileSync(normPath(p), data, "utf8");
        return true;
      } catch {
        return false;
      }
    },
    async removeFile(p) {
      try {
        if (!fs.existsSync(normPath(p))) return false;
        fs.unlinkSync?.(normPath(p));
        return true;
      } catch {
        return false;
      }
    },
    async removeTree(p) {
      try {
        fs.rmSync?.(normPath(p), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
    async rename(from, to) {
      try {
        if (!fs.existsSync(normPath(from))) return true;
        mkdirp(parentOf(to));
        fs.renameSync?.(normPath(from), normPath(to));
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ------------------------------------------------------------------
// vault adapter 后端（移动端）
// ------------------------------------------------------------------

export function adapterVersionFs(adapter: DataAdapter): VersionFs {
  const mkdirp = async (p: string): Promise<void> => {
    const parts = normPath(p).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      try {
        if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
      } catch {
        /* 已存在/并发创建：继续 */
      }
    }
  };
  return {
    async exists(p) {
      try {
        return await adapter.exists(normPath(p));
      } catch {
        return false;
      }
    },
    async mkdirp(p) {
      await mkdirp(p);
    },
    async listNames(p) {
      try {
        const list = await adapter.list(normPath(p));
        return [
          ...(list.files ?? []).map(baseNameOf),
          ...(list.folders ?? []).map(baseNameOf),
        ];
      } catch {
        return [];
      }
    },
    async readText(p) {
      try {
        return await adapter.read(normPath(p));
      } catch {
        return null;
      }
    },
    async writeText(p, data) {
      try {
        await mkdirp(parentOf(p));
        await adapter.write(normPath(p), data);
        return true;
      } catch {
        return false;
      }
    },
    async removeFile(p) {
      try {
        if (!(await adapter.exists(normPath(p)))) return false;
        await adapter.remove(normPath(p));
        return true;
      } catch {
        return false;
      }
    },
    async removeTree(p) {
      try {
        await adapter.rmdir(normPath(p), true);
      } catch {
        /* best effort */
      }
    },
    async rename(from, to) {
      try {
        if (!(await adapter.exists(normPath(from)))) return true;
        await mkdirp(parentOf(to));
        await adapter.rename(normPath(from), normPath(to));
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ------------------------------------------------------------------
// 选择与测试注入
// ------------------------------------------------------------------

type PluginHost = {
  app: { vault: { adapter: DataAdapter } } & { isMobile?: boolean };
};

const cache = new WeakMap<object, VersionFs>();
const hooks: { fs?: VersionFs } = {};

/** 测试注入点；传 null 恢复生产后端。 */
export function __setVersionFsForTest(fs: VersionFs | null): void {
  hooks.fs = fs ?? undefined;
}

export function versionFsOf(plugin: PluginHost): VersionFs {
  if (hooks.fs) return hooks.fs;
  const cached = cache.get(plugin);
  if (cached) return cached;
  const fs = isMobileStorage(plugin.app) ? adapterVersionFs(plugin.app.vault.adapter) : nodeVersionFs();
  cache.set(plugin, fs);
  return fs;
}

/** 版本存储根：桌面绝对路径 / 移动端库内相对路径。 */
export function versionRootOf(plugin: PluginHost & { manifest?: { id?: string } }): string {
  const configured = String(
    (plugin as unknown as { settings?: { versionStorageFolder?: string } }).settings?.versionStorageFolder ?? "",
  ).trim();
  if (!isMobileStorage(plugin.app)) {
    const adapter = plugin.app.vault.adapter as unknown as {
      basePath?: string;
      getBasePath?: () => string;
    };
    const vaultBase =
      (typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath) ?? "";
    if (configured) {
      if (/^[A-Za-z]:[\\/]/.test(configured) || configured.startsWith("/")) {
        return configured.replace(/[\\/]+$/, "");
      }
      const base = vaultBase.replace(/[\\/]+$/, "");
      return `${base}/${configured.replace(/^[\\/]+/, "")}`;
    }
    return "E:/HOME/Runtime/save-control-versions";
  }
  // 移动端：没有库外绝对路径，只接受库内相对路径覆盖；绝对路径配置忽略。
  if (configured && !/^[A-Za-z]:[\\/]/.test(configured) && !configured.startsWith("/")) {
    return configured.replace(/[\\/]+$/, "");
  }
  const vault = plugin.app.vault as unknown as { configDir?: string };
  const configDir = vault.configDir || ".obsidian";
  const id = plugin.manifest?.id || "obsidian-my-obsidian";
  return `${configDir}/plugins/${id}/save-versions`;
}
