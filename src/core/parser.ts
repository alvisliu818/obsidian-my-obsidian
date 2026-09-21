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
      doc.frontmatter = lines.slice(0, j + 1).join('\n');
      i = j + 1;
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

  // --- main loop ---
  // stack[d] = most recent block whose real depth is d. Roots live in doc.blocks.
  const stack: Block[] = [];
  let lastBlock: Block | null = null; // most recent 'list' block (property / soft-line target)
  let rawBuf: string[] = [];

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

    // Empty line: separator outside raw, verbatim inside raw.
    if (line.trim() === '') {
      if (rawBuf.length > 0) rawBuf.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const depth = depthOf(line);

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
        i = consumeFenceBody(b, lines, i, openFence[2]);
      }
      continue;
    }

    // --- Property line ---
    const propMatch = PROPERTY_RE.exec(trimmed);
    if (propMatch) {
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

    // --- Top-level non-list content: raw block ---
    rawBuf.push(line);
    i++;
  }

  flushRaw();
  return doc;
}

/**
 * Consume the body of a fence opened by a list item (`- ```sql`) into the
 * block's text, stopping after the closing fence. Returns the new line index.
 * Body lines have one indentation unit stripped so an indented fence keeps its
 * own internal indentation intact.
 */
function consumeFenceBody(b: Block, lines: string[], i: number, fenceRun: string): number {
  const run = fenceRun[0];
  while (i < lines.length) {
    const cl = lines[i];
    const fm = FENCE_OPEN_RE.exec(cl);
    if (fm && fm[2][0] === run && fm[2].length >= fenceRun.length && fm[3].trim() === '') {
      b.text += '\n' + fm[2];
      return i + 1;
    }
    b.text += '\n' + stripIndent(cl, 1);
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
