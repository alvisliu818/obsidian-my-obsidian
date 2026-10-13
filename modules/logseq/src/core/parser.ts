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

import { Block, Marker, MARKERS, ParsedDocument, createBlock } from '../types';
import { normFoldKey } from './fold';

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
/**
 * A line that is nothing but a `$$` delimiter — the opening/closing marker of
 * an Obsidian/MathJax DISPLAY math block. `$$x$$` on one line is inline math
 * and deliberately does not match.
 */
const MATH_FENCE_RE = /^(\s*)\$\$[ \t]*$/;
const PROPERTY_RE = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.*)$/;
const LIST_RE = /^(\s*)-(?:\s+(.*))?$/;
const MARKER_RE = new RegExp(`^(${MARKERS.join('|')})\\s+(.*)$`);
/**
 * Top-level lines that keep their verbatim raw rendering (markdown / org
 * structural syntax). Every OTHER plain top-level line becomes a first-level
 * list item — the outline owns bare text lines (Logseq parity); saving
 * normalizes them to `- ` items.
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
  if (m) return { marker: m[1] as Exclude<Marker, null>, text: m[2] };
  return { marker: null, text: content };
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

export interface ParseOptions {
  /**
   * 保真模式：不以 `- ` 开头的顶层文本行走**逐字块**路径（kind: 'raw'）——
   * 渲染不画 bullet，序列化原样输出，文件字节保持不变。
   *
   * 关（默认）是 Logseq 的原生语义：裸行被收编成一级 `- ` 列表项，保存时
   * 整篇被规范化成项目符号列表。编辑视图（块编辑器 / 库外文件视图）按设置
   * 打开此开关；索引等只读解析维持原语义。
   */
  preservePlainText?: boolean;
}

export function parseDocument(md: string, opts: ParseOptions = {}): ParsedDocument {
  // CRLF (Windows) files: every parser regex below is `$`-anchored and `.`
  // never matches `\r`, so a trailing `\r` silently breaks fence open/close,
  // list and property detection (a CRLF file parsed raw explodes — fences
  // leak their bodies as bare lines). Normalize once up front; serialize
  // restores the file's own endings via the crlf flag.
  const crlf = /\r/.test(md);
  const lines = (crlf ? md.replace(/\r\n?/g, '\n') : md).split('\n');
  const doc: ParsedDocument = { frontmatter: '', pageProps: '', blocks: [] };
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
      for (const bl of bodyLines) {
        const pm = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(bl);
        if (pm) fmBlock.props[pm[1]] = pm[2].replace(/^ /, '');
      }
      doc.blocks.push(fmBlock);
    }
  }

  // --- page properties (unindented `key:: value` before any block) ---
  const pagePropLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (depthOf(line) === 0 && PROPERTY_RE.test(line.trim())) {
      pagePropLines.push(line);
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
    doc.blocks.push(propsBlock);
    doc.pageProps = '';
  }

  // --- main loop ---
  // stack[d] = most recent block whose real depth is d. Roots live in doc.blocks.
  const stack: Block[] = [];
  let lastBlock: Block | null = null; // most recent 'list' block (property / soft-line target)
  let rawBuf: string[] = [];
  let bareBuf: string[] = []; // consecutive bare lines → ONE first-level block
  // 保真模式：刚被丢弃（既不作为内容也不作为软行）的空行数——下一个块之前要
  // 补回这么多空行，否则段落与列表/标题之间的分隔会在保存时悄悄消失。
  let pendingBlanks = 0;

  /** 把一个新块挂到顶层，并在保真模式下带上"前面有空行"的标记。 */
  const pushRoot = (b: Block) => {
    if (opts.preservePlainText && pendingBlanks > 0 && doc.blocks.length > 0) b.blankBefore = pendingBlanks;
    pendingBlanks = 0;
    b.parent = null;
    doc.blocks.push(b);
  };

  const flushRaw = () => {
    while (rawBuf.length > 0 && rawBuf[rawBuf.length - 1].trim() === '') rawBuf.pop();
    if (rawBuf.length === 0) return;
    const b = createBlock();
    b.kind = 'raw';
    b.text = rawBuf.join('\n');
    pushRoot(b);
    rawBuf = [];
  };

  /** Emit the pending run of bare lines as ONE first-level list block. */
  const flushBare = () => {
    if (bareBuf.length === 0) return;
    const { marker, text } = parseMarker(bareBuf[0]);
    const b = createBlock([text, ...bareBuf.slice(1)].join('\n'), marker);
    b.parent = null;
    doc.blocks.push(b);
    stack.length = 0;
    stack.push(b);
    lastBlock = b;
    bareBuf = [];
  };

  const appendSoftLine = (block: Block, line: string) => {
    block.text += '\n' + stripIndent(line, realDepth(block) + 1);
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
        // 保真模式：紧随其后的 `- ` 列表项也算"新的结构"——逐字区域必须在空行
        // 处结束，否则空行被当作区域内容吞掉，段落与列表之间的分隔就丢了。
        const startsStructure =
          STRUCTURAL_RAW_RE.test(nextTrim) ||
          FENCE_OPEN_RE.test(next) ||
          (opts.preservePlainText === true && LIST_RE.test(next));
        // 保真模式再进一步：空行结束**任何**已闭合的逐字区域，哪怕是普通段落。
        // 否则"段落\n\n段落"会被并成一个块（空行进块文本），段落既不能单独
        // 多选、也不能单独折叠/缩进/转换。序列化会把相邻逐字块之间的空行补回来
        // （raw/raw 规则 + blankBefore），字节仍然不变。
        // 属性行依旧不拆分：`key:: value` 是该块的折叠标记。
        const endsRegion = opts.preservePlainText ? !PROPERTY_RE.test(nextTrim) : startsStructure;
        if (next && isRawRegionTail(rawBuf) && depthOf(next) === 0 && endsRegion) {
          flushRaw();
          if (opts.preservePlainText) {
            // 空行属于**后面**那个块，所以要在区域冲刷之后才置位；j - i 就是
            // 这次跳过的空行数（连续空行原样保留）。注意 i 要直接跳到 j——
            // 逐个 i++ 会把同一批空行再数一遍。
            pendingBlanks = Math.max(pendingBlanks, j - i);
            i = j;
            continue;
          }
          i++;
          continue;
        }
        rawBuf.push(line);
      }
      // 保真模式：这个空行既不是内容也不是软行，被丢弃了——记下来，下一个块
      // 之前要补回这么多空行（否则每保存一次就吃掉一个分隔空行）。
      if (opts.preservePlainText && rawBuf.length === 0) pendingBlanks++;
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
        i++;
        let closed = false;
        while (i < lines.length) {
          const cl = lines[i];
          const cTrim = cl.trim();
          // closing fence: same char run, no info string
          if (FENCE_OPEN_RE.test(cl) && cTrim.replace(/[`\s~]/g, '') === '') {
            lastBlock.text += '\n' + (cl.startsWith(prefix) ? cl.slice(prefix.length) : cTrim);
            i++;
            closed = true;
            break;
          }
          lastBlock.text += '\n' + (cl.startsWith(prefix) ? cl.slice(prefix.length) : cl.trimStart());
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
        i++;
        while (i < lines.length) {
          const cl = lines[i];
          const closed = MATH_FENCE_RE.test(cl);
          lastBlock.text += '\n' + (cl.startsWith(mPrefix) ? cl.slice(mPrefix.length) : cl.trimStart());
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
      const b = createBlock(text, marker);
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
        pushRoot(b);
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
          if (raw && raw.kind === 'raw') raw.props[propMatch[1]] = propMatch[2];
          i++;
          continue;
        }
        // Unindented property inside a raw region: keep verbatim.
        rawBuf.push(line);
      } else if (lastBlock) {
        // Unindented property right after blocks: tolerate, attach to last block.
        lastBlock.props[propMatch[1]] = propMatch[2];
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
      if (/^>\s*$/.test(trimmed)) {
        // An EMPTY quote line is its own block (Logseq: it renders as a
        // visible empty quote row). Merging it into the neighboring quote
        // block made CommonMark drop it silently — the row vanished.
        flushRaw();
        rawBuf.push(line);
        flushRaw();
      } else {
        rawBuf.push(line);
      }
      i++;
      continue;
    }

    // --- Top-level plain line: accumulate into ONE first-level block ---
    // Consecutive bare lines (no blank line between them) form a single
    // first-level list block; saving normalizes it to `- ` + soft lines.
    // A bare line that EXITS the current subtree stays IN POSITION as the
    // previous parsed block's raw content (the order-preservation rule).
    if (lastBlock && stack.length > 0 && stack.length - 1 > depth) {
      appendSoftLine(lastBlock, line);
      i++;
      continue;
    }
    if (opts.preservePlainText) {
      // 保真模式：裸行并入当前的逐字区域（**不** flushRaw —— 段落与紧随其后
      // 的标题/表格同属一个逐字块，序列化时原样输出，字节零改动；分开成两块
      // 会被序列化规则强行插入空行）。逐字块渲染时不画 bullet。
      rawBuf.push(line);
      i++;
      continue;
    }
    flushRaw();
    bareBuf.push(trimmed);
    i++;
  }

  flushRaw();
  flushBare();
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
      return i + 1;
    }
    b.text += '\n' + stripIndent(cl, depth + 1);
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
