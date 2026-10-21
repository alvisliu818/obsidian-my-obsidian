/**
 * `attachTo` — where a nested mount hangs.
 *
 * It used to be only a host mount's id, which could only ever hang a mount on
 * the host's own root. It now also accepts `hostId/rel`, so a mount can hang on
 * ANY node inside the host: a subfolder, or a single file. That is what makes
 * "挂载的文件或文件夹下的子文件或子文件夹也能再挂载" work.
 *
 * These tests pin the parser and the two things that depend on it — the
 * self-reference check and the cycle check — because both are what keep a
 * hand-edited `data.json` from producing a render loop.
 */

import { describe, expect, it } from 'vitest';
import { mountFrom, mountsFrom, mountHostOf, mountHostLabel, type ExternalMount } from '../src/types';

const base = {
  path: 'D:\\notes',
  label: '',
  include: '',
  exclude: '',
  refreshSeconds: 0,
  enabled: true,
  pinned: false,
};

const mk = (id: string, attachTo?: string): ExternalMount => ({
  ...base,
  id,
  ...(attachTo ? { attachTo } : {}),
});

describe('mountHostOf', () => {
  it('a bare id means the host root', () => {
    expect(mountHostOf('host1')).toEqual({ hostId: 'host1', hostRel: '' });
  });

  it('splits on the FIRST slash: ids never contain one', () => {
    expect(mountHostOf('host1/sub/dir')).toEqual({ hostId: 'host1', hostRel: 'sub/dir' });
  });

  it('a file rel keeps its extension', () => {
    expect(mountHostOf('host1/notes/a.md')).toEqual({ hostId: 'host1', hostRel: 'notes/a.md' });
  });

  it('tolerates leading and trailing slashes', () => {
    expect(mountHostOf('host1//sub//')).toEqual({ hostId: 'host1', hostRel: 'sub' });
  });
});

describe('mountFrom — attachTo sanitising', () => {
  it('keeps a valid host', () => {
    const m = mountFrom({ ...base, id: 'child', attachTo: 'host1' });
    expect(m?.attachTo).toBe('host1');
  });

  it('keeps a host plus sub-path', () => {
    const m = mountFrom({ ...base, id: 'child', attachTo: 'host1/sub/dir' });
    expect(m?.attachTo).toBe('host1/sub/dir');
  });

  it('drops self-reference even when written with a sub-path', () => {
    // `child/sub` would name the child as its own host — a one-node cycle.
    const m = mountFrom({ ...base, id: 'child', attachTo: 'child/sub' });
    expect(m?.attachTo).toBeUndefined();
  });

  it('drops a bare self-reference', () => {
    const m = mountFrom({ ...base, id: 'child', attachTo: 'child' });
    expect(m?.attachTo).toBeUndefined();
  });

  it('drops non-string and empty values', () => {
    expect(mountFrom({ ...base, id: 'c', attachTo: 42 })?.attachTo).toBeUndefined();
    expect(mountFrom({ ...base, id: 'c', attachTo: '   ' })?.attachTo).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    const m = mountFrom({ ...base, id: 'c', attachTo: '  host1/sub  ' });
    expect(m?.attachTo).toBe('host1/sub');
  });
});

describe('mountsFrom — cycle detection follows the host id', () => {
  /** Re-walk the host chain the way the renderer does; true if it loops. */
  const hasCycle = (list: ExternalMount[]): boolean => {
    const byId = new Map(list.map((m) => [m.id, m]));
    for (const m of list) {
      const seen = new Set<string>([m.id]);
      let cur = m.attachTo ? byId.get(mountHostOf(m.attachTo).hostId) : undefined;
      while (cur) {
        if (seen.has(cur.id)) return true;
        seen.add(cur.id);
        cur = cur.attachTo ? byId.get(mountHostOf(cur.attachTo).hostId) : undefined;
      }
    }
    return false;
  };

  it('a two-node cycle A→B→A is broken', () => {
    // Only the entry that CLOSES the loop loses its attachTo; what remains is a
    // plain chain, which renders fine. What must never survive is the loop.
    const out = mountsFrom([mk('a', 'b'), mk('b', 'a')]);
    expect(hasCycle(out)).toBe(false);
    expect(out).toHaveLength(2);
  });

  it('a three-node cycle is caught too', () => {
    const out = mountsFrom([mk('a', 'b'), mk('b', 'c'), mk('c', 'a')]);
    expect(hasCycle(out)).toBe(false);
  });

  it('a self-referencing sub-path never survives mountFrom', () => {
    // `a/a/sub` would make a host of itself — caught before it can loop.
    const out = mountsFrom([mk('a', 'a/sub')]);
    expect(out[0].attachTo).toBeUndefined();
  });

  it('a deep chain that is NOT cyclic survives intact', () => {
    const out = mountsFrom([mk('a'), mk('b', 'a'), mk('c', 'b/sub')]);
    expect(out.find((m) => m.id === 'c')?.attachTo).toBe('b/sub');
    expect(hasCycle(out)).toBe(false);
  });

  it('a chain into a missing host is left alone (renders top level)', () => {
    const out = mountsFrom([mk('b', 'ghost/sub')]);
    expect(out[0].attachTo).toBe('ghost/sub');
  });
});

describe('mountHostLabel', () => {
  const mounts = [mk('host1')];

  it('names the host when hung on its root', () => {
    expect(mountHostLabel({ ...base, id: 'c', attachTo: 'host1' }, mounts)).toBe('notes');
  });

  it('appends the sub-path when hung deeper', () => {
    // The sub-path stays as one path (`sub/dir`), not split into crumbs: it
    // reads as "inside notes, under sub/dir", which is what it is.
    expect(mountHostLabel({ ...base, id: 'c', attachTo: 'host1/sub/dir' }, mounts)).toBe('notes / sub/dir');
  });

  it('falls back to the raw id when the host is gone', () => {
    expect(mountHostLabel({ ...base, id: 'c', attachTo: 'ghost/sub' }, mounts)).toBe('ghost / sub');
  });
});
