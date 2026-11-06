/**
 * 粘贴决策树的 markdown 启发式（思源 util/markdownClipboard.ts 行为移植，
 * 2026-10-26）。
 *
 * 剪贴板同时带 text/html 和 text/plain 时（网页划选、Typora / 渲染型 md
 * 应用的复制），要决定纯文本侧按 markdown 拆块还是字面粘贴。思源的判定
 * 是「markdown 用 Lute 渲染成 HTML 后与剪贴板 HTML isEqualNode 才判 md 源」；
 * 我们没有 Lute / md→HTML 渲染器，替代口径保同一个判定信号：
 *
 *   剪贴板 HTML 的**可见文本** == markdown **渲染后**的文本 → 纯文本是
 *   这份 HTML 的 markdown 源（渲染剥掉了记号）；渲染前后文本一致（网页
 *   划选的原文同文）或记号剥掉后对不上 → 不是 md 源，字面粘贴。
 *
 * 与 isEqualNode 的差异：结构逐点比 → 文本行等价比（空白折叠后）。富样式
 * / 富媒体早退与 DOLLAR 占位守卫逐条保留。已知取舍：hasUnrenderedContent
 * （pre/code 外文本节点含字面换行或 `$x$` → md 源）不移植——它是思源在
 * isEqualNode 之前的**加速早退**，我们的渲染等价比较本身已覆盖该信号；
 * 而 Typora 的干净渲染 HTML（文本节点无字面换行）会被它误杀。
 */

/** 思源同款：剪贴板内容含此私有区字符时直接放弃（比对占位符撞车）。 */
export const DOLLAR_PLACEHOLDER = '';

/**
 * markdown 渲染后的文本近似（纯字符串，无 DOM）。只服务等价性比较：
 * 块记号（# / - / > / 围栏 / 表格分隔）剥掉、行内记号（强调 / 行内代码 /
 * 链接 / 图片）剥掉、围栏与 $$ 数学体保留原文、hr 归空行——与对应 HTML
 * 渲染的可见文本同一形态。不求渲染正确，只求「渲染是否剥记号」稳定。
 */
export function renderedTextOfMarkdown(md: string): string {
  const lines = md.replace(/\r\n?|\u2028|\u2029/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string | null = null; // 打开的围栏标记（``` 或 ~~~），null = 未在围栏内
  for (const line of lines) {
    if (fence !== null) {
      if (fence === '$$') {
        // $$ 数学体：内容原文保留，配对的 $$ 闭合。
        if (/^\s*\$\$\s*$/.test(line)) fence = null;
        else out.push(line);
        continue;
      }
      // 围栏体内：内容原文（<pre><code> 的 textContent 就是原文）。
      if (new RegExp(`^\\s*${fence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line)) {
        fence = null; // 闭合围栏行不产生文本
      } else {
        out.push(line);
      }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = open[1]; // 信息串与围栏行本身不产生文本
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      fence = '$$';
      continue;
    }
    // hr：渲染后无文本
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      out.push('');
      continue;
    }
    let s = line;
    // 标题 / 引用 / 列表记号各剥一层（嵌套引用逐层剥）
    s = s.replace(/^\s{0,3}#{1,6}\s+/, '');
    while (/^\s{0,3}>/.test(s)) s = s.replace(/^\s{0,3}>\s?/, '');
    s = s.replace(/^(\s*)([-*+]|\d{1,9}[.)])\s+/, '$1');
    // 表格行：分隔行（只含 | - : 空白）整行不产生文本；数据行去管道后逐格
    // 相连（<td> 的 textContent 逐格相连，中间无分隔）。
    if (/^\s*\|.*\|\s*$/.test(s)) {
      if (/^\s*\|[\s:|-]*\|\s*$/.test(s) && s.includes('-')) continue;
      s = s
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim())
        .join('');
    }
    out.push(stripInlineMarkdown(s));
  }
  return out.join('\n');
}

/** 行内记号剥除：行内代码优先（内部原样保留），随后图片/链接/自动链接/强调。 */
function stripInlineMarkdown(s: string): string {
  const codes: string[] = [];
  // 行内代码 span 先摘出来暂存（\u0000 哨兵不可能出现在正文里）
  let s0 = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, body) => {
    codes.push(body);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 图片在链接之前（![a](u) 会被链接正则部分命中）
  s0 = s0.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s0 = s0.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s0 = s0.replace(/<((?:https?|obsidian):[^>]+)>/g, '$1');
  // 强调：成对剥（*** / ** / __ / ~~ / == / * / _）
  for (const m of ['\\*\\*\\*', '\\*\\*', '__', '~~', '==', '\\*', '_']) {
    s0 = s0.replace(new RegExp(`${m}([^\\s].*?)${m}`, 'g'), '$1');
  }
  // 暂存的行内代码还原
  return s0.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)] ?? '');
}

/**
 * 移除块级容器之间的排版空白文本节点（思源 normalizeClipboardHTML 逐行
 * 移植）：ol 的十进制 list-style 内联样式视同默认（渲染器差异），注释节点
 * 与块级容器直属的纯空白文本节点移除，最后 normalize 合并相邻文本节点。
 */
function normalizeClipboardHTML(root: DocumentFragment): void {
  root.querySelectorAll('ol[style]').forEach((element) => {
    if (/^\s*list-style-type\s*:\s*decimal\s*;?\s*$/i.test(element.getAttribute('style') ?? '')) {
      element.removeAttribute('style');
    }
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  const remove: Node[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (
      node.nodeType === Node.COMMENT_NODE ||
      (node.nodeType === Node.TEXT_NODE &&
        !node.textContent?.trim() &&
        (node.parentNode === root ||
          /^(DIV|UL|OL|BLOCKQUOTE|TABLE|THEAD|TBODY|TFOOT|TR)$/.test(node.parentElement?.tagName ?? '')))
    ) {
      remove.push(node);
    }
  }
  remove.forEach((n) => n.parentNode?.removeChild(n));
  root.normalize();
}

/**
 * 剪贴板 HTML 的可见文本（按行收集）：块级元素各占一行（\n 分隔），UL/OL/
 * TR/TD 透明直通（单元格文本相连，与渲染文本的表格形态一致），BR 折行，
 * HR 空行。最后全局折叠空白（渲染噪音：缩进、软换行包装）。
 */
function clipboardHTMLText(root: Node): string {
  const BLOCK = /^(P|H[1-6]|LI|PRE|BLOCKQUOTE|DIV|HR|DD|DT)$/;
  const TRANSPARENT = /^(UL|OL|TABLE|TR|TD|TH|THEAD|TBODY|TFOOT)$/;
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    // template.content 是 DocumentFragment(nodeType 11):直通其子节点。
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return Array.from(node.childNodes).map(walk).join('');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    if (el.tagName === 'BR' || el.tagName === 'HR') return '\n';
    const inner = Array.from(el.childNodes).map(walk).join('');
    if (BLOCK.test(el.tagName)) return `\n${inner}`;
    if (TRANSPARENT.test(el.tagName)) return inner;
    return inner; // 行内元素与未知元素：直通
  };
  return walk(root);
}

// 上面 clipboardHTMLText 不自行折叠空白;归一在 stripWs 里做

/** 判定用的统一归一化：去除所有空白字符（两侧同法）。语义：渲染不改变
 * 任何非空白字符；行界/缩进/单元格分隔这类渲染器间不一致的空白全部忽略。 */
function stripWs(s: string): string {
  return s.replace(/\s+/g, '');
}

/**
 * 启发式主体：剪贴板同时带 html 与纯文本时，纯文本是否为这份 HTML 的
 * markdown 源。true → 按 markdown 拆块；false → 字面粘贴（落 CM 默认）。
 * 纯 DOM 依赖（template + TreeWalker），Obsidian 渲染进程可用；单测用
 * jsdom 环境跑。
 */
export function shouldPasteMarkdownFromHTML(html: string, text: string): boolean {
  if (!html || !text?.trim() || text.includes(DOLLAR_PLACEHOLDER) || html.includes(DOLLAR_PLACEHOLDER)) {
    return false;
  }
  // 使用惰性片段解析，不加载剪贴板里的图片、不执行元素事件。
  const sourceTemplate = document.createElement('template');
  sourceTemplate.innerHTML = html;
  const source = sourceTemplate.content;
  const markdown = text.replace(/\r\n?|\u2028|\u2029/g, '\n');
  normalizeClipboardHTML(source);
  const sourceText = stripWs(clipboardHTMLText(source));
  // 网页划选：HTML 可见文本与纯文本原文相同（渲染没有改变任何文字），
  // 不能仅凭文本相同就把它当 markdown 源（思源同款早退）。
  if (sourceText === stripWs(markdown)) return false;
  // 富样式 / 富媒体（样式、类、公式、SVG、iframe、视频、音频）：markdown
  // 表达不了，不替换富文本（思源同款早退）。
  if (source.querySelector('[style], [class], math, svg, iframe, video, audio')) return false;
  // 渲染等价性：markdown 渲染后的文本 == HTML 可见文本 → 纯文本是 md 源。
  return sourceText === stripWs(renderedTextOfMarkdown(markdown));
}
