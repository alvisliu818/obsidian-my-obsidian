/**
 * Block tree → Markdown serializer (Logseq file format).
 *
 * - One indent unit per nesting depth (tab by default; space-indented files
 *   keep their spaces), `- ` list markers, `TODO/DOING/DONE` markers.
 * - Properties emitted as indented `key:: value` child lines (insertion order).
 * - In-block soft line breaks are re-indented one level deeper than the block.
 * - Raw blocks are emitted verbatim.
 */

import { Block, ParsedDocument, blockSemanticSig } from '../types';

/**
 * 判断原文行能否安全「逐字节保真」(2026-11-25)。
 *
 * parser 有时会对原文做语义决策，这类块必须走规范化重写，否则重解析会
 * 丢失语义。需要排除的情形：
 *  - task 块但原文 task 标记缺标准分隔空格（`- []todo` → 标准 `- [ ] todo`）；
 *  - GFM task 标记大小写/内容非标准（parser 已归一到 b.task）。
 * 其余情形（缩进风格 `\t  `、空列表项 `-`、尾随空格、deep fence 的空格数）
 * 都是纯格式差异，保真安全。
 */
function srcLinesFaithful(b: Block, depth: number): boolean {
  const src = b.srcLines;
  if (!src || src.length === 0) return false;
  if (b.kind === 'raw') return true; // raw 块逐字保真，parser 不改写结构
  const first = src[0] ?? '';
  // list 块（非 bare）：原文首行必须是 `- ` / `-`（空项）形态。
  // `TODO buy milk` 这种被 parser 提升成 list 的裸行原文没有 `- `，
  // 保真会让它重解析退回段落 → 必须规范化重写成 `- TODO buy milk`。
  if (!b.bare && !/^\s*-(?:\s|$)/.test(first)) return false;
  // 缩进深度：原文首行的缩进级别必须与块的真实 depth 一致。
  // `\t\t- Paris` 挂在 depth 1 的块下、原文却是 2 级缩进——保真会让
  // 重解析把它挂到错误层级。deep fence 的空格数同理。
  const indentUnits = indentDepth(first);
  if (indentUnits > depth) return false;
  // task 块：原文首行必须含标准的 `[X] ` 形态，否则是 parser 归一化的
  // 产物（`- []todo` → `- [ ] todo`），走规范化。
  if (b.task !== undefined && !/\[.\]\s/.test(first)) return false;
  return true;
}

/** 首行缩进折算成 depth 单位（tab=1，2 空格=1）。 */
function indentDepth(line: string): number {
  let units = 0;
  let spaces = 0;
  for (const ch of line) {
    if (ch === '\t') { units++; spaces = 0; }
    else if (ch === ' ') { spaces++; if (spaces === 2) { units++; spaces = 0; } }
    else break;
  }
  return units;
}

export function serializeDocument(doc: ParsedDocument): string {
  // CRLF files: parse normalized the model to \n; restore the file's own
  // endings so saving never rewrites every line of a Windows-format file.
  // Files that ended with a newline keep it (1-byte save fidelity).
  const finish = (lf: string): string => {
    const converted = doc.crlf ? lf.replace(/\n/g, '\r\n') : lf;
    return doc.trailingNewline ? converted + (doc.crlf ? '\r\n' : '\n') : converted;
  };
  // Indentation unit: space-indented files (Logseq exports) keep their
  // spaces on save — no full-file indent rewrites.
  const unit = doc.indentUnit ?? '\t';
  const parts: string[] = [];
  const blocks = doc.blocks;
  if (doc.frontmatter && !blocks[0]?.frontmatter) parts.push(doc.frontmatter);
  if (doc.pageProps) parts.push(doc.pageProps);
  // Obsidian-format page properties: a frontmatter-sourced props-only first
  // block round-trips as the `---` fenced frontmatter (format preserved).
  if (blocks[0]?.frontmatter) {
    const fm = blocks[0];
    parts.push('---', ...fm.text.split('\n'), '---');
    for (const c of fm.children) parts.push(serializeBlock(c, 0, undefined, unit));
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      // Logseq props-only blocks after the frontmatter keep their format too.
      if (isPropsOnlyBlock(b)) {
        for (const [k, v] of Object.entries(b.props)) parts.push(`${k}:: ${v}`);
        for (const c of b.children) parts.push(serializeBlock(c, 0, undefined, unit));
      } else {
        parts.push(serializeBlock(b, 0, undefined, unit));
      }
    }
    return finish(parts.join('\n'));
  }
  // Logseq model: a first block holding ONLY properties is the page-properties
  // block — its props are written as the unindented file-top lines, and its
  // children (if any) shift up to top level.
  if (isPropsOnlyBlock(blocks[0])) {
    const pb = blocks[0];
    for (const [k, v] of Object.entries(pb.props)) parts.push(`${k}:: ${v}`);
    for (const c of pb.children) parts.push(serializeBlock(c, 0, undefined, unit));
    for (let i = 1; i < blocks.length; i++) {
      // Same raw/raw blank-line rule as the general path below.
      if (i > 1 && blocks[i - 1].kind === 'raw' && blocks[i].kind === 'raw') parts.push('');
      parts.push(serializeBlock(blocks[i], 0, undefined, unit));
    }
    return finish(parts.join('\n'));
  }
  for (let i = 0; i < blocks.length; i++) {
    // Two adjacent VERBATIM blocks need a blank line between them: written
    // back to back, two fences (or two tables) merge into one construct in
    // CommonMark. The parser splits them on a blank line, so the writer has to
    // put it back or the file would not survive a save. A list block's `- `
    // marker already starts a new item, and a blank line before a nested list
    // would change its meaning, so only raw/raw pairs get one.
    if (i > 0 && blocks[i - 1].kind === 'raw' && blocks[i].kind === 'raw') parts.push('');
    parts.push(serializeBlock(blocks[i], 0, undefined, unit));
  }
  return finish(parts.join('\n'));
}

/** The page-properties block: an empty-text first block that only carries props. */
function isPropsOnlyBlock(b: Block | undefined): boolean {
  return !!b && b.kind === 'list' && b.text === '' && Object.keys(b.props).length > 0;
}

export function serializeBlock(b: Block, depth: number, skipProps?: readonly string[], unit: string = '\t'): string {
  // 原文保真快路径(2026-11-25)：块自解析以来没被编辑过（语义签名匹配）、
  // 有 srcLines、且不是「跳过 props」的预览模式——直接吐原文行，包含源文件
  // 里原本的缩进空格（`\t  ` 不被规范成 `\t\t`）、空列表项的 `-`（无尾空格）、
  // 尾随空格等。这是「不动原文、只改真实编辑过的内容」的关键：未编辑块逐字节
  // 保留，编辑过的块（签名变了）才走下面的规范化重写。
  // children 仍递归——它们的原文行在各自 srcLines 里，新增/改过的子块照常重写。
  if (
    b.srcLines &&
    b.srcLines.length > 0 &&
    b.srcSig !== undefined &&
    b.srcSig === blockSemanticSig(b) &&
    srcLinesFaithful(b, depth) &&
    (!skipProps || skipProps.length === 0)
  ) {
    const out = b.srcLines.slice();
    for (const c of b.children) out.push(serializeBlock(c, depth + 1, skipProps, unit));
    return out.join('\n');
  }
  if (b.kind === 'raw') {
    // A verbatim block is emitted as-is, but it may still OWN properties —
    // the parser re-attaches a `key:: value` line written below it (see
    // src/core/fold.ts for why the flag cannot live inside the text).
    //
    // Unindented, matching the block: a raw block always sits at the top
    // level, and the parser only re-attaches an UNINDENTED property line to
    // it. Indenting the way a list block's properties are indented would make
    // the line read back as a soft line of the block instead — the flag would
    // survive in the file but never come back into `props`.
    const rawProps = Object.keys(b.props).filter((k) => !skipProps?.includes(k));
    if (rawProps.length === 0) return b.text;
    const tail = rawProps.map((k) => `${k}:: ${b.props[k]}`);
    return [b.text, ...tail].join('\n');
  }

  const prefix = unit.repeat(depth);
  const marker = b.marker ? b.marker + ' ' : '';
  // GFM 任务前缀（批次 23）：parse 剥进 b.task，这里拼回，round-trip 保真。
  const taskPrefix = b.task !== undefined && b.task !== null ? `[${b.task}] ` : '';
  const textLines = b.text.split('\n');
  const out: string[] = [];

  // 段落容器(bare):源文件没有列表标志,发射时不带 `- ` 前缀——保存不会把
  // 段落改写成列表项(圆点抑制因此在磁盘上稳定,重解析回来还是段落)。
  // 软行与块同行深(不再 +1):普通多行段落原文件就没有缩进,加了会改字节。
  // depth>0 时不走这条:磁盘上嵌套段必须带标记,否则重解析会把裸行并成
  // 上一块的软行(结构拍平)——那种情况回落到下面的 `- ` 形式。
  if (b.bare && depth === 0) {
    out.push(textLines[0]);
    for (let k = 1; k < textLines.length; k++) out.push(textLines[k]);
    // 属性行仍需 depth+1:parser 只把缩进一级的 `key:: value` 认成块的属性
    // (fold 标志就是这样往返的)。
    const propPrefix = unit.repeat(depth + 1);
    for (const key of Object.keys(b.props)) {
      if (skipProps?.includes(key)) continue;
      out.push(`${propPrefix}${key}:: ${b.props[key]}`);
    }
    for (const c of b.children) {
      out.push(serializeBlock(c, depth + 1, skipProps, unit));
    }
    return out.join('\n');
  }

  out.push(`${prefix}- ${marker}${taskPrefix}${textLines[0]}`);
  const softPrefix = unit.repeat(depth + 1);
  for (let k = 1; k < textLines.length; k++) {
    out.push(softPrefix + textLines[k]);
  }
  for (const key of Object.keys(b.props)) {
    if (skipProps?.includes(key)) continue;
    out.push(`${softPrefix}${key}:: ${b.props[key]}`);
  }
  for (const c of b.children) {
    out.push(serializeBlock(c, depth + 1, skipProps, unit));
  }
  return out.join('\n');
}

/** Bookkeeping props that are meaningless in an embed / drag-drop preview. */
export const PREVIEW_SKIP_PROPS: readonly string[] = ['id', 'collapsed', 'table-widths'];

/**
 * Serialize the content of one block (used for embeds and drag & drop):
 * the block's own text followed by its children as a top-level list.
 *
 * Children are emitted at depth 0 — a tab-indented list cannot interrupt a
 * paragraph, so the old `depth + 1` output collapsed the whole sub-tree into a
 * single run-on paragraph when rendered as markdown.
 */
export function serializeBlockContent(b: Block): string {
  const lines = b.text.split('\n');
  const out: string[] = [];
  for (const line of lines) out.push(line);
  if (b.children.length > 0) out.push(''); // blank line: safe block break
  for (const c of b.children) out.push(serializeBlock(c, 0, PREVIEW_SKIP_PROPS));
  return out.join('\n');
}
