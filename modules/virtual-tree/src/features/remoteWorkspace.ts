/**
 * remote 挂载(github:// / gitee:// / bdpan://)的本地工作副本管理。
 *
 * md-editor 的全部外部视图与 save-control 都对 `node.abs` 做同步 fs IO,远端
 * 文件没法直接喂虚拟路径 —— 所以打开时先把远端字节下载到插件缓存目录下的
 * 工作副本,用真实本地路径走既有编辑器路由(零改动);用户保存时把变更推回
 * 远端(git = commit,bdpan = 上传)。
 *
 * 保存捕获有**两条通道**,缺一不可:
 *  - extFs 写钩子(onExternalFileSaved):块编辑器/Monaco/ExternalFileView 等
 *    自家视图都经 writeExternalText 落盘,即时精确;
 *  - fs.watch 递归监听工作副本根:**Obsidian 原生编辑器**(TExternalFile 路线,
 *    md 的默认路由)直接用自家 IO 写盘,不经任何插件钩子 —— 只有内核级
 *    watch 能看到。
 * 两条通道汇入同一个 per-path 去抖队列,并用「下载快照校验和」去重:
 * 下载写盘本身也会触发 watch 事件(内核级拦不住),快照相同 = 回声,忽略。
 *
 * 缓存树形:`<root>/<family>/<...编码后的路径段>`,每段 encodeURIComponent,
 * Windows 非法字符(: * ? " < > |)不会出现在磁盘上;映射为纯函数,可单测。
 */

import { dirOf, ensureDir, joinAbs, onExternalFileSaved, readExternalBinary, writeExternalBytesQuiet } from './extFs';
import { isGitRepoPath, parseGitRepoPath, buildGitRepoPath, type GitRepoLocation } from './gitRepoPath';
import { isBaiduPath, baiduPathBody } from './baiduPath';
import { gitDownloadFile, gitUploadFile } from './gitRepoApi';
import { bdDownloadFile, bdUploadFile } from './baiduPanApi';
import { remoteShortName } from './remotePath';

// ==== 路径映射(纯函数,单测覆盖) ====

const enc = encodeURIComponent;
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // 手改过的目录名可能含非法转义:原样使用
  }
};

/**
 * 虚拟路径 → 工作副本相对路径(相对缓存根,`/` 分隔,每段已编码)。
 *
 * 结构:
 *   github://o/r@ref/a/b.md → github/o/r/<encRef>/a/b.md
 *   gitee://o/r@ref/x.md    → gitee/o/r/<encRef>/x.md
 *   bdpan://sync/a/b.md     → bdpan/sync/a/b.md
 *   bdpan:///docs/x.md      → bdpan/docs/x.md
 * 非远端路径返回 null。目录路径与文件同样可映射(挂载根刷新时也走工作副本树)。
 */
export function remoteWorkRelOf(vPath: string): string | null {
  const loc = isGitRepoPath(vPath) ? parseGitRepoPath(vPath) : null;
  if (loc) {
    const head = [loc.provider, enc(loc.owner), enc(loc.repo), enc(loc.ref)];
    const rest = loc.path ? loc.path.split('/').filter(Boolean).map(enc) : [];
    return [...head, ...rest].join('/');
  }
  if (isBaiduPath(vPath)) {
    const body = baiduPathBody(vPath);
    const segs = body.split('/').filter(Boolean).map(enc);
    return ['bdpan', ...segs].join('/');
  }
  return null;
}

/**
 * 工作副本相对路径 → 虚拟路径(remoteWorkRelOf 的逆)。
 * 形状不合法(家族未知 / 段数不足)返回 null。
 */
export function remoteVPathFromWorkRel(rel: string): string | null {
  const segs = rel.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const family = segs[0];
  if (family === 'github' || family === 'gitee') {
    // github/<owner>/<repo>/<ref>/<path...>;文件至少要在 ref 下再多一段
    if (segs.length < 5) return null;
    const loc = {
      provider: family,
      owner: dec(segs[1]),
      repo: dec(segs[2]),
      ref: dec(segs[3]),
      path: segs.slice(4).map(dec).join('/'),
    } as GitRepoLocation;
    return buildGitRepoPath(loc);
  }
  if (family === 'bdpan') {
    return 'bdpan://' + segs.slice(1).map(dec).join('/');
  }
  return null;
}

// ==== 运行时(初始化 / 下载 / 写回推送) ====

let workRoot = '';
let notify: (msg: string) => void = () => undefined;
let unsubscribeExtHook: (() => void) | null = null;
/** fs.watch 句柄(结构化最小面,避免依赖 node 类型) */
let dirWatcher: { close(): void; on(ev: string, fn: () => void): unknown } | null = null;

/** 初始化:接上缓存根与通知回调,并订阅 extFs 的保存广播(onload 时调用) */
export function initRemoteWorkspace(opts: { root: string; notify?: (msg: string) => void }): void {
  workRoot = opts.root.replace(/[\\/]+$/, '');
  if (opts.notify) notify = opts.notify;
  if (unsubscribeExtHook) unsubscribeExtHook();
  unsubscribeExtHook = onExternalFileSaved((abs) => schedulePush(abs));
}

/** 停止监听(onunload);已排队的推送继续跑完 */
export function stopRemoteWorkspace(): void {
  if (unsubscribeExtHook) unsubscribeExtHook();
  unsubscribeExtHook = null;
  if (dirWatcher) {
    dirWatcher.close();
    dirWatcher = null;
  }
}

export function remoteWorkspaceRoot(): string {
  return workRoot;
}

/** 远端文件 → 本地工作副本绝对路径(仅映射,不下载) */
export function remoteWorkPathOf(vPath: string): string | null {
  const rel = remoteWorkRelOf(vPath);
  return rel ? joinAbs(workRoot, rel) : null;
}

/**
 * 下载远端文件到工作副本(每次都重新下载,保证打开即新鲜),返回本地绝对路径。
 * 下载完成后记录快照校验和 —— 紧随其后的 fs.watch 回声事件据此忽略。
 */
export async function ensureRemoteWorkFile(vPath: string): Promise<string> {
  if (!workRoot) throw new Error('remote 工作副本未初始化');
  const abs = remoteWorkPathOf(vPath);
  if (!abs) throw new Error(`不是合法的远端路径: ${vPath}`);
  const bytes = isGitRepoPath(vPath)
    ? await gitDownloadFile(vPath)
    : isBaiduPath(vPath)
      ? await bdDownloadFile(vPath)
      : null;
  if (bytes === null) throw new Error(`不支持的远端路径: ${vPath}`);
  const dir = ensureDir(dirOf(abs));
  if (!dir.ok) throw new Error(`无法创建工作副本目录:${dir.error ?? '未知错误'}`);
  // 静默写:下载不是用户保存,不进 extFs 保存钩子(fs.watch 的回声由快照去重)
  const w = writeExternalBytesQuiet(abs, bytes);
  if (!w.ok) throw new Error(`无法写入工作副本:${w.error ?? '未知错误'}`);
  ensureWatcher();
  snapshots.set(vPath, checksum(bytes));
  return abs;
}

// ==== 保存捕获:extFs 钩子 + fs.watch 双通道 → 去抖 → 快照去重 → 推回远端 ====

/** 下载/已推内容的校验和快照:vPath → FNV-1a(内容)⊕长度。 */
const snapshots = new Map<string, string>();

function checksum(bytes: Uint8Array): string {
  // FNV-1a 32 位 + 长度:足够识别「没变化/下载回声」,全量比对交给
  // gitUploadFile 的远端内容比对(误判的代价只是少推一次,不会写坏)
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(16)}`;
}

// 同一远端文件的推送去抖(连续保存合并;extFs 钩子与 fs.watch 双来源汇入)
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePush(abs: string): void {
  if (!workRoot) return;
  const rel = relOfWorkPath(abs);
  const vPath = rel ? remoteVPathFromWorkRel(rel) : null;
  if (!vPath) return;
  const prev = pushTimers.get(vPath);
  if (prev) clearTimeout(prev);
  pushTimers.set(
    vPath,
    setTimeout(() => {
      pushTimers.delete(vPath);
      void pushWorkFile(vPath, abs);
    }, 800),
  );
}

/** fs.watch 事件(rel 为 null = 目录变更或 filename 不可用,忽略) */
function onWatchChange(filename: string | Buffer | null): void {
  if (!workRoot || filename === null) return;
  const name = typeof filename === 'string' ? filename : filename.toString('utf8');
  if (!name) return;
  // 事件名是相对 workRoot 的原生分隔符路径
  schedulePush(joinAbs(workRoot, name.replace(/[\\/]+$/, '')));
}

/** 工作副本根存在后才启动 watch(首次下载前目录还不存在) */
function ensureWatcher(): void {
  if (dirWatcher) return;
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    dirWatcher = fs.watch(workRoot, { recursive: true }, (_ev, filename) => onWatchChange(filename));
    dirWatcher.on('error', () => {
      // 目录被外部删除等:下次打开文件时会 ensureWatcher 重启
      try {
        dirWatcher?.close();
      } catch {
        /* ignore */
      }
      dirWatcher = null;
    });
  } catch {
    // watch 不可用(理论只在非桌面环境):extFs 钩子通道仍在
    dirWatcher = null;
  }
}

/** 去抖到期:读当前内容 → 快照相同(下载回声/已推过)忽略,否则推回远端 */
async function pushWorkFile(vPath: string, abs: string): Promise<void> {
  let sum = '';
  try {
    const bytes = readExternalBinary(abs);
    sum = checksum(bytes);
    if (snapshots.get(vPath) === sum) return; // 下载回声或已推内容:无事可做
    snapshots.set(vPath, sum);
    let pushed: boolean;
    if (isGitRepoPath(vPath)) {
      // 无差异(或仅 CRLF/LF 行尾差)时 gitUploadFile 跳过提交 → false
      pushed = await gitUploadFile(vPath, bytes);
    } else if (isBaiduPath(vPath)) {
      await bdUploadFile(vPath, bytes);
      pushed = true;
    } else {
      return;
    }
    if (pushed) notify(`已推送到远端:${remoteShortName(vPath)}`);
  } catch (e) {
    // 推送失败清掉快照:同样内容的下一次保存还能重试(网络抖动场景)
    if (sum) snapshots.delete(vPath);
    const name = remoteShortName(vPath);
    notify(`推送远端失败:${name} —— ${(e as Error)?.message || e}`);
  }
}

// 推送串行:同一远端文件的 gitUploadFile 内部有写链,这里不再串行;快照在
// pushWorkFile 里先记再推,重复事件不会叠加提交。

/** 工作副本绝对路径 → 相对缓存根的 rel;不在缓存树内返回 null。
 *  匹配按大小写不敏感(Windows 缓存根),但 **rel 保留原大小写** —— git 的
 *  路径大小写敏感,把 README.md 推成 readme.md 等于推成另一个文件。 */
function relOfWorkPath(abs: string): string | null {
  if (!workRoot) return null;
  const rootNorm = workRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const norm = abs.replace(/\\/g, '/').replace(/\/+$/, '');
  const rootLower = rootNorm.toLowerCase();
  const normLower = norm.toLowerCase();
  if (normLower === rootLower || !normLower.startsWith(rootLower + '/')) return null;
  return norm.slice(rootNorm.length + 1);
}
