/**
 * Block tree → Markdown serializer (Logseq file format).
 *
 * - One indent unit per nesting depth (tab by default; space-indented files
 *   keep their spaces), `- ` list markers, `TODO/DOING/DONE` markers.
 * - Properties emitted as indented `key:: value` child lines (insertion order).
 * - In-block soft line breaks are re-indented one level deeper than the block.
 * - Raw blocks are emitted verbatim.
 */

import { Block, ParsedDocument } from '../types';

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
  /**
   * 顶层块入列。两个空行来源要合并去重：
   *  - `blankBefore`（保真模式）：原文里这个块前面有 N 个空行，原样补回；
   *  - 相邻逐字块规则：两块围栏/表格不能连写，之间必须有空行（默认模式）。
   * 取两者较大值，且不重复追加。
   */
  const pushTop = (b: Block, prev?: Block): void => {
    // need 取两个来源的较大值，直接追加对应数量的空行——中间不能再插"去重"
    // 判断，否则第二个空行会被自己刚 push 的空串拦掉（连续空行全丢）。
    const need = Math.max(
      b.blankBefore ?? 0,
      prev && prev.kind === 'raw' && b.kind === 'raw' ? 1 : 0,
    );
    for (let k = 0; k < need; k++) parts.push('');
    parts.push(serializeBlock(b, 0, undefined, unit));
  };
  if (doc.frontmatter && !blocks[0]?.frontmatter) parts.push(doc.frontmatter);
  if (doc.pageProps) parts.push(doc.pageProps);
  // Obsidian-format page properties: a frontmatter-sourced props-only first
  // block round-trips as the `---` fenced frontmatter (format preserved).
  if (blocks[0]?.frontmatter) {
    const fm = blocks[0];
    parts.push('---', ...fm.text.split('\n'), '---');
    fm.children.forEach((c, i) => pushTop(c, fm.children[i - 1]));
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      // Logseq props-only blocks after the frontmatter keep their format too.
      if (isPropsOnlyBlock(b)) {
        for (const [k, v] of Object.entries(b.props)) parts.push(`${k}:: ${v}`);
        b.children.forEach((c, j) => pushTop(c, b.children[j - 1]));
      } else {
        pushTop(b, blocks[i - 1]);
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
    pb.children.forEach((c, j) => pushTop(c, pb.children[j - 1]));
    for (let i = 1; i < blocks.length; i++) {
      pushTop(blocks[i], blocks[i - 1]);
    }
    return finish(parts.join('\n'));
  }
  for (let i = 0; i < blocks.length; i++) {
    pushTop(blocks[i], blocks[i - 1]);
  }
  return finish(parts.join('\n'));
}

/** The page-properties block: an empty-text first block that only carries props. */
function isPropsOnlyBlock(b: Block | undefined): boolean {
  return !!b && b.kind === 'list' && b.text === '' && Object.keys(b.props).length > 0;
}

export function serializeBlock(b: Block, depth: number, skipProps?: readonly string[], unit: string = '\t'): string {
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
  const textLines = b.text.split('\n');
  const out: string[] = [];
  out.push(`${prefix}- ${marker}${textLines[0]}`);
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
export const PREVIEW_SKIP_PROPS: readonly string[] = ['id', 'collapsed'];

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
