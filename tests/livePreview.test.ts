import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { collectLivePreview } from '../src/editor/livePreview';

const at = (doc: string, anchor: number): ReturnType<typeof collectLivePreview> =>
  collectLivePreview(EditorState.create({ doc, selection: EditorSelection.cursor(anchor) }));

/**
 * What the user would see: the doc with every hidden (replace) range
 * removed. Mark-only ranges (dim/color) keep their text.
 */
const visible = (doc: string, anchor: number): string => {
  const gone = new Set<number>();
  for (const s of at(doc, anchor)) {
    if (s.from === s.to || s.kind.endsWith(':mark')) continue;
    for (let i = s.from; i < s.to; i++) gone.add(i);
  }
  return [...doc].filter((_, i) => !gone.has(i)).join('');
};

// 'plain **bold** tail' — ** at 6-8 and 12-14.
const BOLD = 'plain **bold** tail';

describe('collectLivePreview — inline marks', () => {
  it('hides bold marks when the caret is away', () => {
    expect(visible(BOLD, BOLD.length)).toBe('plain bold tail');
    expect(at(BOLD, BOLD.length).some((s) => s.kind === 'bold')).toBe(true);
  });

  it('shows raw marks when the caret is inside the construct, rendered at its ends', () => {
    expect(at(BOLD, 10).filter((s) => s.kind === 'bold')).toEqual([]); // inside text
    expect(at(BOLD, 7).filter((s) => s.kind === 'bold')).toEqual([]); // inside opening **
    expect(at(BOLD, 12).filter((s) => s.kind === 'bold')).toEqual([]); // on closing **
    expect(at(BOLD, 6).some((s) => s.kind === 'bold')).toBe(true); // just before **
    expect(at(BOLD, 14).some((s) => s.kind === 'bold')).toBe(true); // just after **
  });

  it('hides italic, highlight, strikethrough, inline code marks', () => {
    expect(visible('a *it* b', 8)).toBe('a it b');
    expect(visible('a ==hl== b', 10)).toBe('a hl b');
    expect(visible('a ~~st~~ b', 10)).toBe('a st b');
    expect(visible('a `code` b', 10)).toBe('a code b');
  });

  it('dim-marks comment content and hides the %% delimiters', () => {
    const specs = at('note %%secret%% end', 19);
    expect(specs.some((s) => s.kind === 'comment:mark')).toBe(true);
    expect(visible('note %%secret%% end', 19)).toBe('note secret end');
  });

  it('does not match empty or unclosed pairs', () => {
    expect(at('****', 4)).toEqual([]);
    expect(at('a ** b', 6)).toEqual([]);
    expect(at('**bold', 6)).toEqual([]);
  });

  it('bold wins over italic for the same range, even at the bold edge', () => {
    expect(at('**b**', 5).filter((s) => s.kind === 'italic')).toEqual([]);
    expect(at('**b**', 2).filter((s) => s.kind === 'italic')).toEqual([]);
  });
});

describe('collectLivePreview — wikilinks', () => {
  it('renders a plain wikilink as its page name', () => {
    expect(visible('see [[Page]] now', 16)).toBe('see Page now');
    expect(at('see [[Page]] now', 16).some((s) => s.kind === 'wikilink:mark')).toBe(true);
  });

  it('renders [[page|alias]] as the alias only', () => {
    expect(visible('see [[Page Name|Alias]] now', 27)).toBe('see Alias now');
    expect(at('see [[Page Name|Alias]] now', 27).some((s) => s.kind === 'wikilink:mark')).toBe(true);
  });

  it('leaves ![[embeds]] untouched', () => {
    expect(at('![[Page]] x', 11)).toEqual([]);
  });

  it('shows raw when the caret is inside', () => {
    expect(at('see [[Page]] now', 8).filter((s) => s.kind.startsWith('wikilink'))).toEqual([]);
  });
});

describe('collectLivePreview — headings, hr', () => {
  it('hides the # prefix and tags the line, caret elsewhere on the doc', () => {
    const specs = at('# Title\nbody', 11);
    expect(specs.some((s) => s.kind === 'heading1' && s.lineFirst)).toBe(true);
    expect(visible('# Title\nbody', 11)).toBe('Title\nbody');
  });

  it('raw while the caret is on the heading line', () => {
    expect(at('# Title\nbody', 5)).toEqual([]);
  });

  it('treats #tag (no space) as a tag, not a heading', () => {
    expect(at('#tag text', 9)).toEqual([]);
  });

  it('replaces a --- line with the hr widget when away', () => {
    const specs = at('a\n---\nb', 7);
    expect(specs.some((s) => s.kind === 'hr')).toBe(true);
    expect(at('a\n---\nb', 4)).toEqual([]); // caret on the hr line
  });
});

describe('collectLivePreview — tables', () => {
  const table = 'intro\n| a | b |\n| --- | --- |\n| 1 | 2 |';

  it('replaces the whole run with one block table widget when the caret is away', () => {
    const specs = at(table, 2); // caret on "intro", outside the table
    const t = specs.filter((s) => s.kind === 'table');
    expect(t.length).toBe(1);
    expect(t[0].from).toBe(6);
    expect(t[0].to).toBe(table.length);
    expect(visible(table, 2)).toBe('intro\n'); // raw rows are replaced wholesale
  });

  it('STILL renders when the caret sits at the run end (doc end after the table)', () => {
    // Clicking into a block whose last lines are the table lands the caret
    // at doc end — the table must stay rendered, not flip back to raw.
    expect(at(table, table.length).some((s) => s.kind === 'table')).toBe(true);
  });

  it('raw while the caret is inside the table or at its start', () => {
    expect(at(table, 20).some((s) => s.kind === 'table')).toBe(false); // interior
    expect(at(table, 6).some((s) => s.kind === 'table')).toBe(false); // start (widget click)
  });

  it('does not treat pipe lines without a delimiter row as a table', () => {
    expect(at('a | b | c', 9)).toEqual([]);
  });

  it('leaves pipe lines inside code fences alone', () => {
    const doc = '```\n| a | b |\n| --- | --- |\n```';
    expect(at(doc, doc.length)).toEqual([]);
  });
});
