/**
 * Outlook 邮箱虚拟路径(纯语法层,无 IO;数据层见 outlookMailApi.ts)。
 *
 * 虚拟路径格式:
 *   outlook://                顶层邮件文件夹(Inbox、Sent Items、Drafts…)
 *   outlook:///<folder>       该文件夹的邮件列表(文件 = YYYYMMDD-HHMM-发件人-主题.md)
 *   outlook:///<f>/<mail>.files/<附件名>   附件(懒下载)
 *
 * 邮箱挂载是**只读源**:写/改名/删除一律拒绝。
 */

export const OUTLOOK_PREFIX = 'outlook://';

export function isOutlookPath(p: string): boolean {
  return typeof p === 'string' && p.startsWith(OUTLOOK_PREFIX);
}

/** 取虚拟路径去掉前缀并去结尾斜杠后的内部路径:"outlook:///Inbox/" → "/Inbox" */
export function outlookPathBody(vPath: string): string {
  return vPath.slice(OUTLOOK_PREFIX.length).replace(/\/+$/, '');
}

/** 挂载根的显示名 */
export function outlookRootLabel(_vPath: string): string {
  return '[Outlook 邮箱]';
}

/** 短显示名 */
export function outlookShortName(_vPath: string): string {
  return 'Outlook 邮箱';
}
