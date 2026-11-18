/**
 * 远端文件的异步文本 IO 直连层(2026-11-14 用户需求:异步 API 直连)。
 *
 * md-editor 的四个外部视图(块编辑器/混合代码/Monaco/文档模型)与 save-control
 * 的读写全部走本层的两个分发函数:虚拟路径(github:// / gitee:// / bdpan://)
 * 直接与远端 API 互转(打开即读、保存即提交/上传,si-yuan 同语义),磁盘路径
 * 原样走 extFs。编辑器视图的 abs 因此可以是虚拟路径 —— 标签复用、headerPath、
 * save-control 版本键都按 abs 工作,虚拟路径天然可用。
 *
 * 媒体/二进制不在这里:查看器与「系统打开」需要真实文件,仍走 remoteWorkspace
 * 的工作副本(打开时下载一次)。
 */

import { readExternalText, writeExternalText } from './extFs';
import { isGitRepoPath } from './gitRepoPath';
import { isBaiduPath } from './baiduPath';
import { isOneDrivePath } from './onedrivePath';
import { isOutlookPath } from './outlookMailPath';
import { isImapPath } from './imapPath';
import { isRemotePath } from './remotePath';
import { gitDownloadFile, gitUploadFile } from './gitRepoApi';
import { bdDownloadFile, bdUploadFile } from './baiduPanApi';
import { odDownloadFile, odUploadFile } from './onedriveApi';
import { outlookDownloadFile } from './outlookMailApi';
import { imapDownloadFile } from './imapMailApi';

/** 异步读文本:远端虚拟路径直连 API 下载,磁盘路径走 extFs。 */
export async function readTextAny(abs: string): Promise<string> {
  if (!isRemotePath(abs)) return readExternalText(abs);
  // IMAP 邮件：正文/元信息渲染成 Markdown（只读）
  if (isImapPath(abs)) return imapDownloadFile(abs).then((b) => new TextDecoder('utf-8').decode(b));
  const bytes = isGitRepoPath(abs)
    ? await gitDownloadFile(abs)
    : isBaiduPath(abs)
      ? await bdDownloadFile(abs)
      : isOneDrivePath(abs)
        ? await odDownloadFile(abs)
        : isOutlookPath(abs)
          ? await outlookDownloadFile(abs)
          : null;
  if (bytes === null) throw new Error(`不是合法的远端路径: ${abs}`);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 异步写文本:远端虚拟路径直接提交到远端(git 内容无差异时自动跳过并返回
 * false;bdpan/OneDrive 始终覆盖上传),磁盘路径走 extFs 并触发保存广播。
 */
export async function writeTextAny(abs: string, data: string): Promise<boolean> {
  if (!isRemotePath(abs)) {
    writeExternalText(abs, data);
    return true;
  }
  // 邮箱挂载是只读源:邮件不提供编辑语义(思源同款)
  if (isOutlookPath(abs)) throw new Error('Outlook 邮箱挂载为只读,不支持保存(请到邮箱客户端操作)');
  if (isImapPath(abs)) throw new Error('IMAP 邮箱挂载为只读,不支持保存(请到邮箱客户端操作)');
  const bytes = new TextEncoder().encode(data);
  if (isGitRepoPath(abs)) return gitUploadFile(abs, bytes);
  if (isBaiduPath(abs)) {
    await bdUploadFile(abs, bytes);
    return true;
  }
  if (isOneDrivePath(abs)) {
    await odUploadFile(abs, bytes);
    return true;
  }
  throw new Error(`不是合法的远端路径: ${abs}`);
}
