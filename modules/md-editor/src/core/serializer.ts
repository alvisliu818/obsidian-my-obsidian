/**
 * Block tree → Markdown serializer (Logseq file format).
 *
 * - One indent unit per nesting depth (tab by default; space-indented files
 *   keep their spaces), `- ` list markers, `TODO/DOING/DONE` markers.
 * - Properties emitted as indented `key:: value` child lines (insertion order).
 * - In-block soft line breaks are re-indented one level deeper than the block.
 * - Raw blocks are emitted verbatim.
 */

import { Block, ParsedDocument, blockSemanticSig, documentSemanticSig } from '../types';

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
  // 空段落块（空行物化）：任何缩进都只是空行的缩进，不参与结构判定——
  // 空行无论怎么写，重解析都当分隔行，块位置由「下一块」的缩进决定。
  if (b.bare && b.text === '') return true;
  const first = src[0] ?? '';
  // list 块（非 bare）：原文首行必须是 `- ` / `-`（空项）形态。
  // `TODO buy milk` 这种被 parser 提升成 list 的裸行原文没有 `- `，
  // 保真会让它重解析退回段落 → 必须规范化重写成 `- TODO buy milk`。
  if (!b.bare && !/^\s*-(?:\s|$)/.test(first)) return false;
  // 缩进深度：有父块时原文首行的缩进级别必须与块的真实 depth **精确**一致。
  // `\t\t- Paris` 挂在 depth 1 的块下、原文却是 2 级缩进——保真会让
  // 重解析把它挂到错误层级；反过来（缩进更浅，块被缩进/拖到更深）照抄原文
  // 会让重解析把子块挤回根层。根块不受限：parser 已把任意缩进的顶层行归一
  // 到 depth 0，写回原文缩进再解析仍是根，往返稳定。
  const indentUnits = indentDepth(first);
  if (b.parent && indentUnits !== depth) return false;
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
  // 原文保真总闸(2026-11-25)：整篇自解析以来没被编辑过 → 原文直出，
  // 一个字节都不动。这覆盖「打开文件就序列化」的根场景（含 parser 会归一化
  // 的畸形缩进/空行/围栏），保证「打开未修改的文件再保存」是零 diff。
  // 只要任何一块的语义或树结构变了，才走下面的逐块保真/规范化路径。
  if (
    doc.sourceText !== undefined &&
    doc.parseTreeSig !== undefined &&
    doc.parseTreeSig === documentSemanticSig(doc.blocks)
  ) {
    return doc.sourceText;
  }
  // CRLF files: parse normalized the model to \n; restore the file's own
  // endings so saving never rewrites every line of a Windows-format file.
  // 原文保真：parser 记录的是文件末尾的全部空行（含结尾换行）——直接拼回，
  // 不能再补 trailingNewline（否则每次保存多一个空行）。trailingGap 缺失
  // （运行时新建的文档）才走旧的布尔近似。
  const finish = (lf: string): string => {
    const converted = doc.crlf ? lf.replace(/\n/g, '\r\n') : lf;
    // 末尾空行已物化成空段落块（trailingGap 清空）时，文件结尾换行仍由
    // trailingNewline 补——否则在空行后追加的块会吞掉文件末尾的换行。
    if (doc.trailingGap && doc.trailingGap.length > 0) return converted;
    return doc.trailingNewline ? converted + (doc.crlf ? '\r\n' : '\n') : converted;
  };
  // Indentation unit: space-indented files (Logseq exports) keep their
  // spaces on save — no full-file indent rewrites.
  const unit = doc.indentUnit ?? '\t';
  const parts: string[] = [];
  const blocks = doc.blocks;

  /**
   * 原文保真(2026-11-25)：块前的空行逐字节吐回。
   *
   * 空行不属于任何块，但删掉就是改用户文件（用户报的 diff 里一片红的
   * 全是这种行）——parser 把它们记在「下一块」的 srcGap 上，这里拼回。
   * `srcGap === undefined` 才是运行时新造的块（Enter / 引用间空段落），
   * 那时才用旧的 raw/raw 兜底规则：两个相邻 verbatim 块之间必须有空行，
   * 否则 CommonMark 会把两个 fence（或两张表）并成一个构造。
   */
  const pushGap = (b: Block | undefined, prev?: Block): void => {
    if (b?.srcGap) parts.push(...b.srcGap);
    else if (prev && prev.kind === 'raw' && b?.kind === 'raw') parts.push('');
  };
  const pushTop = (b: Block, prev?: Block): void => {
    pushGap(b, prev);
    parts.push(serializeBlock(b, 0, undefined, unit));
  };

  if (doc.frontmatter && !blocks[0]?.frontmatter) parts.push(doc.frontmatter);
  if (doc.pageProps) parts.push(doc.pageProps);
  // First block consumed by a special format (frontmatter / Logseq page props)
  // is written by its own branch; the rest go through the general path.
  let start = 0;
  // Obsidian-format page properties: a frontmatter-sourced props-only first
  // block round-trips as the `---` fenced frontmatter (format preserved).
  if (blocks[0]?.frontmatter) {
    const fm = blocks[0];
    pushGap(fm);
    // 原文保真：未编辑的 frontmatter 连围栏行与 YAML 里的空格照抄；
    // 编辑过的（props 变了）才按记录重建。
    if (fm.srcLines && fm.srcSig === blockSemanticSig(fm)) parts.push(...fm.srcLines);
    else parts.push('---', ...fm.text.split('\n'), '---');
    for (const c of fm.children) pushTop(c);
    start = 1;
  } else if (isPropsOnlyBlock(blocks[0])) {
    // Logseq model: a first block holding ONLY properties is the page-properties
    // block — its props are written as the unindented file-top lines, and its
    // children (if any) shift up to top level.
    const pb = blocks[0];
    pushGap(pb);
    if (pb.srcLines && pb.srcSig === blockSemanticSig(pb)) parts.push(...pb.srcLines);
    else for (const [k, v] of Object.entries(pb.props)) parts.push(`${k}:: ${v}`);
    for (const c of pb.children) pushTop(c);
    start = 1;
  }
  for (let i = start; i < blocks.length; i++) {
    const b = blocks[i];
    // Logseq props-only blocks after the frontmatter keep their format too.
    if (isPropsOnlyBlock(b)) {
      pushGap(b, i > 0 ? blocks[i - 1] : undefined);
      if (b.srcLines && b.srcSig === blockSemanticSig(b)) parts.push(...b.srcLines);
      else for (const [k, v] of Object.entries(b.props)) parts.push(`${k}:: ${v}`);
      for (const c of b.children) pushTop(c);
    } else {
      pushTop(b, i > 0 ? blocks[i - 1] : undefined);
    }
  }
  // 原文保真：文件末尾的空行（含结尾换行）原样拼回。
  if (doc.trailingGap) parts.push(...doc.trailingGap);
  return finish(parts.join('\n'));
}

/** The page-properties block: an empty-text first block that only carries props. */
function isPropsOnlyBlock(b: Block | undefined): boolean {
  return !!b && b.kind === 'list' && b.text === '' && Object.keys(b.props).length > 0;
}

/**
 * 原文保真(2026-11-25)：子块前的空行也要吐回（子块自己的 srcGap）。
 * 预览模式（skipProps 非空）是「块内容」而不是文件片段，不带空行。
 */
function pushChild(out: string[], b: Block, depth: number, skipProps: readonly string[] | undefined, unit: string): void {
  const preview = !!skipProps && skipProps.length > 0;
  for (const c of b.children) {
    if (!preview && c.srcGap) out.push(...c.srcGap);
    out.push(serializeBlock(c, depth + 1, skipProps, unit));
  }
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
    pushChild(out, b, depth, skipProps, unit);
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
    pushChild(out, b, depth, skipProps, unit);
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
  pushChild(out, b, depth, skipProps, unit);
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
  for (const c of b.children) {
    // 空行物化块是编辑器里的可见空行，不属于块内容（嵌入/拖拽预览不写）。
    if (c.bare && c.text === '') continue;
    out.push(serializeBlock(c, 0, PREVIEW_SKIP_PROPS));
  }
  return out.join('\n');
}
