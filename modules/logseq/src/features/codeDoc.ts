// 代码文件 → 虚拟 Logseq 文档 的切分器/重建器(混合编辑模式的核心)。
//
// 模型:代码文件按行扫描出三类区域,映射为虚拟文档的块:
//   1. 整行注释(连续的合并为一个块,含中间空行)→ Logseq 块,
//      块文本 = 原文行逐字保留(含 `# ` 前缀与缩进)——自描述,重建逐字输出;
//   2. 块注释 /* */ 与 docstring """ ''' → 整段一个 Logseq 块,定界符同样
//      保留在块文本里(Enter 拆分后重建仍逐字,无损);
//   3. 代码段(其余行,含行内注释)→ 围栏块(```lang ... ```),由块编辑器的
//      代码编辑器(Monaco)编辑;重建时剥掉围栏还原。
// 重建 = 依序输出:围栏块剥围栏、其余逐字 —— 未编辑文件字节级无损。
//
// 边界(v1):行内注释不拆块(一行 = 半代码半注释,拆两个编辑器会破坏
// 行对应关系);纯空行串不算注释块(归入代码段,避免面板出现空 Logseq 块)。
// 注释行的**前导缩进逐字保留**(见 toOutlineDocText 的「缩进往返」)。

/** 每语言的整行注释前缀(行首缩进后匹配) */
const LINE_MARKERS: Record<string, string[]> = {
  python: ['#'],
  ruby: ['#'],
  shell: ['#'],
  bash: ['#'],
  yaml: ['#'],
  toml: ['#'],
  r: ['#'],
  perl: ['#'],
  julia: ['#'],
  elixir: ['#'],
  nginx: ['#'],
  properties: ['#', '!'],
  javascript: ['//'],
  typescript: ['//'],
  java: ['//'],
  c: ['//'],
  cpp: ['//'],
  csharp: ['//'],
  go: ['//'],
  rust: ['//'],
  swift: ['//'],
  kotlin: ['//'],
  scala: ['//'],
  dart: ['//'],
  objectivec: ['//'],
  php: ['//', '#'],
  less: ['//'],
  scss: ['//'],
  sql: ['--'],
  lua: ['--'],
  haskell: ['--'],
  ini: [';', '#'],
  erlang: ['%'],
  powershell: ['#'],
};

/** 每语言的块注释/docstring 定界符(开、闭);按行首(缩进后)匹配开标记 */
const BLOCK_MARKERS: Record<string, Array<[string, string]>> = {
  javascript: [['/*', '*/']],
  typescript: [['/*', '*/']],
  java: [['/*', '*/']],
  c: [['/*', '*/']],
  cpp: [['/*', '*/']],
  csharp: [['/*', '*/']],
  go: [['/*', '*/']],
  rust: [['/*', '*/']],
  swift: [['/*', '*/']],
  kotlin: [['/*', '*/']],
  scala: [['/*', '*/']],
  dart: [['/*', '*/']],
  objectivec: [['/*', '*/']],
  php: [['/*', '*/']],
  css: [['/*', '*/']],
  scss: [['/*', '*/']],
  less: [['/*', '*/']],
  python: [['"""', '"""'], ["'''", "'''"]],
  html: [['<!--', '-->']],
  xml: [['<!--', '-->']],
  markdown: [['<!--', '-->']],
};

export type CodeDocBlockKind = 'text' | 'code';

/** 虚拟文档的一个块 */
export interface CodeDocBlock {
  kind: CodeDocBlockKind;
  /**
   * kind=text:原文行(注释行含标记与缩进;块注释/docstring 含定界符)逐字;
   * kind=code:围栏包裹的块文本(```lang\n 代码 \n```)。
   */
  text: string;
  /** 块在源文件中的起始行(1 基);代码段用它显示真实行号 */
  startLine: number;
}

/** 混合编辑视图的一个区:code = 剥围栏后的代码行;text = 注释行原文 */
export interface HybridRegion {
  kind: CodeDocBlockKind;
  lines: string[];
  startLine: number;
}

/**
 * buildCodeDoc 的混合视图直接消费形态:code 区剥掉合成围栏取内部行。
 * 挂载与「注释标记增删后的动态重切分」共用 —— 保证两种路径得到同一种布局。
 */
export function toHybridRegions(text: string, lang: string): HybridRegion[] {
  return buildCodeDoc(text, lang).map((b) => {
    if (b.kind === 'code') {
      const lines = b.text.split('\n');
      // 首行是 ```lang 围栏,末行(若非首行)是闭围栏(与 reconstructFromDoc 同规则)
      const inner = lines.slice(1, lines.length > 1 ? -1 : undefined);
      return { kind: 'code' as const, lines: inner, startLine: b.startLine };
    }
    return { kind: 'text' as const, lines: b.text.split('\n'), startLine: b.startLine };
  });
}

function markersFor(lang: string): { line: string[]; block: Array<[string, string]> } {
  const key = lang.toLowerCase();
  return {
    line: LINE_MARKERS[key] ?? [],
    block: BLOCK_MARKERS[key] ?? [],
  };
}

/** 该行(去掉行首缩进)是否以某个整行注释标记开头 */
function isLineComment(trimmed: string, markers: string[]): boolean {
  return markers.some((m) => trimmed.startsWith(m));
}

/** 该行是否为空/纯空白 */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * 把代码文件切分为虚拟文档块。
 *
 * 规则:
 *   - 整行注释连续出现(允许夹空行)合并为**一个** text 块;遇代码行结束;
 *     纯空行串不算注释块(归入代码段);
 *   - 块注释/docstring:开定界符起、闭定界符止,整段一个 text 块
 *     (定界符行原样保留在块文本里);
 *   - 其余行连续归入一个 code 块(围栏在构建时加上,长度按内容自适应,
 *     避免代码里出现 ``` 时提前闭合)。
 */
export function buildCodeDoc(text: string, lang: string): CodeDocBlock[] {
  const { line: lineMarkers, block: blockMarkers } = markersFor(lang);
  const lines = text.split('\n');

  const blocks: CodeDocBlock[] = [];
  let codeBuf: string[] = [];
  let codeStart = 0;

  const flushCode = (): void => {
    if (codeBuf.length === 0) return;
    blocks.push({ kind: 'code', text: wrapCodeFence(codeBuf.join('\n'), lang), startLine: codeStart });
    codeBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // --- 块注释 / docstring:开定界符起新 text 块,直到闭定界符 ---
    const bm = blockMarkers.find(([open]) => trimmed.startsWith(open));
    if (bm) {
      flushCode();
      const [open, close] = bm;
      const buf: string[] = [line];
      // 单行自闭合(如 /* x */)也整块保留
      if (!(trimmed.endsWith(close) && trimmed.length > open.length)) {
        i++;
        while (i < lines.length) {
          buf.push(lines[i]);
          if (lines[i].trim().endsWith(close)) break;
          i++;
        }
      }
      blocks.push({ kind: 'text', text: buf.join('\n'), startLine: i + 1 });
      continue;
    }

    // --- 整行注释:并入当前注释块(连续注释 + 夹空行 = 一个块)---
    if (isLineComment(trimmed, lineMarkers)) {
      flushCode();
      const i0 = i;
      const buf: string[] = [line];
      // 向后吞并:注释行或空行(空行仅当后续仍回到注释,否则空行留给代码段)
      let j = i + 1;
      let pendingBlanks: string[] = [];
      while (j < lines.length) {
        const t = lines[j].trim();
        if (isLineComment(t, lineMarkers)) {
          buf.push(...pendingBlanks, lines[j]);
          pendingBlanks = [];
          j++;
        } else if (isBlank(lines[j])) {
          pendingBlanks.push(lines[j]);
          j++;
        } else {
          break;
        }
      }
      // 悬空空行不属于注释块,退还给代码段
      i = j - 1;
      if (pendingBlanks.length) i -= pendingBlanks.length;
      blocks.push({ kind: 'text', text: buf.join('\n'), startLine: i0 + 1 });
      continue;
    }

    // --- 代码行(含纯空行)---
    if (codeBuf.length === 0) codeStart = i + 1;
    codeBuf.push(line);
  }
  flushCode();

  return blocks;
}

/**
 * 从虚拟文档块重建文件文本。
 *
 * 围栏块剥掉首尾围栏行还原代码段;其余块逐字输出。
 * 对未编辑的块,重建结果与原文件**字节级一致**。
 */
export function reconstructFromDoc(
  blocks: Array<{ kind: CodeDocBlockKind; text: string }>,
): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'code') {
      const lines = b.text.split('\n');
      // 首行是 ```lang 围栏,末行(若非首行)是闭围栏
      const inner = lines.slice(1, lines.length > 1 ? -1 : undefined);
      out.push(...inner);
    } else {
      out.push(...b.text.split('\n'));
    }
  }
  return out.join('\n');
}

/**
 * 把代码内容包进自适应围栏(围栏长度比内容里最长的反引号串至少长 1,且 ≥3)。
 * 切分器与混合视图的活编辑器同步共用 —— 保证 parseCodeFence 能读回。
 */
export function wrapCodeFence(content: string, lang: string): string {
  let maxRun = 0;
  for (const l of content.split('\n')) {
    const m = /^`+/.exec(l);
    if (m) maxRun = Math.max(maxRun, m[0].length);
  }
  const fence = '`'.repeat(Math.max(3, maxRun + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

/**
 * 虚拟文档块 → Logseq 大纲格式文本(供 parseDocument/块编辑器消费)。
 *
 * - 代码块:围栏文本逐字(解析器把围栏整体归为一个 raw 块,内部永不解析);
 * - 注释块:首行作为顶层列表项(`- ` + **原样保留缩进的行**),后续行缩进 +2
 *   空格 —— 解析器的软换行规则会把它们合并为**一个块**(appendSoftLine 会剥掉
 *   恰好一级缩进,重建逐字无损);块内空行写成缩进空行(解析器的 indented-blank
 *   分支保持块不闭合)。用列表项而非裸行:裸行 `# x` 会被解析器当 markdown
 *   标题(raw heading)渲染成大字标题,不符合代码注释的块观感;列表项则
 *   统一为普通 Logseq 块。
 * - 块与块之间写一个空行:解析器切分 raw 区的时机是「空行 + 下一个结构行」,
 *   且要求下一行 depth 0。空行是合成分隔符,重建时不落盘。
 *
 * 缩进往返(原 v1 边界,已修):以前首行要剥掉前导缩进(`strip`),因为列表项
 * 的 `- ` 之后必须紧跟内容;而代码文件里函数内的注释是缩进的,一保存就被拉到
 * 列 0 —— 等于插件改了用户的源文件。现在两端配合保留:parser 的 LIST_RE 只
 * 消费 `-` 后的一个空格(其余前导空白算内容),这里也不再剥,逐字往返。
 */
export function toOutlineDocText(blocks: CodeDocBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'code') {
      out.push(...b.text.split('\n'));
    } else {
      const lines = b.text.split('\n');
      if (lines.length === 0) continue;
      // 逐字保留前导缩进(见函数注释「缩进往返」):`- ` 之后的多余空格属于
      // 内容,LIST_RE 只消费标记后的那一个空格。
      out.push('- ' + lines[0]);
      for (let k = 1; k < lines.length; k++) {
        out.push(lines[k] === '' ? '  ' : '  ' + lines[k]);
      }
    }
    out.push('');
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
