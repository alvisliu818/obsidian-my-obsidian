/**
 * 库外代码文件的行锚链接(`[[ext:<绝对路径>#L42|name:42]]`)。
 *
 * 与视频时间戳(videoTimestamps.ts)同一套约定:`ext:` 伪路径 wikilink,
 * 点击经 doc-tree 主文件里 patchOpenLinkTextForExtVideos 的 openLinkText
 * patch 路由到对应视图。行锚格式 `#L42` 是 GitHub 惯例;code-link 的
 * 符号解析对查不到的 tagPath 优雅回落整文件,互不影响。
 *
 * 为什么放 doc-tree:ext: 路由契约(生成/解析/patch)都住这里;库内文件
 * 不用这文件——它们走 generateMarkdownLink + setEphemeralState 原生链路。
 */
import { parseLinktext } from 'obsidian';
import { toExtPath } from './videoTimestamps';

// 供消费方(logseq 的 ExternalCodeView 扫描行级反链)单点引入
export { toExtPath };

/**
 * 库外代码文件的 wikilink:不带行 = `[[ext:<abs>|name]]`,
 * 带行 = `[[ext:<abs>#L42|name:42]]`(label 用 `文件:行`,一眼可读)。
 */
export function buildCodeExtLink(abs: string, line?: number): string {
  const name = abs.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? abs;
  const hasLine = typeof line === 'number' && Number.isFinite(line) && line >= 1;
  const n = hasLine ? Math.floor(line as number) : null;
  const label = n !== null ? `${name}:${n}` : name;
  const sub = n !== null ? `#L${n}` : '';
  return `[[${toExtPath(abs)}${sub}|${label}]]`;
}

/**
 * 从链接目标串(`ext:E:/a/b.py#L42`,可带 %20 编码)解析绝对路径与行号;
 * 不是 ext: 返回 null,是 ext: 但没有行锚(裸文件链接)返回 line: null。
 * 反斜杠归一与 parseExtVideoTarget 同款(生成的链接是正斜杠,fs 侧吃反斜杠)。
 */
export function parseExtCodeTarget(target: string): { abs: string; line: number | null } | null {
  if (!target.startsWith('ext:')) return null;
  const { path, subpath } = parseLinktext(target);
  const abs = path.slice(4);
  if (!abs) return null;
  let decoded = abs;
  try {
    decoded = decodeURIComponent(abs);
  } catch {
    /* 保留原样(路径里有裸 % 等罕见字符) */
  }
  const m = subpath ? /^#?L(\d+)$/.exec(subpath) : null;
  return {
    abs: decoded.replace(/\//g, '\\').replace(/^\\/, ''),
    line: m ? Number(m[1]) : null,
  };
}
