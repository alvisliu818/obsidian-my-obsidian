/**
 * nbformat 解析 / 序列化 / 输出渲染 — 纯逻辑,无 DOM 依赖(除本文件的 HTML
 * 字符串拼装),从 siyuan-virtual-tree 的 notebook-tab.ts 抽取而来。
 *
 * 查看:代码/Markdown/Raw 单元格,已保存的执行输出(文本/图片/HTML/JSON/错误)。
 * 编辑:写回 nbformat JSON,保留 source 的 string/string[] 原有形态。
 */

// nbformat 4 单元格/笔记本(宽松类型:源文件可能有各种形状)
export interface NbCell {
  cell_type: string;
  source?: unknown;
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  id?: string;
}

export interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NbCell[];
}

/** 解析结果:nb 为 null 时 error 说明原因(视图切原始 JSON 兜底编辑) */
export interface ParseResult {
  nb: Notebook | null;
  error: string;
}

/** 解析并校验 nbformat 4(旧版 nbformat 3 明确提示转换) */
export function parseNotebook(text: string): ParseResult {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && Array.isArray(parsed.cells) && Number(parsed.nbformat) >= 4) {
      return { nb: parsed as unknown as Notebook, error: '' };
    }
    if (parsed && Array.isArray((parsed as { worksheets?: unknown }).worksheets)) {
      return { nb: null, error: '检测到旧版 nbformat 3 笔记本,暂不支持,请用 Jupyter 转换为 nbformat 4' };
    }
    return { nb: null, error: '不是有效的 nbformat 4 笔记本' };
  } catch (e) {
    return { nb: null, error: `JSON 解析失败: ${String(e)}` };
  }
}

export function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 去掉 ANSI 颜色转义(错误 traceback 用) */
export function stripANSI(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 单元格 source 兼容 string / string[] 两种 nbformat 形态 */
export function getSourceText(cell: NbCell): string {
  const src = cell.source;
  if (Array.isArray(src)) return src.join('');
  return String(src ?? '');
}

/** 写回 source 时保留原有形态(数组按行拆分,保留除最后一行外的换行) */
export function setSourceText(cell: NbCell, text: string): void {
  if (Array.isArray(cell.source)) {
    cell.source = text.length ? text.split(/(?<=\n)/) : [''];
  } else {
    cell.source = text;
  }
}

/** 输出 data 的值同样可能是 string 或 string[] */
export function mimeText(v: unknown): string {
  if (Array.isArray(v)) return v.join('');
  return String(v ?? '');
}

/** notebook 内核语言 → CM mode(legacy-modes StreamParser / lezer 包工厂) */
export type CellLang =
  | { kind: 'stream'; name: string }
  | { kind: 'javascript'; typescript: boolean }
  | { kind: 'markdown' }
  | { kind: 'none' };

const NB_LANG_MAP: Record<string, string> = {
  python: 'python', r: 'r', julia: 'julia', bash: 'shell', shell: 'shell',
  sh: 'shell', zsh: 'shell', javascript: 'javascript', js: 'javascript',
  typescript: 'typescript', ts: 'typescript', c: 'c', 'c++': 'cpp', cpp: 'cpp',
  java: 'java', sql: 'sql', go: 'go', rust: 'rust', ruby: 'ruby',
};

export function notebookLang(nb: Notebook | null | undefined): CellLang {
  const li = nb?.metadata?.language_info as { name?: unknown } | undefined;
  const raw = String(li?.name ?? '').toLowerCase();
  const mapped = NB_LANG_MAP[raw] ?? '';
  if (!mapped) return { kind: 'none' };
  if (mapped === 'javascript') return { kind: 'javascript', typescript: false };
  if (mapped === 'typescript') return { kind: 'javascript', typescript: true };
  if (mapped === 'markdown') return { kind: 'markdown' };
  return { kind: 'stream', name: mapped };
}

/** 新建单元格(nbformat 4.5+ 的单元格带 id,与文件里现有单元格保持一致) */
export function makeCell(type: 'code' | 'markdown', withId: boolean): NbCell {
  const cell: NbCell =
    type === 'code'
      ? { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' }
      : { cell_type: 'markdown', metadata: {}, source: '' };
  if (withId) cell.id = Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4);
  return cell;
}

/** 单元格徽章文案 */
export function cellBadge(cell: NbCell): string {
  if (cell.cell_type === 'code') return '代码';
  if (cell.cell_type === 'markdown') return 'MD';
  return 'RAW';
}

/**
 * 渲染输出区 HTML(流/错误/富输出)。
 *
 * 没有输出时返回空串 —— 笔记本靠留白分隔格子,每格下面挂一行灰字提示
 * "无输出"整页看下来全是噪音。配套 CSS:`.lgp-nb__outs:empty` 不显示。
 * text/markdown 输出走异步渲染,这里只放占位容器(data-md 编码载荷)。
 */
export function renderOutputsHTML(cell: NbCell): string {
  const outs = Array.isArray(cell.outputs) ? cell.outputs : [];
  if (outs.length === 0) return '';
  const parts: string[] = [];
  for (const out of outs) {
    const type = String((out as { output_type?: string })?.output_type ?? '');
    const o = out as Record<string, unknown>;
    if (type === 'stream') {
      parts.push(
        `<pre class="lgp-nb__out lgp-nb__out--stream">${escapeHTML(stripANSI(mimeText(o.text)))}</pre>`,
      );
      continue;
    }
    if (type === 'error') {
      const tb = Array.isArray(o.traceback) ? (o.traceback as unknown[]).join('\n') : String(o.traceback ?? '');
      parts.push(
        `<div class="lgp-nb__out lgp-nb__out--error"><div class="lgp-nb__err-name">${escapeHTML(
          String(o.ename ?? 'Error'),
        )}: ${escapeHTML(String(o.evalue ?? ''))}</div><pre>${escapeHTML(stripANSI(tb))}</pre></div>`,
      );
      continue;
    }
    const data = o?.data as Record<string, unknown> | undefined;
    if ((type === 'execute_result' || type === 'display_data') && data) {
      // 按显示优先级挑 MIME
      const pick = (mime: string): string | null => (data[mime] !== undefined ? mime : null);
      const mime =
        pick('image/png') || pick('image/jpeg') || pick('image/gif') ||
        pick('image/svg+xml') || pick('text/markdown') || pick('text/html') ||
        pick('application/json') || pick('text/plain');
      if (!mime) continue;
      const value = data[mime];
      if (mime.startsWith('image/')) {
        const b64 = mimeText(value).replace(/\s/g, '');
        parts.push(`<div class="lgp-nb__out lgp-nb__out--img"><img src="data:${mime};base64,${b64}" /></div>`);
      } else if (mime === 'text/markdown') {
        parts.push(`<div class="lgp-nb__out lgp-nb__out--md" data-md="${encodeURIComponent(mimeText(value))}"></div>`);
      } else if (mime === 'text/html') {
        // 沙箱 iframe(禁脚本),防恶意笔记本注入
        parts.push(
          `<iframe class="lgp-nb__out lgp-nb__out--html" sandbox="" srcdoc="${escapeHTML(mimeText(value))}"></iframe>`,
        );
      } else if (mime === 'application/json') {
        let pretty: string;
        try {
          pretty = JSON.stringify(typeof value === 'string' ? JSON.parse(mimeText(value)) : value, null, 2);
        } catch {
          pretty = mimeText(value);
        }
        parts.push(`<pre class="lgp-nb__out">${escapeHTML(pretty)}</pre>`);
      } else {
        parts.push(`<pre class="lgp-nb__out">${escapeHTML(mimeText(value))}</pre>`);
      }
      continue;
    }
    // 未知输出类型跳过
  }
  // 有 outputs 但全是渲染不了的类型:同样返回空串(容器 :empty 隐藏)
  return parts.join('');
}

/**
 * 把一次执行的结果翻译成 nbformat 4 的 outputs 数组。
 *
 * 为什么严格按规范写:存盘后用户可能用 Jupyter / VS Code 打开这个 ipynb,
 * 字段形状不对就会显示异常。顺序按 Jupyter 的惯例:先 stream(输出)、
 * 再 execute_result(末尾表达式求值结果)、最后 error。
 */
export function outcomeToOutputs(o: {
  stdout: string;
  stderr: string;
  result?: string;
  richData?: Record<string, string>;
  error?: { ename: string; evalue: string; traceback: string[] };
  executionCount: number;
}): unknown[] {
  const outs: unknown[] = [];
  // stdout / stderr 各自合成一条 stream
  // (nbformat 的 stream 用 name 区分 stdout/stderr,不能合成一条)
  if (o.stdout) outs.push({ output_type: 'stream', name: 'stdout', text: o.stdout });
  if (o.stderr) outs.push({ output_type: 'stream', name: 'stderr', text: o.stderr });

  const KNOWN_MIMES = new Set([
    'text/plain', 'text/html', 'text/markdown', 'image/png',
    'image/jpeg', 'image/gif', 'image/svg+xml', 'application/json',
  ]);

  // 末表达式结果:有富媒体 mime 就整份存(图片 base64 等),
  // 补一个 text/plain 兜底给不支持富媒体的阅读器
  if (o.richData && Object.keys(o.richData).length > 0) {
    const data: Record<string, string> = {};
    let kept = 0;
    for (const [mime, val] of Object.entries(o.richData)) {
      if (mime === 'text/plain' || KNOWN_MIMES.has(mime)) {
        data[mime] = val;
        kept++;
      }
    }
    if (kept > 0) {
      if (data['text/plain'] === undefined && o.result !== undefined) {
        data['text/plain'] = o.result;
      }
      outs.push({ output_type: 'execute_result', execution_count: o.executionCount, data, metadata: {} });
    }
  } else if (o.result !== undefined && o.result !== null) {
    outs.push({
      output_type: 'execute_result',
      execution_count: o.executionCount,
      data: { 'text/plain': o.result },
      metadata: {},
    });
  }

  if (o.error) {
    outs.push({
      output_type: 'error',
      ename: o.error.ename,
      evalue: o.error.evalue,
      // traceback 必须是非空字符串数组,空数组会让部分阅读器渲染出空白
      traceback: o.error.traceback?.length ? o.error.traceback : [`${o.error.ename}: ${o.error.evalue}`],
    });
  }
  return outs;
}
