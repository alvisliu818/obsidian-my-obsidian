/**
 * Same-depth code fences attach to the preceding block (Logseq-export shape).
 *
 * Regression: fences written at the SAME indent as their list item's marker
 * used to fail the in-block test (depth >= realDepth + 1), detach into
 * root-level raw blocks, and serialize AFTER the whole tree — moving every
 * code block to the bottom of the file on the first save.
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

describe('same-depth fences attach in-block', () => {
  it('fence at the marker indent becomes block text, not a root raw block', () => {
    const md = [
      '- root',
      '  - chapter',
      '        - item', // 8 spaces → depth 4
      '        ```python', // same depth as the item's marker
      '        x = 1',
      '        ```',
      '  - next chapter',
    ].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks).toHaveLength(1);
    const chapter = doc.blocks[0].children[0];
    const item = chapter.children[0];
    expect(item.kind).toBe('list');
    // The opening fence line may keep its excess indent (the stack may have
    // clamped the item shallower than its source indent); body and closing
    // fence lines are normalized against the fence's own indent.
    expect(item.text).toBe('item\n  ```python\nx = 1\n```');
    expect(chapter.children).toHaveLength(1); // fence did not become a sibling
    expect(doc.blocks[0].children).toHaveLength(2); // '- next chapter' stays
  });

  it('nested single-root document keeps code blocks in place across a save', () => {
    // Shape of the damaged real-world file: one root tree, code fences at
    // the same indent as their items — a save must not push them to the bottom.
    const md = [
      '- title',
      '  - section A',
      '    - item A1',
      '      ```js',
      '      const a = 1;',
      '      ```',
      '  - section B',
      '    - item B1',
      '      ```js',
      '      const b = 2;',
      '      ```',
    ].join('\n');
    const out = serializeDocument(parseDocument(md));
    const lines = out.split('\n');
    const lastList = lines.map((l, i) => (/^\t*[-*+]\s/.test(l) ? i : -1)).filter((i) => i >= 0).pop()!;
    // After the last list item only that item's own fence lines may follow:
    // section B's code — never section A's (which must stay in place above).
    const tail = lines.slice(lastList + 1).join('\n');
    expect(tail).toContain('const b = 2;');
    expect(tail).not.toContain('const a = 1;');
    expect(out).toContain('const a = 1;');
    // Round-trip stability.
    expect(serializeDocument(parseDocument(out))).toBe(out);
  });

  it('a top-level fence (col 0) between root items stays a standalone raw block', () => {
    const md = ['- first', '```js', 'code();', '```', '- second'].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['list', 'raw', 'list']);
  });

  it('reals the real-world damage shape: fences under deep items never move on save', () => {
    // 8sp fence directly after an 8sp item at depth 4 (the reported file shape).
    const md = [
      '- title',
      '  - 7 chapter',
      '    - 7.5 section',
      '      - 7.5.3 training',
      '        - init weights', // depth 4
      '        ```python',
      '        def train(): pass',
      '        ```',
    ].join('\n');
    const doc = parseDocument(md);
    const raws: string[] = [];
    const collect = (bs: readonly { kind: string; text: string; children: unknown[] }[]): void => {
      for (const b of bs) {
        if (b.kind === 'raw') raws.push(b.text);
        collect(b.children as never);
      }
    };
    collect(doc.blocks as never);
    expect(raws).toHaveLength(0);
    const out = serializeDocument(doc);
    expect(out).toContain('def train(): pass');
    expect(out.split('\n').pop()).toBe('\t\t\t\t\t```');
  });
});
