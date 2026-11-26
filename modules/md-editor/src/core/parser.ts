/**
 * Markdown → Block tree parser (Logseq file format).
 *
 * Format rules (Logseq style):
 * - Outline blocks are nested `- ` list items, one tab per depth level.
 * - Task markers: `- TODO text`, `- DOING text`, `- DONE text`.
 * - Block properties are indented child lines: `  id:: uuid`, `  collapsed:: true`.
 * - Page properties: unindented `key:: value` lines at the top of the file.
 * - In-block soft line breaks: lines indented deeper than the block, not
 *   list/property lines, become extra lines of the block's text.
 * - Any non-list top-level content (headings, paragraphs, code fences,
 *   quotes, tables...) is preserved verbatim in `kind: 'raw'` blocks.
 * - Code fence interiors are never parsed as outline structure.
 *
 * 2-space indents are tolerated (1 unit); 4-space becomes depth 2 — the stack
 * model still attaches children to the correct parent, output is normalized
 * to tabs on serialize.
 *
 * Invariant: parse(serialize(parse(x))) deep-equals parse(x)  (normalizing round-trip).
 */

import { Block, Marker, MARKERS, ParsedDocument, addSrcLine, blockSemanticSig, createBlock, documentSemanticSig } from '../types';
import { getTaskListMarker } from './taskMarker';
import { normFoldKey } from './fold';

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
/**
 * A line that is nothing but a `$$` delimiter — the opening/closing marker of
 * an Obsidian/MathJax DISPLAY math block. `$$x$$` on one line is inline math
 * and deliberately does not match.
 */
const MATH_FENCE_RE = /^(\s*)\$\$[ \t]*$/;
const PROPERTY_RE = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.*)$/;
/**
 * 列表项。标记 `-` 后只消费**一个**空格(`\s` 而非 `\s+`),其余前导空白算内容。
 *
 * 用 `\s+` 会把 `-     # 注释` 的前导空格全吃掉,块文本变成 `# 注释`——
 * 混合编辑的代码文件里,函数内缩进的注释(`    # xxx`)经大纲往返就丢了缩进,
 * 一保存整段注释被拉到列 0(改了用户源文件)。
 *
 * 只吃一个空格后,`-   text` 里的多余空格属于内容,序列化照样原样写回,往返自洽。
 * 与续行一致:续行也是剥掉固定一级缩进、其余保留(stripIndent)。
 */
const LIST_RE = /^(\s*)-(?:\s(.*))?$/;
const MARKER_RE = new RegExp(`^(${MARKERS.join('|')})\\s+(.*)$`);
/**
 * Top-level lines that keep their verbatim raw rendering (markdown / org
 * structural syntax). Every OTHER plain top-level line becomes a first-level
 * PARAGRAPH container (bare block) — the SiYuan-style document model treats
 * the outline list as just one container kind; a paragraph is another.
 */
const STRUCTURAL_RAW_RE =
  /^(?:#{1,6}\s|#\+|>|\||<|%|\$\$|:|\d{1,9}[.)]\s|[*+]\s|(?:=+|\*+|_+|~+|\++)\s*$)/;

/**
 * True when the pending raw region ENDS at its last line, so a property line
 * about to arrive can only be that block's own property.
 *
 * A raw region is only ever fed STRUCTURAL lines, so reaching a non-closing
 * structural line does not mean the block goes on: a table's next line, a
 * quote's next line or a second heading all start a NEW region (the buffer is
 * flushed by the blank line or the caller). What must NOT qualify is a region
 * that can still swallow more content — an UNTERMINATED fence, where a
 * `key:: value` line really is code. So the check is positive: the last line
 * must close a construct, and an odd number of fence lines means "still open".
 */
function isRawRegionTail(region: string[]): boolean {
  let lastReal = '';
  for (const line of region) {
    if (line.trim() !== '') lastReal = line.trim();
  }
  if (lastReal === '') return false;
  if (/^`{3,}|^~{3,}/.test(lastReal)) {
    // A fence: the region is complete only when the fences pair up. An odd
    // count means the fence is still open, so following lines are its body.
    let fences = 0;
    for (const line of region) {
      if (/^`{3,}|^~{3,}/.test(line.trim())) fences++;
    }
    return fences % 2 === 0;
  }
  // `$$`, tables, quotes, headings, dividers: the line itself ends the block.
  return true;
}

/**
 * True when the raw region's last non-blank line opens an HTML element that
 * is not closed on that line (`<img src="x.png"` with the `>` on a later
 * line). While this holds, the following lines are CONTENT of that element,
 * not document structure: Word/OneNote exports routinely wrap `<img>` tags
 * across lines, and reading the tail as bare text made it a list block
 * whose serialization wrote `- style="..."` - the corrupted-image report.
 *
 * Only a line STARTING with `<` can open this state, so tables (`|`),
 * quotes (`>`), headings and `$$` regions can never trip it (math like
 * `x<y` lives on lines starting with `$$`, and a `$$...$$` region's last
 * line is its own closer). Quoted attribute values are stripped before
 * counting so a `>` inside `alt="a > b"` does not close the tag.
 */
function endsWithUnclosedHtmlTag(region: string[]): boolean {
  // Scan from the LAST line that starts with `<` (the element's opening
  // line). Lines after it can only be that element's continuation, so the
  // tag balance over this run decides the state. A region whose tail never
  // starts with `<` (a `$$...$$` closer, a table, a quote) is never inside
  // an element - that is what keeps math like `$$ x < y $$` out.
  let start = -1;
  for (let i = region.length - 1; i >= 0; i--) {
    if (/^</.test(region[i].trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return false;
  let open = 0;
  for (let i = start; i < region.length; i++) {
    const unquoted = region[i].replace(/"[^"]*"|'[^']*'/g, '');
    for (const ch of unquoted) {
      if (ch === '<') open++;
      else if (ch === '>') open--;
    }
  }
  return open > 0;
}

/** Property keys the parser re-attaches to a raw block (its fold state). */
function isFoldProperty(key: string): boolean {
  return normFoldKey(key) === 'collapsed';
}

/** Depth units: 1 tab = 1, 2 spaces = 1 (trailing odd space ignored). */
export function depthOf(line: string): number {
  let tabs = 0;
  let spaces = 0;
  for (const ch of line) {
    if (ch === '\t') tabs++;
    else if (ch === ' ') spaces++;
    else break;
  }
  return tabs + Math.floor(spaces / 2);
}

function leadingWs(line: string): string {
  return line.match(/^\s*/)?.[0] ?? '';
}

function parseMarker(content: string): { marker: Marker; text: string } {
  const m = MARKER_RE.exec(content);
  let marker: Marker = null;
  let text = content;
  if (m) {
    marker = m[1] as Exclude<Marker, null>;
    text = m[2];
  }
  return { marker, text };
}

/**
 * GFM 任务前缀剥离（仅 list 调用点——GFM 任务必须 list 形态，bare 段落
 * `[ ] x` 保持纯文本）。getTaskListMarker 的 contentStartIndex 只跳过 `[X]`
 * 三字符，标准写法 `[X] text` 在 `]` 后还有一个分隔空格，这里一并吃掉。
 */
function stripTaskPrefix(text: string): { text: string; task?: string } {
  const tm = getTaskListMarker(text, false);
  if (!tm) return { text };
  const rest = text.slice(tm.contentStartIndex);
  return { text: rest.startsWith(' ') ? rest.slice(1) : rest, task: tm.marker };
}

/** Strip `depth` tab-equivalents of leading indentation, preserving the rest (code indents!). */
export function stripIndent(line: string, depth: number): string {
  let rest = line;
  let d = depth;
  while (d > 0) {
    if (rest.startsWith('\t')) {
      rest = rest.slice(1);
      d--;
    } else if (rest.startsWith('  ')) {
      rest = rest.slice(2);
      d--;
    } else if (rest.startsWith(' ')) {
      rest = rest.slice(1);
      d--;
    } else {
      break;
    }
  }
  return rest;
}

/**
 * 空行渲染（2026-11-25，由「引述块之间的空行物化」推广到全文）。
 *
 * 用户诉求：空行要像原生编辑器/思源一样**渲染成一行可点击的空白**，而不是
 * 被块模型吞掉（打开文件只看到块挨着块）。做法：parser 记录的分隔空行
 * （块前的 `srcGap`、文件末尾的 `trailingGap`）每一条物化成一个空段落块
 * （bare，text ''）：
 *  - 渲染：`is-empty-line` CSS 给一行行高，点击即落焦点、可直接输入；
 *  - 序列化：空段落块走原文保真，写回原来的空行（含缩进/行尾空格）；
 *  - 重解析：空行仍在同一位置，物化回同一位置——树结构稳定。
 *
 * 位置 = 「下一块」所在的层级（空行作为它的前一个兄弟）；文件末尾的空行
 * 物化在顶层末尾。文档**首块之前**的空行不物化：页面属性块/frontmatter
 * 必须是 blocks[0]（否则页面属性语义丢失），文件头的空行也极少需要编辑。
 */
function materializeBlankLines(doc: ParsedDocument): void {
  const blank = (line: string, parent: Block | null): Block => {
    const b = createBlock(''); // 空段落块：序列化不写 `- ` 标记
    b.bare = true;
    b.parent = parent;
    // 原文保真：空行的精确字节（缩进/行尾空格）挂在 srcLines 上，未编辑时原样写回。
    b.srcLines = [line];
    return b;
  };
  const walk = (nodes: Block[], parent: Block | null, isTop: boolean): Block[] => {
    const out: Block[] = [];
    nodes.forEach((b, idx) => {
      // 首块的块前空行保留在 srcGap（见上）。
      if (!(isTop && idx === 0) && b.srcGap && b.srcGap.length > 0) {
        for (const line of b.srcGap) out.push(blank(line, parent));
        b.srcGap = [];
      }
      b.parent = parent;
      b.children = walk(b.children, b, false);
      out.push(b);
    });
    return out;
  };
  doc.blocks = walk(doc.blocks, null, true);
  // 文件末尾的空行：物化在顶层末尾。空文件（没有块）保持原样——编辑器自己
  // 创建首块，不在这里造空段落。
  //
  // 注意 split('\n') 的最后一个元素是「文件以换行结尾」的产物，不是真实的空行
  // （`a\n` 只有一行；`a\n\n` 才有一条空行）。它留给 trailingNewline 处理，
  // 否则末尾空行物化出的空段落块会假装成一行，追加内容时多一行。
  if (doc.blocks.length > 0 && doc.trailingGap && doc.trailingGap.length > 0) {
    const count = doc.trailingNewline ? Math.max(0, doc.trailingGap.length - 1) : doc.trailingGap.length;
    for (let k = 0; k < count; k++) doc.blocks.push(blank(doc.trailingGap[k], null));
    doc.trailingGap = [];
  }
}

export function parseDocument(md: string): ParsedDocument {
  // CRLF (Windows) files: every parser regex below is `$`-anchored and `.`
  // never matches `\r`, so a trailing `\r` silently breaks fence open/close,
  // list and property detection (a CRLF file parsed raw explodes — fences
  // leak their bodies as bare lines). Normalize once up front; serialize
  // restores the file's own endings via the crlf flag.
  const crlf = /\r/.test(md);
  const lines = (crlf ? md.replace(/\r\n?/g, '\n') : md).split('\n');
  const doc: ParsedDocument = { frontmatter: '', pageProps: '', blocks: [], sourceText: md };
  if (crlf) doc.crlf = true;
  // Indentation unit: tab-evidence lines vs 2-space-evidence lines (Logseq
  // exports indent with two spaces). Majority wins; ties default to tab.
  let tabLines = 0;
  let spaceLines = 0;
  for (const ln of lines) {
    if (/^\t/.test(ln)) tabLines++;
    else if (/^ {2}\S/.test(ln)) spaceLines++;
  }
  if (spaceLines > tabLines) doc.indentUnit = '  ';
  if (/\n$/.test(md)) doc.trailingNewline = true;
  let i = 0;

  // 原文保真(2026-11-25)：块与块之间的空行（纯分隔行，可能含行尾空格）。
  // 空行不属于任何块，但丢掉就是改用户文件——存给「下一个块」，序列化时
  // 原样吐回。文件末尾剩下的就是 trailingGap。
  let gapBuf: string[] = [];

  /** 取走当前累计的分隔空行（交给即将创建的块）。 */
  const takeGap = (): string[] => {
    const g = gapBuf;
    gapBuf = [];
    return g;
  };

  // --- frontmatter ---
  if ((lines[0] ?? '').trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j < lines.length) {
      i = j + 1;
      // Obsidian-format page properties: the frontmatter body becomes the
      // page-properties first block (edited as `key: value` lines, written
      // back as frontmatter — the Obsidian format is preserved verbatim,
      // including lists, comments and key order).
      const bodyLines = lines.slice(1, j);
      const fmBlock = createBlock(bodyLines.join('\n'), null);
      fmBlock.frontmatter = true;
      fmBlock.parent = null;
      // 原文保真：围栏行与正文逐字节照抄（YAML 里的行尾空格、缩进都不动）。
      fmBlock.srcLines = ['---', ...bodyLines, '---'];
      for (const bl of bodyLines) {
        const pm = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(bl);
        if (pm) fmBlock.props[pm[1]] = pm[2].replace(/^ /, '');
      }
      doc.blocks.push(fmBlock);
    }
  }

  // --- page properties (unindented `key:: value` before any block) ---
  // 原文保真：属性段自己拥有的行（属性行 + 段内空行）。段前的空行进
  // gapBuf（属于属性块），段后的空行留给下一块——不能记到属性块头上。
  const pagePropSrc: string[] = [];
  const pagePropLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      // 只有「后面还有属性行」才是属性段内部的空行；否则是块间分隔。
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const next = j < lines.length ? lines[j] : '';
      if (pagePropLines.length > 0 && next && depthOf(next) === 0 && PROPERTY_RE.test(next.trim())) {
        pagePropSrc.push(line);
        i++;
        continue;
      }
      if (pagePropLines.length === 0) {
        gapBuf.push(line);
        i++;
        continue;
      }
      break; // 段后的空行留给主循环（下一块的 srcGap）
    }
    if (depthOf(line) === 0 && PROPERTY_RE.test(line.trim())) {
      pagePropLines.push(line);
      pagePropSrc.push(line);
      i++;
    } else {
      break;
    }
  }
  doc.pageProps = pagePropLines.join('\n');
  if (pagePropLines.length > 0) {
    // Logseq model: page properties are the page's FIRST block (a block
    // holding only `key:: value` lines). It renders as a regular outline
    // item and is serialized back to the unindented file-top lines.
    const propsBlock = createBlock('', null);
    for (const pl of pagePropLines) {
      const pm = PROPERTY_RE.exec(pl.trim());
      if (pm) propsBlock.props[pm[1]] = pm[2];
    }
    propsBlock.parent = null;
    propsBlock.srcLines = pagePropSrc;
    propsBlock.srcGap = takeGap();
    doc.blocks.push(propsBlock);
    doc.pageProps = '';
  }

  // --- main loop ---
  // stack[d] = most recent block whose real depth is d. Roots live in doc.blocks.
  const stack: Block[] = [];
  let lastBlock: Block | null = null; // most recent 'list' block (property / soft-line target)
  let rawBuf: string[] = [];
  let bareBuf: string[] = []; // consecutive bare lines → ONE first-level block
  let bareSrcBuf: string[] = []; // 对应的原文行（未 trim），原文保真用
  const flushRaw = () => {
    // 尾部的空行是分隔行（raw 区之后、下一块之前），不能当成 raw 的内容——
    // 它们属于「下一块」的 srcGap。先摘出来，等块建好后再入 gapBuf。
    const tail: string[] = [];
    while (rawBuf.length > 0 && rawBuf[rawBuf.length - 1].trim() === '') tail.unshift(rawBuf.pop() as string);
    if (rawBuf.length === 0) {
      gapBuf.push(...tail);
      return;
    }
    const b = createBlock();
    b.kind = 'raw';
    b.text = rawBuf.join('\n');
    b.parent = null;
    // 原文保真：逐行照抄（含代码/表格里被 parser trim 掉的缩进与尾空格）。
    for (const ln of rawBuf) addSrcLine(b, ln);
    b.srcGap = takeGap();
    doc.blocks.push(b);
    gapBuf.push(...tail);
    rawBuf = [];
  };

  /** Emit the pending run of bare lines as ONE first-level list block. */
  const flushBare = () => {
    if (bareBuf.length === 0) return;
    const { marker, text } = parseMarker(bareBuf[0]);
    const b = createBlock([text, ...bareBuf.slice(1)].join('\n'), marker);
    // 段落容器:没有列表标志、也没有任务标记的裸文本行。带 marker 的裸行
    // (`TODO x`)语义上是任务项,保持列表容器(显示圆点 + 复选框)。
    if (marker === null) b.bare = true;
    b.parent = null;
    // 原文保真：bare 行原文（未 trim）。首行可能含 TODO marker，原文照抄。
    for (const ln of bareSrcBuf) addSrcLine(b, ln);
    b.srcGap = takeGap();
    doc.blocks.push(b);
    stack.length = 0;
    stack.push(b);
    lastBlock = b;
    bareBuf = [];
    bareSrcBuf = [];
  };

  const appendSoftLine = (block: Block, line: string) => {
    block.text += '\n' + stripIndent(line, realDepth(block) + 1);
    addSrcLine(block, line); // 原文保真
  };

  const realDepth = (b: Block): number => {
    let d = 0;
    let p = b.parent;
    while (p) {
      d++;
      p = p.parent;
    }
    return d;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Empty line: separator outside raw, verbatim inside raw. A blank line
    // also ends a run of bare lines (each blank-separated run is its own block).
    if (line.trim() === '') {
      if (bareBuf.length > 0) flushBare();
      // An INDENTED blank line inside an open block, with further soft lines
      // of the same block following, is an EMPTY SOFT LINE (the gap in a
      // $$…$$ math block). Dropping it deleted the line users navigate into.
      const blankDepth = depthOf(line);
      if (rawBuf.length === 0 && blankDepth >= 1 && lastBlock && blankDepth >= realDepth(lastBlock) + 1) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const next = j < lines.length ? lines[j] : '';
        if (next && depthOf(next) >= realDepth(lastBlock) + 1) {
          appendSoftLine(lastBlock, line);
          i++;
          continue;
        }
      }
      if (rawBuf.length > 0) {
        // A blank line inside an unclosed HTML element is that element's
        // content - keep it verbatim; the flush lookahead below would read
        // past the open tag and end the region early.
        if (endsWithUnclosedHtmlTag(rawBuf)) {
          rawBuf.push(line);
          i++;
          continue;
        }
        // A blank line ends a verbatim region when the region is closed AND
        // the next non-blank line starts a NEW structural construct (a fence,
        // a table, a heading, a quote). That is what lets a heading, a code
        // fence and a table each be folded on their own instead of collapsing
        // into one giant raw block.
        //
        // Two guards, both load-bearing:
        //  - `isRawRegionTail` pairs the fences, so a blank line INSIDE a fence
        //    or a $$…$$ block stays content, and a `key:: value` line inside
        //    an unterminated fence stays code.
        //  - The lookahead: the next non-blank line must be able to START a
        //    structural block. `STRUCTURAL_RAW_RE` alone is not enough — it
        //    does not match a code fence (that is `FENCE_OPEN_RE`), so without
        //    this a heading followed by a fence stayed ONE block and the two
        //    could not be folded separately. A PROPERTY line must not split at
        //    all: `key:: value` under a block is that block's property (where
        //    the fold flag lives), and splitting there would drop the block
        //    into page-property territory and reorder the file.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const next = j < lines.length ? lines[j] : '';
        const nextTrim = next.trim();
        const startsStructure =
          STRUCTURAL_RAW_RE.test(nextTrim) || FENCE_OPEN_RE.test(next);
        if (next && isRawRegionTail(rawBuf) && depthOf(next) === 0 && startsStructure && !PROPERTY_RE.test(nextTrim)) {
          flushRaw();
          // 原文保真：这是两个块之间的分隔空行——记给下一块，不丢。
          gapBuf.push(line);
          i++;
          continue;
        }
        // raw 区内部的空行(verbatim 内容)
        rawBuf.push(line);
        i++;
        continue;
      }
      // 原文保真：纯分隔空行（含只有空格的行），原样留给下一块。
      gapBuf.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const depth = depthOf(line);
    // A pending bare group is an implicit last block: indented lines and
    // fences after it belong to it, just like they belong to a list block.
    if (bareBuf.length > 0 && depth >= 1) flushBare();

    // --- Multi-line HTML element continuation ---
    // A pending raw region whose tail opens an unclosed tag (`<img src="a.png"`)
    // swallows the line as its content, whatever it looks like: `style="..."`
    // is NOT a bare document line, and treating it as one made the editor
    // split the element and serialize the tail as `- style="..."`.
    if (rawBuf.length > 0 && endsWithUnclosedHtmlTag(rawBuf)) {
      rawBuf.push(line);
      i++;
      continue;
    }

    // --- Code fence handling ---
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      // A fence belongs to the last block when indented past its content
      // column (depth >= realDepth + 1) OR at the same depth as its marker
      // (depth > 0). Logseq exports and cleanup tools write same-depth
      // fences; hoisting those to root raw blocks would serialize them after
      // the whole tree — every code block jumping to the bottom of the file.
      const belongsToBlock =
        lastBlock !== null &&
        (depth >= realDepth(lastBlock) + 1 || (depth >= realDepth(lastBlock) && depth > 0));
      if (belongsToBlock && lastBlock) {
        // In-block fence: everything until the closing fence is block text.
        const prefix = leadingWs(line);
        lastBlock.text += '\n' + stripIndent(line, realDepth(lastBlock) + 1);
        addSrcLine(lastBlock, line); // 原文保真：fence opening
        i++;
        let closed = false;
        while (i < lines.length) {
          const cl = lines[i];
          const cTrim = cl.trim();
          // closing fence: same char run, no info string
          if (FENCE_OPEN_RE.test(cl) && cTrim.replace(/[`\s~]/g, '') === '') {
            lastBlock.text += '\n' + (cl.startsWith(prefix) ? cl.slice(prefix.length) : cTrim);
            addSrcLine(lastBlock, cl);
            i++;
            closed = true;
            break;
          }
          lastBlock.text += '\n' + (cl.startsWith(prefix) ? cl.slice(prefix.length) : cl.trimStart());
          addSrcLine(lastBlock, cl); // 原文保真：fence body
          i++;
        }
        // unterminated fence: swallowed to EOF — acceptable
        if (!closed) break;
        continue;
      }
      // Top-level fence → raw content (consume whole fence verbatim)
      flushBare();
      rawBuf.push(line);
      i++;
      while (i < lines.length) {
        const cl = lines[i];
        rawBuf.push(cl);
        i++;
        if (FENCE_OPEN_RE.test(cl) && cl.trim().replace(/[`\s~]/g, '') === '') break;
      }
      continue;
    }

    // --- Display math fence (`$$` on its own line) ---
    // `$$` matches STRUCTURAL_RAW_RE, but the LaTeX body between the
    // delimiters usually does NOT (a bare `\nabla f(x,y)=...` line is an
    // ordinary top-level line). Without this branch the parser emitted three
    // sibling blocks — raw `$$`, bare formula, raw `$$` — so the renderer saw
    // a lone delimiter and a naked formula string instead of one math block.
    if (MATH_FENCE_RE.test(line)) {
      // Same ownership rule as a code fence: indented past the parent block's
      // content column (or same-depth with depth > 0) the math belongs to that
      // block; otherwise it is verbatim top-level raw content.
      const mathBelongsToBlock =
        lastBlock !== null &&
        (depth >= realDepth(lastBlock) + 1 || (depth >= realDepth(lastBlock) && depth > 0));
      if (mathBelongsToBlock && lastBlock) {
        // In-block math: every line until the closing `$$` joins the block
        // text, dedented to the block's content column.
        const mPrefix = leadingWs(line);
        lastBlock.text += '\n' + stripIndent(line, realDepth(lastBlock) + 1);
        addSrcLine(lastBlock, line); // 原文保真：math opening
        i++;
        while (i < lines.length) {
          const cl = lines[i];
          const closed = MATH_FENCE_RE.test(cl);
          lastBlock.text += '\n' + (cl.startsWith(mPrefix) ? cl.slice(mPrefix.length) : cl.trimStart());
          addSrcLine(lastBlock, cl); // 原文保真：math body
          i++;
          if (closed) break;
        }
        continue;
      }
      // Top-level math → one raw block holding the whole `$$…$$` region.
      flushBare();
      rawBuf.push(line);
      i++;
      while (i < lines.length) {
        const cl = lines[i];
        rawBuf.push(cl);
        i++;
        if (MATH_FENCE_RE.test(cl)) break;
      }
      continue;
    }

    // --- List item ---
    const listMatch = LIST_RE.exec(line);
    if (listMatch) {
      flushRaw();
      flushBare();
      const content = listMatch[2] ?? '';
      const { marker, text } = parseMarker(content);
      const { text: blockText, task } = stripTaskPrefix(text);
      const b = createBlock(blockText, marker);
      if (task !== undefined) b.task = task;
      // 原文保真：own line 逐字节照抄（缩进、`- `、尾空格全保留）。
      addSrcLine(b, line);
      b.srcGap = takeGap();
      // Find parent: truncate stack to depth-1 ancestors.
      let parent: Block | null = null;
      if (depth > 0 && stack.length > 0) {
        const parentIdx = Math.min(depth - 1, stack.length - 1);
        parent = stack[parentIdx];
      }
      if (parent) {
        b.parent = parent;
        parent.children.push(b);
        // normalize real depth = parent depth + 1
        stack.length = parentIdxOf(stack, parent) + 1;
        stack.push(b);
      } else {
        b.parent = null;
        doc.blocks.push(b);
        stack.length = 0;
        stack.push(b);
      }
      lastBlock = b;
      i++;
      // `- ```sql` — a list item can open a code fence. Its body belongs to
      // the block even when it is not indented; without this the closing fence
      // and every following line would be swallowed into one raw block.
      const openFence = FENCE_OPEN_RE.exec(text);
      if (openFence && !openFence[3].includes(openFence[2])) {
        i = consumeFenceBody(b, lines, i, openFence[2], depth);
      }
      continue;
    }

    // --- Property line ---
    const propMatch = PROPERTY_RE.exec(trimmed);
    if (propMatch) {
      // A property right after bare lines belongs to the block they form.
      flushBare();
      if (lastBlock && depth >= realDepth(lastBlock) + 1) {
        lastBlock.props[propMatch[1]] = propMatch[2];
        addSrcLine(lastBlock, line); // 原文保真：props 行照抄（缩进不被规范化）
      } else if (rawBuf.length > 0) {
        // Unindented property line closing a RAW region belongs to that block,
        // exactly like a list block's `key:: value` lines. This is how a
        // verbatim block records its fold state: the serializer cannot write
        // props INSIDE the text (a raw block is emitted verbatim) and a
        // property line inside a fence would be read back as code, so the
        // flag is written below the block and re-attached here.
        //
        // The pending region is flushed FIRST, so the block this line belongs
        // to exists — it is still unflushed at this point (a blank line or the
        // next structural line would have flushed it), and its tail is the line
        // just before this property.
        //
        // Only a fold flag re-attaches. Any other key stays verbatim: a
        // `key:: value` line under a table or inside prose is content, and
        // silently promoting it to a property would move the user's text.
        if (rawBuf.length > 0 && isFoldProperty(propMatch[1]) && isRawRegionTail(rawBuf)) {
          flushRaw();
          const raw = doc.blocks[doc.blocks.length - 1];
          if (raw && raw.kind === 'raw') {
            raw.props[propMatch[1]] = propMatch[2];
            addSrcLine(raw, line); // 原文保真：raw 的 fold props 行
          }
          i++;
          continue;
        }
        // Unindented property inside a raw region: keep verbatim.
        rawBuf.push(line);
      } else if (lastBlock) {
        // Unindented property right after blocks: tolerate, attach to last block.
        lastBlock.props[propMatch[1]] = propMatch[2];
        addSrcLine(lastBlock, line); // 原文保真
      } else {
        pagePropLines.push(line);
        doc.pageProps = pagePropLines.join('\n');
      }
      i++;
      continue;
    }
    // --- Deeper non-list line: soft line of last block ---
    if (lastBlock && depth >= realDepth(lastBlock) + 1) {
      appendSoftLine(lastBlock, line);
      i++;
      continue;
    }

    // Markdown/org structural lines keep their verbatim raw rendering.
    if (depth > 0 || STRUCTURAL_RAW_RE.test(trimmed)) {
      flushBare();
      // A structural line (table/quote/fence) at the LAST BLOCK's own marker
      // depth is that block's soft content — Logseq exports tables aligned
      // with the item's marker column. The old root-detach pushed the table
      // after the whole subtree (the "table at the file bottom" report) and
      // the leftover indent rendered it as a code block instead of a table.
      if (
        rawBuf.length === 0 &&
        lastBlock &&
        depth === realDepth(lastBlock) &&
        depth > 0 &&
        STRUCTURAL_RAW_RE.test(trimmed)
      ) {
        appendSoftLine(lastBlock, line);
        i++;
        continue;
      }
      // A structural line that EXITS the current subtree (shallower than the
      // open block chain) stays IN POSITION as the previous parsed block's
      // raw content — the old root-detach serialized it after the whole
      // subtree (the "math block at the file bottom" report). Parsing then
      // continues normally with whatever follows.
      if (rawBuf.length === 0 && lastBlock && stack.length > 0 && stack.length - 1 > depth) {
        appendSoftLine(lastBlock, line);
        i++;
        continue;
      }
      // An EMPTY quote line (`>` with no content) is an empty quote BLOCK
      // (the user's terms: `>` with no content is an empty quote block, NOT
      // an empty line). Pushing it like any other structural line keeps the
      // quote run in one block when adjacent, and a `>` separated from every
      // quote stays its own block — rendered as a quote block with the CSS
      // min-height row. Blank lines BETWEEN quote blocks are the rendered
      // empty lines: materializeQuoteBlankLines turns those into empty
      // paragraph blocks (see that function).
      rawBuf.push(line);
      i++;
      continue;
    }

    // --- Top-level plain line: accumulate into ONE first-level block ---
    // Consecutive bare lines (no blank line between them) form a single
    // first-level list block; saving normalizes it to `- ` + soft lines.
    // A bare line that EXITS the current subtree stays IN POSITION as the
    // previous parsed block's raw content (the order-preservation rule).
    flushRaw();
    if (lastBlock && stack.length > 0 && stack.length - 1 > depth) {
      appendSoftLine(lastBlock, line);
      i++;
      continue;
    }
    bareBuf.push(trimmed);
    bareSrcBuf.push(line);
    i++;
  }

  flushRaw();
  flushBare();
  // 原文保真：最后一个块之后剩下的空行（含结尾换行）原样记录，
  // 序列化时拼回——`a\n\n` 不会被折成 `a\n`。
  doc.trailingGap = gapBuf;
  materializeBlankLines(doc);
  // 原文保真：解析完成后给每个块盖语义快照。有 srcLines 且快照匹配的块
  // 序列化时直接吐原文行；新造块（如引用间空段落）无 srcLines，自然走正常序列化。
  const stamp = (nodes: Block[]): void => {
    for (const b of nodes) {
      b.srcSig = blockSemanticSig(b);
      stamp(b.children);
    }
  };
  stamp(doc.blocks);
  // 整树签名：保存时若树没动过，serializeDocument 直接返回 sourceText。
  doc.parseTreeSig = documentSemanticSig(doc.blocks);
  return doc;
}

/**
 * Consume the body of a fence opened by a list item (`- ```sql`) into the
 * block's text, stopping after the closing fence. Returns the new line index.
 * Body lines are dedented to the block's content column (`depth` markers + 1
 * unit — Logseq's convention) so column-indented code renders flush while any
 * deeper indentation stays as the code's own internal indent.
 */
function consumeFenceBody(b: Block, lines: string[], i: number, fenceRun: string, depth: number): number {
  const run = fenceRun[0];
  while (i < lines.length) {
    const cl = lines[i];
    const fm = FENCE_OPEN_RE.exec(cl);
    if (fm && fm[2][0] === run && fm[2].length >= fenceRun.length && fm[3].trim() === '') {
      b.text += '\n' + fm[2];
      addSrcLine(b, cl); // 原文保真：fence closing
      return i + 1;
    }
    b.text += '\n' + stripIndent(cl, depth + 1);
    addSrcLine(b, cl); // 原文保真：fence body
    i++;
  }
  return i; // unterminated fence: swallow to EOF
}

function parentIdxOf(stack: Block[], parent: Block): number {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k] === parent) return k;
  }
  return stack.length - 1;
}
