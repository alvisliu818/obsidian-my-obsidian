/**
 * 内部剪贴板格式夹带（思源 util/clipboardData.ts 行为移植，2026-10-26）。
 *
 * 自家复制出去的块在 text/html 里夹带一份 base64 的 markdown 原文（HTML
 * 注释，外部应用看不见、渲染不出来），粘贴回来时先于一切启发式提取——
 * 自家复制的内容**无条件**按 markdown 拆块，不经过 markdownClipboard 的
 * 「是不是 md 源」判定（那一判定的对象是外部剪贴板）。
 *
 * 为什么夹在 text/html 注释里而不写自定义 mime：Chromium 的
 * navigator.clipboard.write 对 ClipboardItem 类型有白名单（text/plain、
 * text/html、image/*），自定义 mime 写不进系统剪贴板；HTML 注释是唯一
 * 能随 text/html 全链路存活的载体（思源 data-siyuan 同款方案）。自定义
 * mime 的读取路径保留（dataTransfer / 手工 setData 场景可用）。
 *
 * 伪造面（思源 GHSA-9rr9-pxr4-gcgc 同类风险评估）：外部页面可以伪造这段
 * 注释，但提取结果只影响「按 markdown 拆 vs 字面粘贴」这一个决策，且与
 * 粘贴纯文本走同一个 parseDocument，无任何特权执行面——风险=决策面，可
 * 接受。注释在提取后即从 html 中剥除。
 */

/** 自定义 mime（dataTransfer 通道；写入通道见文件头）。 */
export const INTERNAL_MIME = 'text/x-obsidian-logseq';

/** 夹带注释形态：<!--data-obsidian-logseq='BASE64'-->（base64 字符集限定）。 */
const INTERNAL_COMMENT_RE = /<!--data-obsidian-logseq='([A-Za-z0-9+/=]*)'-->/g;

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000; // 分块避开 String.fromCharCode 参数上限
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function decodeBase64Utf8(b64: string): string {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return ''; // 坏 base64 / 坏 UTF-8：当没有内部数据（消毒）
  }
}

/** 自家复制写 text/html 时的夹带包装：internal 为空原样返回。 */
export function buildWebClipboardHTML(textHTML: string, internal: string): string {
  if (!internal) return textHTML;
  return `<!--data-obsidian-logseq='${encodeBase64Utf8(internal)}'-->${textHTML}`;
}

export interface InternalClipboardSplit {
  /** 提取出的内部 markdown（'' = 无内部数据）。 */
  internal: string;
  /** 剥除夹带注释后的 text/html（保持原内容，供后续消费方使用）。 */
  html: string;
}

/**
 * 从 text/html 里提取并剥除夹带注释。Excel 剪贴板守卫（思源 PR 16338
 * 同款）：Excel 的 html 带 xmlns:x office 命名空间且常含单元格文本，直接
 * 判无内部数据并剥掉任何同形注释，防止表格内容被误当内部 markdown。
 */
export function getInternalFromTextHTML(html: string): InternalClipboardSplit {
  if (
    html.trimStart().startsWith('<html') &&
    html.substring(0, html.indexOf('>')).includes('xmlns:x="urn:schemas-microsoft-com:office:excel"')
  ) {
    return { internal: '', html: html.replace(/<!--data-obsidian-logseq='[^']*'-->/g, '') };
  }
  const m = INTERNAL_COMMENT_RE.exec(html);
  INTERNAL_COMMENT_RE.lastIndex = 0;
  if (!m) return { internal: '', html };
  const internal = decodeBase64Utf8(m[1]);
  return { internal, html: html.replace(/<!--data-obsidian-logseq='[^']*'-->/g, '') };
}

/** 粘贴侧统一入口：自定义 mime 优先，回落 text/html 夹带注释。 */
export function getInternalFromClipboardData(d: { getData(type: string): string }): string {
  return d.getData(INTERNAL_MIME) || getInternalFromTextHTML(d.getData('text/html')).internal;
}

/**
 * 自家复制的 text/html 载体：外部应用粘贴看到的是 pre-wrap 的 markdown
 * 原文（我们不渲染富 HTML，载体只为夹带注释与保留换行）。
 */
export function internalCarrierHTML(md: string): string {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

/**
 * 块级复制统一出口：text/plain = markdown 原文，text/html = 夹带注释的
 * 载体。ClipboardItem 不可用（老运行时 / 权限拒绝）时回落纯文本写入。
 */
export async function writeMarkdownWithInternalFormat(md: string): Promise<void> {
  try {
    if (typeof ClipboardItem !== 'undefined' && typeof navigator !== 'undefined' && navigator.clipboard?.write) {
      const html = buildWebClipboardHTML(internalCarrierHTML(md), md);
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([md], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return;
    }
  } catch {
    // 回落到纯文本：功能不缺失，只丢内部格式（下次粘贴走启发式）。
  }
  await navigator.clipboard.writeText(md);
}
