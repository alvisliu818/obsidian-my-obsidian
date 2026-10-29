/**
 * Section folding, following SiYuan's `removeFoldHeading` exactly.
 *
 * Read from source rather than guessed: in
 * `app/src/protyle/util/blockFold.ts` a heading folds via its own
 * `foldHeading` operation (NOT `setAttrs`), and `removeFoldHeading` in
 * `app/src/protyle/util/heading.ts` walks `nextElementSibling`, removing
 * every following sibling that is either not a heading or is a DEEPER one,
 * stopping at the first heading of the same or a shallower level.
 *
 * A markdown heading cannot own its section as children — the blocks under a
 * heading are SIBLINGS (measured: `## H` + text parses to two blocks) — so
 * the section is defined by scanning the visible sequence.
 */
import { describe, expect, it } from 'vitest';
import {
  headingLevel,
  isFoldableBody,
  isFoldableHeading,
  isInsideFoldedSection,
  isThematicBreak,
  sectionEndIndex,
} from '../src/core/fold';
import { parseDocument } from '../src/core/parser';
import { flattenVisible } from '../src/core/treeOps';
import { setCollapsed } from '../src/types';
import type { Block } from '../src/types';

const DOC = [
  '# 一级标题',
  '',
  '正文甲',
  '',
  '## 二级标题',
  '',
  '正文乙',
  '',
  '### 三级标题',
  '',
  '正文丙',
  '',
  '# 另一个一级',
  '',
  '正文丁',
].join('\n');

function seqOf(md: string): Block[] {
  const doc = parseDocument(md);
  return flattenVisible(doc.blocks);
}

describe('heading levels', () => {
  it('reads the level from the first line', () => {
    const seq = seqOf(DOC);
    expect(seq.map(headingLevel)).toEqual([1, 0, 2, 0, 3, 0, 1, 0]);
  });

  it('a non-heading is level 0', () => {
    expect(headingLevel(seqOf('just text')[0])).toBe(0);
  });

  it('setext-style underlines are not detected as headings (markdown rule)', () => {
    // The parser treats them as text, so folding must not claim them either.
    expect(headingLevel(seqOf('Title\n=====\n\nbody')[0])).toBe(0);
  });
});

describe('section boundaries', () => {
  it('a heading owns everything up to the next same-level heading', () => {
    const seq = seqOf(DOC);
    expect(sectionEndIndex(seq, 0)).toBe(6); // through 正文丙
    expect(sectionEndIndex(seq, 6)).toBe(8); // the last section
  });

  it('a section reaches the next same-or-shallower heading, deeper ones included', () => {
    // SiYuan's `removeFoldHeading` removes every following sibling that is not
    // a heading OR is a deeper one, stopping at the first same-or-shallower
    // heading. So `## 二级标题` DOES own `### 三级标题` and its body — the
    // section ends at the NEXT `#`. (An earlier draft of this file assumed a
    // heading closed at the next heading of any level and failed against
    // correct behaviour.)
    const seq = seqOf(DOC);
    expect(sectionEndIndex(seq, 0)).toBe(6); // through 正文丙
    expect(sectionEndIndex(seq, 2)).toBe(6); // ## owns ### and its body
    expect(sectionEndIndex(seq, 4)).toBe(6); // ### up to the next #
    expect(sectionEndIndex(seq, 6)).toBe(8); // the last section
  });

  it('a non-heading has a section of just itself', () => {
    const seq = seqOf(DOC);
    expect(sectionEndIndex(seq, 1)).toBe(2);
  });

  it('a heading with no body still folds nothing', () => {
    const seq = seqOf('# A\n\n# B\n');
    expect(sectionEndIndex(seq, 0)).toBe(1);
  });
});

describe('folding a heading hides its section', () => {
  it('hides the deeper siblings, keeps the rest', () => {
    const seq = seqOf(DOC);
    setCollapsed(seq[0], true);
    const hidden = seq
      .map((b, i) => (isInsideFoldedSection(b, i, seq) ? b.text.split('\n')[0] : null))
      .filter(Boolean);
    console.log('hidden under # 一级标题:', JSON.stringify(hidden));
    expect(hidden).toEqual(['正文甲', '## 二级标题', '正文乙', '### 三级标题', '正文丙']);
    // The next same-level heading and its body stay visible.
    expect(isInsideFoldedSection(seq[6], 6, seq)).toBe(false);
    expect(isInsideFoldedSection(seq[7], 7, seq)).toBe(false);
  });

  it('a folded deeper heading hides only its own subsection', () => {
    const seq = seqOf(DOC);
    setCollapsed(seq[2], true); // ## 二级标题
    const hidden: string[] = [];
    seq.forEach((b, i) => {
      if (isInsideFoldedSection(b, i, seq)) hidden.push(b.text.split('\n')[0]);
    });
    console.log('hidden under ## 二级标题:', JSON.stringify(hidden));
    expect(hidden).toEqual(['正文乙', '### 三级标题', '正文丙']);
  });

  it('nothing is hidden when no heading is folded', () => {
    const seq = seqOf(DOC);
    const anyHidden = seq.some((b, i) => isInsideFoldedSection(b, i, seq));
    expect(anyHidden).toBe(false);
  });

  it('a block outside the sequence is never hidden', () => {
    const seq = seqOf(DOC);
    setCollapsed(seq[0], true);
    expect(isInsideFoldedSection(seq[1], -1, seq)).toBe(false);
  });
});

describe('what is foldable', () => {
  it('a heading is foldable as a section', () => {
    const seq = seqOf(DOC);
    expect(isFoldableHeading(seq[0])).toBe(true);
    expect(isFoldableHeading(seq[1])).toBe(false); // plain text
  });

  it('a thematic break never folds, matching SiYuan', () => {
    // setFold returns early for NodeThematicBreak. Note `---` is parsed as a
    // LIST item by LIST_RE (measured), `***` / `___` as verbatim blocks — but
    // both are a single line, so neither is foldable either way.
    expect(isThematicBreak('***')).toBe(true);
    expect(isThematicBreak('___')).toBe(true);
    const seq = seqOf('- a\n\n***\n\n- b\n');
    const divider = seq.find((b) => b.text.trim() === '***');
    expect(divider).toBeDefined();
    expect(isFoldableBody(divider!)).toBe(false);
  });

  it('a single-line body block has nothing to fold', () => {
    expect(isFoldableBody(seqOf('just one line')[0])).toBe(false);
  });

  it('a media-only block folds', () => {
    expect(isFoldableBody(seqOf('![](a.png)')[0])).toBe(true);
  });
});
