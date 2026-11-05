/**
 * KernelApi 契约与 discovery 发现协议（docs/kernel-separation-design.md §3/§4）。
 *
 * 本文件**保持纯**：类型 + 纯字符串工具 + fs 注入工厂。它会被两侧 bundle 共享——
 * daemon（platform:node,esbuild 自动 external builtin）与渲染进程主 bundle
 * （platform:browser,fs/crypto 不可静态解析,见 daemonClient 的 eval('require')
 * 先例）——所以绝不能出现顶层 node builtin import。
 * discovery 实际读写经 createDiscoveryIO(fsLike) 注入；stdio 旧协议（proto 1）
 * 的 op 语义原样平移为 HTTP /api/:op。
 */

export const KERNEL_PROTO = 2;

/** /ping 应答 + SSE 首帧的握手段。 */
export interface KernelInfo {
  proto: number;
  pid: number;
  vault: string;
  dbPath: string;
  startedAt: number;
}

/** discovery 文件内容：<dbPath 目录>/kernel-<slug>-<hash8>.json（§3）。 */
export interface KernelDiscovery extends KernelInfo {
  port: number;
  token: string;
}

export type QueryName =
  | 'getById'
  | 'blocksByPath'
  | 'tagsByPath'
  | 'backlinksTo'
  | 'refsToBlock'
  | 'supertagInstances'
  | 'scan'
  | 'fts'
  | 'nameSearch'
  | 'withIds'
  | 'allTags'
  | 'allCards'
  | 'supertags';

/** 事件帧（SSE data 行；stdio 模式下即 JSON 行的 ev 消息，语义一一对应）。 */
export type KernelEvent =
  | { ev: 'hello'; proto: number; pid: number }
  | { ev: 'changed'; version: number }
  | { ev: 'progress'; done: number; total: number }
  | { ev: 'fts'; enabled: boolean };

/** 与现 stdio 协议 op 面一一对应（daemonMain.handle 的 switch）。 */
export type KernelOp =
  | { op: 'ping' }
  | { op: 'stats' }
  | { op: 'sync' }
  | { op: 'rebuild' }
  | { op: 'turbo'; mode?: 'rebuild' | 'sync' }
  | { op: 'upsert'; paths?: string[] }
  | { op: 'delete'; paths?: string[] }
  | { op: 'setExclude'; folders?: string[] }
  | { op: 'setExt'; files?: { path: string; mtime: number }[] }
  | { op: 'extSearch'; tokens?: string[]; not?: string[]; limit?: number }
  | { op: 'query'; q?: QueryName; args?: Record<string, unknown> }
  /** R2d 运行时配置推送：常驻内核可能由旧构建/外部脚本拉起（argv 无
   *  --obsidian-exe），detach 后配置只能在连接建立后补送（§2 决策 9）。 */
  | { op: 'setConfig'; obsidianExe?: string }
  /** 在 Obsidian 中打开 vault（托盘「打开 Obsidian」与 HTTP 客户端共用同一条
   *  派发链：runtime exe → 注册表关联 → 拒绝，绝无 explorer 中间商）。 */
  | { op: 'open' };

/** op → 客户端超时（ms）。turbo/rebuild 应答只是收尾，进度走事件（§5）。 */
export const OP_TIMEOUT_MS: Record<string, number> = {
  ping: 5_000,
  query: 30_000,
  upsert: 60_000,
  delete: 60_000,
  sync: 60_000,
  setExclude: 60_000,
  setExt: 120_000,
  rebuild: 30 * 60_000,
  turbo: 30 * 60_000,
  setConfig: 5_000,
  open: 10_000,
};

/**
 * obsidian:// 协议关联的 command 值解析（托盘/open op 的 exe 兜底）。
 * 常规格式 `"D:\x\Obsidian.exe" "%1"` → 取首个带引号的 .exe 路径；无引号变体
 * `C:\x\Obsidian.exe "%1"` 取盘符开头 token（带空格的无引号路径本身不可解析，
 * 安装器必加引号——此分支纯防御）。
 */
export function parseRegistryCommand(value: string): string {
  const quoted = value.match(/"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const bare = value.match(/([A-Za-z]:\\[^\s"]+\.exe)/i);
  return bare ? bare[1] : '';
}

// ----------------------------------------------------------------------
// 纯工具：slug / discovery 路径
// ----------------------------------------------------------------------

/** FNV-1a 32bit（与 sqliteSchema 的 hashText 同族；自含避免跨域依赖）。 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * discovery 文件名 slug：库文件 basename 净化 + 全路径 hash8——不同 vault
 * 共用同一 dbDir 且同名库时也不互踩（唯一性锚在 dbPath 全路径上）。
 */
export function kernelSlug(dbPath: string): string {
  const base = dbPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'db';
  const clean = base.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'db';
  return `${clean}-${fnv1a32(dbPath).toString(16).padStart(8, '0')}`;
}

export function discoveryPath(dbPath: string): string {
  const dir = dbPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  return `${dir}/kernel-${kernelSlug(dbPath)}.json`;
}

// ----------------------------------------------------------------------
// discovery 原子读写（fs 注入——两侧 bundle 各自供实现）
// ----------------------------------------------------------------------

/** 最小 fs 面：daemon 传 node:fs；客户端传 eval('require')('fs') 的同形切片。 */
export interface DiscoveryFsLike {
  readFileSync(path: string, enc: 'utf8'): string;
  writeFileSync(path: string, data: string, enc: 'utf8'): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

export interface DiscoveryIO {
  /** 读 discovery：文件缺/坏 JSON/缺字段 → null（陈旧文件靠探活兜底,§3）。 */
  read(dbPath: string): KernelDiscovery | null;
  /** 原子写：tmp + rename（deploy.mjs atomicWriteFile 同纪律,§3）。 */
  write(dbPath: string, disc: KernelDiscovery): void;
}

export function createDiscoveryIO(fsLike: DiscoveryFsLike): DiscoveryIO {
  return {
    read(dbPath: string): KernelDiscovery | null {
      let raw: string;
      try {
        raw = fsLike.readFileSync(discoveryPath(dbPath), 'utf8');
      } catch {
        return null;
      }
      try {
        const d = JSON.parse(raw) as Partial<KernelDiscovery>;
        if (typeof d.port !== 'number' || typeof d.token !== 'string' || typeof d.pid !== 'number') return null;
        return d as KernelDiscovery;
      } catch {
        return null;
      }
    },
    write(dbPath: string, disc: KernelDiscovery): void {
      const file = discoveryPath(dbPath);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fsLike.writeFileSync(tmp, JSON.stringify(disc), 'utf8');
        fsLike.renameSync(tmp, file);
      } catch (e) {
        try {
          fsLike.unlinkSync(tmp);
        } catch {
          /* 不存在 */
        }
        throw e;
      }
    },
  };
}

/** token 生成注入：daemon 传 node:crypto randomBytes；测试传确定性实现。 */
export function makeToken(randomBytes: (n: number) => Uint8Array): string {
  let s = '';
  const bytes = randomBytes(24);
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
