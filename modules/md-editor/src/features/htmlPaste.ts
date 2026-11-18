/**
 * HTML 粘贴转 markdown(og html-parser/convert + SilverBullet turndown 对齐,
 * 2026-11-19):剪贴板带 text/html 且不是「渲染型 md 源」时,此前落字面
 * 纯文本粘贴;本模块把真 HTML(网页划选等)转成 markdown 再走常规粘贴分派。
 *
 * 参考:og handler/paste.cljs——剪贴板有 HTML 就 html-parser/convert 转 md,
 * 失败回落纯文本;SilverBullet editor_paste.ts——turndown 转 md、剥 HTML
 * 注释、FencedCode/FrontMatter 内禁用。调用方守卫(extensions.ts pasteHandler):
 *  - internalClipboard 夹带与表格转换(tableMarkdownFromClipboard)在更早
 *    分支,优先级不变;
 *  - 光标块是代码块(blockTypeOf === 'code')不转换——代码块里粘贴 HTML
 *    应得字面文本(SB FencedCode 守卫同款);
 *  - 转换失败/纯文本壳 → null → 调用方字面粘贴,行为与旧版一致。
 *
 * turndown 是仓库既有依赖(browser 剪藏 markdown.ts 在用);GFM 表格插件
 * (@joplin/turndown-plugin-gfm)未引入,表格规则自写,提取复用
 * tablePaste.ts 的 pipeTableFromHtml——管道表语义与现有粘贴路径完全一致
 * (≥1行×2列才是表、单元格清洗、管道转义)。
 */

import TurndownService from 'turndown';
import { pipeTableFromHtml } from './tablePaste';

let converter: TurndownService | null = null;

function turndownOf(): TurndownService {
  if (!converter) {
    converter = new TurndownService({
      hr: '---',
      codeBlockStyle: 'fenced',
      headingStyle: 'atx',
      emDelimiter: '*',
      bulletListMarker: '-',
      strongDelimiter: '**',
      linkStyle: 'inlined',
    });
    // GFM 表格:整表提取走 pipeTableFromHtml(经 DOMParser 重解析该节点,
    // 与纯表格粘贴同一条管线);行列不足的「伪表」返回 null → 空串(turndown
    // 默认会把 table 拆成散文本,不如整段放弃)。
    converter.addRule('pipeTable', {
      filter: ['table'],
      replacement: (_content, node) => pipeTableFromHtml((node as HTMLElement).outerHTML) ?? '',
    });
  }
  return converter;
}

/** 值得转换的结构标记;纯文本壳(div+文字)不含任何一项 → null → 字面粘贴。 */
const STRUCTURAL_SELECTOR =
  'a, strong, b, em, i, del, s, strike, code, pre, ul, ol, h1, h2, h3, h4, h5, h6, table, img, blockquote, br, hr';

/**
 * turndown 的列表标记垫了 2 个额外空格(`-   a` / `1.  a`,对齐风格)——
 * 统一成单空格(`- a`)贴合手写习惯。逐行处理且**围栏感知**(围栏体内
 * 一字不动,防误伤代码内容);分隔行/围栏行本身不参与替换。
 */
function normalizeListMarkers(md: string): string {
  const lines = md.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0]) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    lines[i] = line.replace(/^(\s*(?:[-*+]|\d{1,9}[.)]))[ \t]{2,}(?=\S)/, '$1 ');
  }
  return lines.join('\n');
}

/** HTML → markdown;无可转换结构/失败返回 null(调用方字面粘贴)。 */
export function htmlToMarkdown(html: string): string | null {
  if (!html || !/<[a-z!/]/i.test(html)) return null;
  try {
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const body = dom.body;
    if (!body || !body.querySelector(STRUCTURAL_SELECTOR)) return null;
    // HTML 注释剥离(SilverBullet striptHtmlComments 同款)
    const cleaned = body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
    const md = normalizeListMarkers(turndownOf().turndown(cleaned));
    const out = md.replace(/\n{3,}/g, '\n\n').trim();
    return out || null;
  } catch {
    return null;
  }
}
