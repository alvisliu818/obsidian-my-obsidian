import { describe, expect, it } from 'vitest';
import {
  buildQueryTableModel,
  execQuery,
  normalizeLinkTarget,
  parseQuery,
  parseQueryTableText,
  parseQueryText,
  plainText,
  queryStringOf,
  queryTableStringOf,
  toDays,
  type QueryBlock,
} from '../src/features/query';

function mk(p: Partial<QueryBlock>): QueryBlock {
  return {
    path: 'notes/a.md',
    blockId: '',
    text: '',
    marker: null,
    tags: [],
    links: [],
    props: {},
    ...p,
  };
}

// NOTE: `links` must already be normalized (lowercase page basenames), as
// BlockIndex stores them that way.
const POOL: QueryBlock[] = [
  mk({ path: 'a.md', text: 'buy milk', marker: 'TODO', tags: ['errand'], links: [] }),
  mk({ path: 'a.md', text: 'write report', marker: 'DOING', tags: ['work'], links: ['x'] }),
  mk({ path: 'b.md', text: 'done task', marker: 'DONE', tags: [], links: [] }),
  mk({ path: 'b.md', text: 'plain note about [[Projects/X]]', tags: ['work/project'], links: ['x'] }),
  mk({ path: 'c.md', text: 'no marker here', tags: [], links: ['journal'] }),
];

describe('queryStringOf', () => {
  it('extracts the body from a query block', () => {
    expect(queryStringOf('{{query (TODO)}}')).toBe('(TODO)');
    expect(queryStringOf('{{query (TODO) #urgent}}')).toBe('(TODO) #urgent');
    expect(queryStringOf('  {{query (all)}}  ')).toBe('(all)');
  });

  it('rejects non-query text', () => {
    expect(queryStringOf('hello')).toBeNull();
    expect(queryStringOf('{{query}}')).toBeNull();
    expect(queryStringOf('{{query }}')).toBeNull();
    expect(queryStringOf('prefix {{query (TODO)}}')).toBeNull();
  });
});

describe('parseQuery', () => {
  it('parses markers', () => {
    expect(parseQuery('(TODO)')).toEqual({ t: 'marker', marker: 'TODO' });
    expect(parseQuery('(doing)')).toEqual({ t: 'marker', marker: 'DOING' });
  });

  it('parses tags, pages, text', () => {
    expect(parseQuery('#urgent')).toEqual({ t: 'tag', tag: 'urgent' });
    expect(parseQuery('[[Projects/X]]')).toEqual({ t: 'page', page: 'Projects/X' });
    expect(parseQuery('"buy milk"')).toEqual({ t: 'text', text: 'buy milk' });
  });

  it('parses combinators', () => {
    expect(parseQuery('(or (TODO) (DOING))')).toEqual({
      t: 'or',
      children: [
        { t: 'marker', marker: 'TODO' },
        { t: 'marker', marker: 'DOING' },
      ],
    });
    expect(parseQuery('(and (TODO) #urgent)')).toEqual({
      t: 'and',
      children: [
        { t: 'marker', marker: 'TODO' },
        { t: 'tag', tag: 'urgent' },
      ],
    });
    expect(parseQuery('(not (TODO))')).toEqual({ t: 'not', child: { t: 'marker', marker: 'TODO' } });
  });

  it('implicit and for bare sequences', () => {
    expect(parseQuery('(TODO) #urgent')).toEqual({
      t: 'and',
      children: [
        { t: 'marker', marker: 'TODO' },
        { t: 'tag', tag: 'urgent' },
      ],
    });
  });

  it('parses (all)', () => {
    expect(parseQuery('(all)')).toEqual({ t: 'all' });
  });

  it('nested groups', () => {
    const ast = parseQuery('(and (or (TODO) (DOING)) (not #later))');
    expect(ast).toEqual({
      t: 'and',
      children: [
        {
          t: 'or',
          children: [
            { t: 'marker', marker: 'TODO' },
            { t: 'marker', marker: 'DOING' },
          ],
        },
        { t: 'not', child: { t: 'tag', tag: 'later' } },
      ],
    });
  });

  it('returns null on syntax errors', () => {
    expect(parseQuery('(TODO')).toBeNull();
    expect(parseQuery('TODO)')).toBeNull();
    expect(parseQuery('(bogus)')).toBeNull();
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('((broken')).toBeNull();
  });
});

describe('parseQueryText', () => {
  it('full block text → ast', () => {
    expect(parseQueryText('{{query (TODO)}}')).toEqual({ t: 'marker', marker: 'TODO' });
    expect(parseQueryText('random text')).toBeNull();
  });
});

describe('normalizeLinkTarget', () => {
  it('strips alias, subpath, extension, folder', () => {
    expect(normalizeLinkTarget('Page')).toBe('page');
    expect(normalizeLinkTarget('folder/Page')).toBe('page');
    expect(normalizeLinkTarget('Page|alias')).toBe('page');
    expect(normalizeLinkTarget('Page#heading')).toBe('page');
    expect(normalizeLinkTarget('note.md')).toBe('note');
    expect(normalizeLinkTarget('folder\\Page')).toBe('page');
  });
});

describe('execQuery', () => {
  it('marker query', () => {
    const out = execQuery(parseQuery('(TODO)')!, POOL);
    expect(out.map((b) => b.text)).toEqual(['buy milk']);
  });

  it('or query', () => {
    const out = execQuery(parseQuery('(or (TODO) (DOING))')!, POOL);
    expect(out).toHaveLength(2);
  });

  it('tag query includes sub-tags', () => {
    const out = execQuery(parseQuery('#work')!, POOL);
    expect(out.map((b) => b.text)).toEqual(['write report', 'plain note about [[Projects/X]]']);
  });

  it('page link query normalizes targets', () => {
    const out = execQuery(parseQuery('[[projects/x]]')!, POOL);
    expect(out).toHaveLength(2);
    const out2 = execQuery(parseQuery('[[X]]')!, POOL);
    expect(out2).toHaveLength(2);
  });

  it('text query is case-insensitive', () => {
    const out = execQuery(parseQuery('"BUY"')!, POOL);
    expect(out.map((b) => b.text)).toEqual(['buy milk']);
  });

  it('and / not', () => {
    const out = execQuery(parseQuery('(and (not (TODO)) #work)')!, POOL);
    expect(out.map((b) => b.text)).toEqual(['write report', 'plain note about [[Projects/X]]']);
    // buy milk is TODO #errand → excluded by (not #errand)
    const out2 = execQuery(parseQuery('(and (TODO) (not #errand))')!, POOL);
    expect(out2).toHaveLength(0);
    const out3 = execQuery(parseQuery('(and (TODO) #errand)')!, POOL);
    expect(out3.map((b) => b.text)).toEqual(['buy milk']);
  });

  it('all matches everything', () => {
    expect(execQuery(parseQuery('(all)')!, POOL)).toHaveLength(POOL.length);
  });

  it('preserves generic type', () => {
    interface Ext extends QueryBlock {
      extra: number;
    }
    const pool: Ext[] = [mk({ text: 'x' }) as Ext, mk({ text: 'y', marker: 'TODO' }) as Ext];
    const out = execQuery<Ext>(parseQuery('(TODO)')!, pool);
    expect(out[0].extra).toBeUndefined();
    expect(out[0].text).toBe('y');
  });
});

describe('plainText', () => {
  it('strips markdown noise', () => {
    expect(plainText('**bold** and *ital*')).toBe('bold and ital');
    expect(plainText('[[Projects/X|my project]] note')).toBe('my project note');
    expect(plainText('[[Projects/X]] note')).toBe('Projects/X note');
    expect(plainText('`code`')).toBe('code');
    expect(plainText('[label](http://x)')).toBe('label');
    expect(plainText('==highlight==')).toBe('highlight');
  });
});

// ---------------------------------------------------------------------------
// V4: priority / date queries
// ---------------------------------------------------------------------------

const NOW = new Date(2026, 8, 9); // 2026-09-09 local

const POOL2: QueryBlock[] = [
  mk({ path: 'a.md', text: 'urgent thing', marker: 'TODO', props: { priority: 'A', deadline: '2026-09-05' } }),
  mk({ path: 'a.md', text: 'normal thing', marker: 'TODO', props: { priority: 'B' } }),
  mk({ path: 'b.md', text: 'today thing', props: { scheduled: '2026-09-09' } }),
  mk({ path: 'b.md', text: 'future thing', props: { scheduled: '2026-10-01' } }),
  mk({ path: 'c.md', text: 'no props' }),
];

describe('priority / date queries', () => {
  it('parses (priority A)', () => {
    expect(parseQuery('(priority A)')).toEqual({ t: 'priority', level: 'A' });
    expect(parseQuery('(priority a)')).toEqual({ t: 'priority', level: 'A' });
    expect(parseQuery('(priority)')).toEqual({ t: 'priority', level: null });
    expect(parseQuery('(priority D)')).toBeNull();
  });

  it('parses date operators', () => {
    expect(parseQuery('(deadline <= "today")')).toEqual({
      t: 'date',
      kind: 'deadline',
      op: '<=',
      a: 'today',
    });
    expect(parseQuery('(scheduled before "2026-09-09")')).toEqual({
      t: 'date',
      kind: 'scheduled',
      op: 'before',
      a: '2026-09-09',
    });
    expect(parseQuery('(scheduled between "2026-09-01" "2026-09-30")')).toEqual({
      t: 'date',
      kind: 'scheduled',
      op: 'between',
      a: '2026-09-01',
      b: '2026-09-30',
    });
    expect(parseQuery('(scheduled ~> "x")')).toBeNull();
    expect(parseQuery('(scheduled before today)')).toBeNull(); // date must be quoted
  });

  it('priority filter', () => {
    const out = execQuery(parseQuery('(priority A)')!, POOL2, NOW);
    expect(out.map((b) => b.text)).toEqual(['urgent thing']);
    const any = execQuery(parseQuery('(priority)')!, POOL2, NOW);
    expect(any.map((b) => b.text)).toEqual(['urgent thing', 'normal thing']);
  });

  it('date filters with relative words', () => {
    // deadline <= today: 2026-09-05 <= 2026-09-09
    const out = execQuery(parseQuery('(deadline <= "today")')!, POOL2, NOW);
    expect(out.map((b) => b.text)).toEqual(['urgent thing']);
    // scheduled before today: none (2026-09-09 is not < today)
    const out2 = execQuery(parseQuery('(scheduled before "today")')!, POOL2, NOW);
    expect(out2).toHaveLength(0);
    // scheduled after today: 2026-10-01
    const out3 = execQuery(parseQuery('(scheduled after "today")')!, POOL2, NOW);
    expect(out3.map((b) => b.text)).toEqual(['future thing']);
  });

  it('between filter', () => {
    const out = execQuery(parseQuery('(scheduled between "2026-09-01" "2026-09-30")')!, POOL2, NOW);
    expect(out.map((b) => b.text)).toEqual(['today thing']);
  });

  it('combines with markers', () => {
    const out = execQuery(parseQuery('(and (TODO) (priority A))')!, POOL2, NOW);
    expect(out.map((b) => b.text)).toEqual(['urgent thing']);
  });

  it('toDays handles relative words and dates', () => {
    expect(toDays('today', NOW)).toBe(toDays('2026-09-09', NOW));
    expect(toDays('yesterday', NOW)).toBe(toDays('2026-09-08', NOW));
    expect(toDays('tomorrow', NOW)).toBe(toDays('2026-09-10', NOW));
    expect(toDays('garbage', NOW)).toBeNull();
    expect(toDays('2026-09-09 14:30', NOW)).toBe(toDays('2026-09-09', NOW));
  });
});

// ---------------------------------------------------------------------------
// V5: {{query-table ...}}
// ---------------------------------------------------------------------------

describe('query-table', () => {
  it('queryTableStringOf extracts the body', () => {
    expect(queryTableStringOf('{{query-table (TODO)}}')).toBe('(TODO)');
    expect(queryTableStringOf('  {{query-table (and (TODO) #work)}}  ')).toBe('(and (TODO) #work)');
  });

  it('queryTableStringOf rejects other text', () => {
    expect(queryTableStringOf('{{query (TODO)}}')).toBeNull();
    expect(queryTableStringOf('{{query-table}}')).toBeNull();
    expect(queryTableStringOf('hello')).toBeNull();
  });

  it('parseQueryTableText shares the query grammar', () => {
    expect(parseQueryTableText('{{query-table (TODO)}}')).toEqual({ t: 'marker', marker: 'TODO' });
    expect(parseQueryTableText('{{query-table (bogus)}}')).toBeNull();
    expect(parseQueryTableText('{{query (TODO)}}')).toBeNull();
  });

  it('buildQueryTableModel derives dynamic property columns', () => {
    const results = execQuery(parseQuery('(TODO)')!, POOL2, NOW);
    const model = buildQueryTableModel(results);
    // urgent thing has priority+deadline, normal thing has priority
    expect(model.columns).toEqual(['deadline', 'priority']);
    expect(model.rows.map((r) => r.text)).toEqual(['urgent thing', 'normal thing']);
    expect(model.rows[0].props['priority']).toBe('A');
    expect(model.rows[1].props['deadline']).toBeUndefined();
  });

  it('buildQueryTableModel hides engine-internal props', () => {
    const pool: QueryBlock[] = [
      mk({ text: 'x', props: { id: 'u1', collapsed: 'true', type: 'book' } }),
    ];
    const model = buildQueryTableModel(pool);
    expect(model.columns).toEqual(['type']);
  });

  it('buildQueryTableModel with no props yields no extra columns', () => {
    const model = buildQueryTableModel([mk({ text: 'bare' })]);
    expect(model.columns).toEqual([]);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ text: 'bare', marker: null, blockId: '', path: 'notes/a.md' });
  });

  it('empty results produce an empty model', () => {
    const model = buildQueryTableModel([]);
    expect(model.columns).toEqual([]);
    expect(model.rows).toEqual([]);
  });
});
