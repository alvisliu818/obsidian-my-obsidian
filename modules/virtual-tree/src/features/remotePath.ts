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

export type RemoteFamily = 'github' | 'gitee' | 'bdpan';

/** 是否任一远端虚拟路径(github:// / gitee:// / bdpan://) */
export function isRemotePath(p: string): boolean {
  return isGitRepoPath(p) || isBaiduPath(p);
}

/**
 * 是否**可解析**的远端路径。isRemotePath 只看前缀(github://garbage 也算),
 * 挂载持久化(mountFrom)需要更严的校验:git 路径必须能解出 owner/repo/ref,
 * 否则挂上去是一棵永远拉不到数据的死树。
 */
export function validRemotePath(p: string): boolean {
  if (isBaiduPath(p)) return true;
  const loc = parseGitRepoPath(p);
  return !!loc;
}

/** 远端家族;非远端路径返回 null */
export function remoteFamilyOf(p: string): RemoteFamily | null {
  if (p.startsWith('github://')) return 'github';
  if (p.startsWith('gitee://')) return 'gitee';
  if (isBaiduPath(p)) return 'bdpan';
  return null;
}

/** 面板/选择器里的短显示名(纯字符串,不触发网络) */
export function remoteShortName(vPath: string): string {
  if (isBaiduPath(vPath)) return baiduShortName(vPath);
  return gitRepoShortName(vPath);
}

/** 挂载根的完整显示名(带 provider 标签,不触发网络) */
export function remoteRootLabel(vPath: string): string {
  if (isBaiduPath(vPath)) return baiduRootLabel(vPath);
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

export type { GitProvider };
