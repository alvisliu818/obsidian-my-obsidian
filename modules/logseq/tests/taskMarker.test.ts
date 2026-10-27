import { describe, expect, it } from 'vitest';
import {
  getTaskListMarker,
  isTaskListMarker,
  nextTaskListMarker,
  nextTaskListStatus,
  taskStatusClass,
} from '../src/core/taskMarker';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

/* 思源 taskListMarker.test.ts 1:1（批次 23）。 */
describe('nextTaskListStatus (思源: cycles built-in statuses)', () => {
  it('cycles the four built-in states', () => {
    let marker = ' ';
    for (const expected of ['/', 'X', '-', ' ', '/']) {
      marker = nextTaskListStatus(marker);
      expect(marker).toBe(expected);
    }
  });
  it('maps custom statuses to empty on entry', () => {
    for (const custom of ['?', 'f', 's', '', null]) {
      expect(nextTaskListStatus(custom)).toBe(' ');
    }
  });
  it('lowercase x counts as X in the cycle', () => {
    expect(nextTaskListStatus('x')).toBe('-');
  });
});

describe('nextTaskListMarker (思源: click = two-state toggle)', () => {
  it('completes todo and in-progress tasks', () => {
    expect(nextTaskListMarker(' ')).toBe('X');
    expect(nextTaskListMarker('/')).toBe('X');
    expect(nextTaskListMarker(null)).toBe('X');
  });
  it('resets other states on click', () => {
    for (const marker of ['X', 'x', '-', '?']) {
      expect(nextTaskListMarker(marker)).toBe(' ');
    }
  });
});

describe('isTaskListMarker (思源: single-char validation)', () => {
  it('validates a complete custom status instead of an empty shortcut prefix', () => {
    for (const marker of [' ', 'X', 'x', '/', '-', '?', '"', '&', '<']) {
      expect(isTaskListMarker(marker)).toBe(true);
    }
    for (const marker of ['', 'ab', '[', ']', '【', '】', '中']) {
      expect(isTaskListMarker(marker)).toBe(false);
    }
  });
});

describe('getTaskListMarker (思源: prefix parse)', () => {
  it('recognizes full-width shortcuts when enabled', () => {
    expect(getTaskListMarker('【】待办', true)).toEqual({ contentStartIndex: 2, marker: ' ' });
    expect(getTaskListMarker('【X】完成', true)).toEqual({ contentStartIndex: 3, marker: 'X' });
  });
  it('keeps full-width as text when disabled', () => {
    expect(getTaskListMarker('【】待办', false)).toBeUndefined();
    expect(getTaskListMarker('【X】完成', false)).toBeUndefined();
  });
  it('always recognizes half-width shortcuts', () => {
    expect(getTaskListMarker('[]todo', false)).toEqual({ contentStartIndex: 2, marker: ' ' });
    expect(getTaskListMarker('[x]done', false)).toEqual({ contentStartIndex: 3, marker: 'x' });
  });
});

describe('taskStatusClass', () => {
  it('maps states to CSS-safe class suffixes', () => {
    expect(taskStatusClass(' ')).toBe('empty');
    expect(taskStatusClass('X')).toBe('x');
    expect(taskStatusClass('/')).toBe('slash');
    expect(taskStatusClass('-')).toBe('dash');
    expect(taskStatusClass('?')).toBe('?');
  });
});

/* parse/serialize round-trip（我们侧接线）。 */
describe('GFM task parse + serialize round-trip', () => {
  const rt = (src: string): string => serializeDocument(parseDocument(src));

  it('parses task states into b.task and round-trips', () => {
    const doc = parseDocument(['- [ ] todo item', '- [x] done item', '- [/] doing item', '- [-] cancelled item'].join('\n'));
    const blocks = doc.blocks;
    expect(blocks.map((b) => b.task)).toEqual([' ', 'x', '/', '-']);
    expect(blocks.map((b) => b.text)).toEqual(['todo item', 'done item', 'doing item', 'cancelled item']);
    expect(rt(['- [ ] todo item', '- [x] done item'].join('\n'))).toBe('- [ ] todo item\n- [x] done item');
  });

  it('parses the no-space shortcut and preserves lowercase x', () => {
    const doc = parseDocument('- []todo\n- [x]done');
    expect(doc.blocks.map((b) => b.task)).toEqual([' ', 'x']);
    expect(doc.blocks.map((b) => b.text)).toEqual(['todo', 'done']);
    expect(rt('- []todo\n- [x]done')).toBe('- [ ] todo\n- [x] done');
  });

  it('does not task-ify bare paragraphs or logseq marker lines', () => {
    const doc = parseDocument('[ ] plain paragraph\n- TODO logseq marker');
    expect(doc.blocks[0].task).toBeUndefined();
    expect(doc.blocks[0].text).toContain('[ ]');
    expect(doc.blocks[1].marker).toBe('TODO');
    expect(doc.blocks[1].task).toBeUndefined();
  });

  it('custom single-char status round-trips', () => {
    expect(rt('- [?] custom')).toBe('- [?] custom');
  });

  it('task prefix survives multi-line text (only first line)', () => {
    const doc = parseDocument('- [ ] first\n\twrapped second line');
    expect(doc.blocks[0].task).toBe(' ');
    expect(doc.blocks[0].text).toBe('first\nwrapped second line');
    expect(rt('- [ ] first\n\twrapped second line')).toBe('- [ ] first\n\twrapped second line');
  });

  it('logseq marker and GFM task coexist on one line', () => {
    const doc = parseDocument('- TODO [ ] stacked');
    expect(doc.blocks[0].marker).toBe('TODO');
    expect(doc.blocks[0].task).toBe(' ');
    expect(rt('- TODO [ ] stacked')).toBe('- TODO [ ] stacked');
  });
});
