/**
 * 远端挂载(remount/remote)的虚拟路径分发层(纯函数,无 IO、无 obsidian)。
 *
 * remote 挂载的 `path` 是三种虚拟路径家族之一,按前缀分发到各自的后端:
 *   github:// / gitee://  Git 仓库(gitRepoPath.ts 语法层 + gitRepoApi.ts 数据层)
 *   bdpan://              百度网盘(baiduPath.ts 语法层 + baiduPanApi.ts 数据层)
 *
 * 面板/打开/文件操作都先经这里的判定函数分流,再调各自后端 —— 与
 * siyuan-virtual-tree 的 isRemotePath 同语义。
 */

import { isBaiduPath, baiduShortName, baiduRootLabel } from './baiduPath';
import { isGitRepoPath, parseGitRepoPath, gitRepoShortName, gitRepoRootLabel, type GitProvider } from './gitRepoPath';
import { isOneDrivePath, oneDriveShortName, oneDriveRootLabel } from './onedrivePath';
import { isOutlookPath, outlookShortName, outlookRootLabel } from './outlookMailPath';
import { isWeblinkPath, weblinkUrlOf, isBmarksPath, BMARKS_PREFIX } from './linkMount';
import { isActionPath as isActionMountPath, parseActionSpec } from './actionMount';
import { isImapPath, imapPathParts, imapProviderOf, imapRootLabel, imapShortName } from './imapPath';

export type RemoteFamily = 'github' | 'gitee' | 'bdpan' | 'onedrive' | 'outlook' | 'imap' | 'weblink' | 'bmarks' | 'action';

/** 是否任一远端虚拟路径(github:// / gitee:// / bdpan:// / onedrive:// / outlook:// / weblink:// / bmarks:// / action://) */
export function isRemotePath(p: string): boolean {
  return (
    isGitRepoPath(p) ||
    isBaiduPath(p) ||
    isOneDrivePath(p) ||
    isOutlookPath(p) ||
    isWeblinkPath(p) ||
    isBmarksPath(p) ||
    isActionMountPath(p) ||
    isImapPath(p)
  );
}

/**
 * 是否**可解析**的远端路径。isRemotePath 只看前缀(github://garbage 也算),
 * 挂载持久化(mountFrom)需要更严的校验:git 路径必须能解出 owner/repo/ref,
 * 否则挂上去是一棵永远拉不到数据的死树。weblink/bmarks/action 自校验
 * (spec/URL 就编码在路径体里)。
 */
export function validRemotePath(p: string): boolean {
  if (isBaiduPath(p)) return true;
  if (isOneDrivePath(p)) return true;
  if (isOutlookPath(p)) return true;
  if (isImapPath(p)) return true;
  if (isWeblinkPath(p)) return weblinkUrlOf(p).length > 0;
  if (isBmarksPath(p)) return true;
  if (isActionMountPath(p)) return !!parseActionSpec(p);
  if (isImapPath(p)) return true;
  const loc = parseGitRepoPath(p);
  return !!loc;
}

/** 远端家族;非远端路径返回 null */
export function remoteFamilyOf(p: string): RemoteFamily | null {
  if (p.startsWith('github://')) return 'github';
  if (p.startsWith('gitee://')) return 'gitee';
  if (isBaiduPath(p)) return 'bdpan';
  if (isOneDrivePath(p)) return 'onedrive';
  if (isOutlookPath(p)) return 'outlook';
  if (isWeblinkPath(p)) return 'weblink';
  if (isBmarksPath(p)) return 'bmarks';
  if (isActionMountPath(p)) return 'action';
  if (isImapPath(p)) return 'imap';
  return null;
}

/** 面板/选择器里的短显示名(纯字符串,不触发网络) */
export function remoteShortName(vPath: string): string {
  if (isBaiduPath(vPath)) return baiduShortName(vPath);
  if (isOneDrivePath(vPath)) return oneDriveShortName(vPath);
  if (isOutlookPath(vPath)) return outlookShortName(vPath);
  if (isImapPath(vPath)) return imapShortName(vPath);
  if (isWeblinkPath(vPath)) {
    try {
      const u = new URL(weblinkUrlOf(vPath));
      return u.hostname + (u.pathname !== '/' ? u.pathname : '');
    } catch {
      return weblinkUrlOf(vPath);
    }
  }
  if (isActionMountPath(vPath)) {
    const spec = parseActionSpec(vPath);
    return spec ? (spec.type === 'shell' ? '命令' : '脚本') : '脚本';
  }
  if (isBmarksPath(vPath)) return '浏览器书签';
  if (isImapPath(vPath)) {
    const { provider, segs } = imapPathParts(vPath);
    return segs.length ? decodeImapSeg(segs[0]) : imapProviderOf(provider).label;
  }
  return gitRepoShortName(vPath);
}

/** 挂载根的完整显示名(带 provider 标签,不触发网络) */
export function remoteRootLabel(vPath: string): string {
  if (isBaiduPath(vPath)) return baiduRootLabel(vPath);
  if (isOneDrivePath(vPath)) return oneDriveRootLabel(vPath);
  if (isOutlookPath(vPath)) return outlookRootLabel(vPath);
  if (isWeblinkPath(vPath)) return '[网页链接] ' + weblinkUrlOf(vPath);
  if (isActionMountPath(vPath)) return '[脚本/命令]';
  if (isBmarksPath(vPath)) return BMARKS_PREFIX === 'bmarks://' ? '[浏览器书签]' : '[书签]';
  if (isImapPath(vPath)) return imapRootLabel(vPath);
  return gitRepoRootLabel(vPath);
}

/** git 家族(github/gitee)判定 —— 文件操作/网页打开等只有 git 有的能力分流用 */
export function isGitFamilyPath(p: string): boolean {
  return isGitRepoPath(p);
}

/**
 * 拼接远端虚拟子路径。结尾斜杠折叠回 `://` 前缀的最小形态:`bdpan:///` + '/a'
 * 得到 `bdpan://a`(网盘根)而不是 `bdpan:////a` —— 网盘路径体里多出来的斜杠
 * 会被当成路径段。
 */
export function remoteChildVPath(vBase: string, rel: string): string {
  const base = vBase.replace(/\/+$/, (m) => (m.length >= 2 ? '//' : m));
  return `${base}/${rel}`;
}

function decodeImapSeg(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export type { GitProvider };
