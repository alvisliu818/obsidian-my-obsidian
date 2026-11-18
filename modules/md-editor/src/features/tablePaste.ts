/**
 * 粘贴转表格(思源 cm6-table.ts 的 pasteAsTable 对齐,2026-11-18):
 * 剪贴板是 HTML `<table>`(网页/Excel 带 HTML 复制)或多行 TSV(Excel/Sheets
 * 的纯文本复制)时,转成 markdown 管道表整块插入。
 *
 * 与思源版同语义:
 *  - HTML 表格 ≥1 行且 ≥2 列才接管(单列"表格"是列表,不该变表);
 *  - TSV 有 tab 且 ≥2 列才接管;空行跳过;
 *  - 光标在表格块内不接管(往已有表里粘一个新表是合并灾难);
 *  - 单元格换行压空格、`|` 转义(单元格是单行实体)。
 *
 * 纯函数(tableMarkdownFromClipboard 只做判定与生成,插入走 handlePaste),
 * 单测直测。
 */

/** 单元格文本清洗:换行压空格、管道转义。 */
function cellOut(text: string): string {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

/** HTML 表格 → 管道表 markdown;不是表格/行列数不足返回 null。 */
export function pipeTableFromHtml(html: string): string | null {
  if (!/<table[\s>]/i.test(html)) return null;
  try {
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const trs = Array.from(dom.querySelectorAll('tr'));
    const parsed = trs
      .map((tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => cellOut(c.textContent || '')))
      .filter((cells) => cells.length > 0);
    const cols = Math.max(0, ...parsed.map((r) => r.length));
    if (parsed.length < 1 || cols < 2) return null;
    return serializeRows(parsed.map((r) => padRow(r, cols)));
  } catch {
    return null;
  }
}

/** 多行 TSV → 管道表 markdown;没有 tab/不足两列返回 null。 */
export function pipeTableFromTsv(text: string): string | null {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l !== '');
  if (lines.length < 1 || !lines.some((l) => l.includes('\t'))) return null;
  const parsed = lines.map((l) => l.split('\t').map((c) => cellOut(c)));
  const cols = Math.max(0, ...parsed.map((r) => r.length));
  if (cols < 2) return null;
  return serializeRows(parsed.map((r) => padRow(r, cols)));
}

function padRow(row: string[], cols: number): string[] {
  const out = row.slice(0, cols);
  while (out.length < cols) out.push('');
  return out;
}

function serializeRows(rows: string[][]): string {
  const head = '| ' + rows[0].join(' | ') + ' |';
  const sep = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
  const rest = rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |');
  return [head, sep, ...rest].join('\n');
}

export interface TablePasteOptions {
  /** 光标所在块的文本(块模型里表格块 = 管道行文本);null = 无焦点块。 */
  focusedBlockText?: string | null;
}

/**
 * 剪贴板 → markdown 管道表。优先 HTML 表格,回落 TSV。
 * 光标在表格块内 / 剪贴板不是表格形态 → null(调用方回落默认粘贴)。
 */
export function tableMarkdownFromClipboard(html: string, text: string, opts: TablePasteOptions = {}): string | null {
  const focused = opts.focusedBlockText ?? '';
  if (focused && /^\s{0,3}\|.*\|/.test(focused.split('\n')[0] ?? '')) return null;
  if (html) {
    const fromHtml = pipeTableFromHtml(html);
    if (fromHtml) return fromHtml;
  }
  if (text && text.includes('\n')) {
    return pipeTableFromTsv(text);
  }
  return null;
}
