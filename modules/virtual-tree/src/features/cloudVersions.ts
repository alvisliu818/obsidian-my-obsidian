/**
 * 云端历史版本统一入口(2026-11-22 用户:OneDrive / 百度同步空间)。
 *
 * 两家差异:
 *  - OneDrive:Graph 有正式版本接口(列版本 + 下载版本内容 + 下载后覆盖上传恢复);
 *  - 百度同步空间:只有网页内部接口(客户端同款),需 cookie 模式,
 *    恢复语义是「另存为新文件」,且不提供历史版本内容下载(不能预览)。
 * UI(cloudHistoryModal)只依赖本文件的统一类型,不关心后端差异。
 */
import { isBaiduPath } from './baiduPath';
import { isOneDrivePath } from './onedrivePath';
import { odDownloadVersion, odListVersions, odRestoreVersion } from './onedriveApi';
import { bdListRevisions, bdRestoreRevision } from './baiduPanApi';

export type CloudProvider = 'onedrive' | 'bdpan';

export interface CloudVersion {
  id: string;
  /** ISO 时间('' = 未知) */
  modified: string;
  size: number;
  /** 百度历史列表里的当前版本(不可恢复) */
  current?: boolean;
}

export function cloudProviderOf(vPath: string): CloudProvider | null {
  if (isOneDrivePath(vPath)) return 'onedrive';
  if (isBaiduPath(vPath)) return 'bdpan';
  return null;
}

export function cloudProviderLabel(p: CloudProvider): string {
  return p === 'onedrive' ? 'OneDrive' : '百度同步空间';
}

export async function listCloudVersions(vPath: string): Promise<CloudVersion[]> {
  const provider = cloudProviderOf(vPath);
  if (provider === 'onedrive') return await odListVersions(vPath);
  if (provider === 'bdpan') return await bdListRevisions(vPath);
  throw new Error('该路径不在 OneDrive / 百度网盘挂载内');
}

/** 预览历史版本文本(仅 OneDrive 支持;百度网页接口不提供版本内容下载)。 */
export async function readCloudVersionText(vPath: string, versionId: string): Promise<string> {
  const provider = cloudProviderOf(vPath);
  if (provider !== 'onedrive') {
    throw new Error('百度网盘不提供历史版本内容下载,无法预览;可在百度网盘客户端/网页版查看');
  }
  const bytes = await odDownloadVersion(vPath, versionId);
  const limit = 2 * 1024 * 1024;
  if (bytes.length > limit) {
    throw new Error(`版本内容过大(${(bytes.length / 1024 / 1024).toFixed(1)} MB),暂不支持预览`);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** 恢复历史版本;返回给用户看的结果说明。 */
export async function restoreCloudVersion(vPath: string, versionId: string): Promise<string> {
  const provider = cloudProviderOf(vPath);
  if (provider === 'onedrive') {
    await odRestoreVersion(vPath, versionId);
    return '已恢复所选版本(覆盖当前文件,并生成一个新版本)。';
  }
  if (provider === 'bdpan') {
    const newPath = await bdRestoreRevision(vPath, versionId);
    return newPath
      ? `已按百度「另存为」恢复为新文件:${newPath}`
      : '已按百度「另存为」方式恢复为新文件(与源文件同目录)。';
  }
  throw new Error('该路径不在 OneDrive / 百度网盘挂载内');
}
