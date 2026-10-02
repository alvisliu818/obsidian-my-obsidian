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

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
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

export function parseDocument(md: string): ParsedDocument {
  const lines = md.split('\n');
  const doc: ParsedDocument = { frontmatter: '', pageProps: '', blocks: [] };
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

  const flushRaw = () => {
    while (rawBuf.length > 0 && rawBuf[rawBuf.length - 1].trim() === '') rawBuf.pop();
    if (rawBuf.length === 0) return;
    const b = createBlock();
    b.kind = 'raw';
    b.text = rawBuf.join('\n');
    b.parent = null;
    doc.blocks.push(b);
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
      if (rawBuf.length > 0) rawBuf.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const depth = depthOf(line);
    // A pending bare group is an implicit last block: indented lines and
    // fences after it belong to it, just like they belong to a list block.
    if (bareBuf.length > 0 && depth >= 1) flushBare();

    // --- Code fence handling ---
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const belongsToBlock = lastBlock !== null && depth >= realDepth(lastBlock) + 1;
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
      } else if (rawBuf.length > 0) {
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
      rawBuf.push(line);
      i++;
      continue;
    }

    // --- Top-level plain line: accumulate into ONE first-level block ---
    // Consecutive bare lines (no blank line between them) form a single
    // first-level list block; saving normalizes it to `- ` + soft lines.
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
