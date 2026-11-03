/**
 * The SQLite secondary index against a REAL wa-sqlite wasm (resolved through
 * PnP) and a fake vault. The point of these tests is the contract: markdown is
 * the truth, the database is a rebuildable cache of it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setWasmProvider } from '../src/index/waSqlite';
import { SqliteIndex, type SqliteFileSource, type SqliteSnapshotStore } from '../src/index/sqliteIndex';

beforeAll(() => {
  // PnP 下没有 node_modules 目录——用包说明符解析出 wa-sqlite 的实际位置
  // （unplugged 实路径），而不是写死的相对路径。
  const pnpRequire = createRequire(import.meta.url);
  const wasmPath = pnpRequire.resolve('wa-sqlite/dist/wa-sqlite.wasm');
  setWasmProvider(() => new Uint8Array(readFileSync(wasmPath)));
});

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class FakeVault implements SqliteFileSource {
  private content = new Map<string, string>();
  private mtime = new Map<string, number>();
  private clock = 1_000;

  set(path: string, text: string): void {
    this.content.set(path, text);
    this.mtime.set(path, (this.mtime.get(path) ?? 0) || ++this.clock);
  }

  /** Edit WITHOUT moving mtime — the case only `verify()` can catch. */
  silentEdit(path: string, text: string): void {
    this.content.set(path, text);
  }

  touch(path: string): void {
    this.mtime.set(path, ++this.clock);
  }

  remove(path: string): void {
    this.content.delete(path);
    this.mtime.delete(path);
  }

  listMarkdownFiles() {
    return [...this.content.keys()].map((path) => ({
      path,
      mtime: this.mtime.get(path) ?? 0,
      size: Buffer.byteLength(this.content.get(path) ?? '', 'utf8'),
    }));
  }

  async read(path: string): Promise<string> {
    const v = this.content.get(path);
    if (v === undefined) throw new Error(`missing ${path}`);
    return v;
  }
}

class FakeSnapshot implements SqliteSnapshotStore {
  bytes: Uint8Array | null = null;
  writes = 0;
  async load(): Promise<Uint8Array | null> {
    return this.bytes;
  }
  async save(bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
    this.writes++;
  }
}

const mk = (vault: FakeVault, snap?: FakeSnapshot): SqliteIndex =>
  new SqliteIndex({ source: vault, snapshot: snap ?? null });

function seedVault(): FakeVault {
  const v = new FakeVault();
  v.set('pages/Project.md', `title:: Project A\nstatus:: active\n\n- kickoff #work [[Person]]\nid:: ${ID_A}\n\t- detail ((${ID_B}))\n`);
  v.set('pages/Person.md', `- a person\nid:: ${ID_B}\n- TODO call back\n`);
  return v;
}

describe('rebuild — markdown -> rows', () => {
  it('indexes blocks, tags, links, refs, props and page props', async () => {
    const idx = mk(seedVault());
    const stats = await idx.rebuild();
    expect(stats.files).toBe(2);
    expect(stats.blocks).toBe(5);
    expect(stats.tags).toBe(1);
    expect(stats.links).toBe(1);
    expect(stats.refs).toBe(1);
    expect(stats.props).toBe(4);
    expect(stats.fullRebuild).toBe(true);
    await idx.close();
  });

  it('a block row carries its outline position and page', async () => {
    const idx = mk(seedVault());
    await idx.rebuild();
    const res = await idx.query(
      "SELECT bkey, block_id, depth, parent_key, text, marker, page FROM blocks WHERE text LIKE 'kickoff%'",
    );
    expect(res.error).toBe('');
    expect(res.rows[0]).toEqual([ID_A, ID_A, 0, '', 'kickoff #work [[Person]]', null, 'project']);
    await idx.close();
  });

  it('page properties land in their own table', async () => {
    const idx = mk(seedVault());
    await idx.rebuild();
    const res = await idx.query("SELECT key, value FROM page_props WHERE path = 'pages/Project.md' ORDER BY key");
    expect(res.rows).toEqual([
      ['status', 'active'],
      ['title', 'Project A'],
    ]);
    await idx.close();
  });

  it('the task marker survives', async () => {
    const idx = mk(seedVault());
    await idx.rebuild();
    const res = await idx.query("SELECT text, marker FROM blocks WHERE marker IS NOT NULL");
    expect(res.rows).toEqual([['call back', 'TODO']]);
    await idx.close();
  });

  it('joins resolve a ((block ref)) back to its block', async () => {
    const idx = mk(seedVault());
    await idx.rebuild();
    const res = await idx.query(
      'SELECT r.target_id, b.text FROM refs r JOIN blocks b ON b.block_id = r.target_id',
    );
    expect(res.rows).toEqual([[ID_B, 'a person']]);
    await idx.close();
  });
});

describe('sync — keeping the database and the files in step', () => {
  it('a no-op sync touches nothing', async () => {
    const idx = mk(seedVault());
    await idx.rebuild();
    const again = await idx.sync();
    expect(again.changed).toBe(0);
    expect(again.added).toBe(0);
    expect(again.removed).toBe(0);
    expect(again.unchanged).toBe(2);
    await idx.close();
  });

  it('an edit made outside the editor is picked up through mtime', async () => {
    const vault = seedVault();
    const idx = mk(vault);
    await idx.rebuild();
    vault.set('pages/Person.md', '- a person\nid:: ' + ID_B + '\n- TODO call back\n- NEW LINE\n');
    const stats = await idx.sync();
    expect(stats.changed).toBe(1);
    const res = await idx.query("SELECT COUNT(*) FROM blocks WHERE path = 'pages/Person.md'");
    expect(res.rows[0][0]).toBe(3);
    await idx.close();
  });

  it('a new file is added and a deleted file is forgotten', async () => {
    const vault = seedVault();
    const idx = mk(vault);
    await idx.rebuild();
    vault.set('pages/New.md', '- fresh #idea\n');
    vault.remove('pages/Person.md');
    const stats = await idx.sync();
    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(1);
    const left = await idx.query('SELECT DISTINCT path FROM blocks ORDER BY path');
    expect(left.rows.map((r) => r[0])).toEqual(['pages/New.md', 'pages/Project.md']);
    await idx.close();
  });

  it('deleting a file removes its child rows too (no orphans)', async () => {
    const vault = seedVault();
    const idx = mk(vault);
    await idx.rebuild();
    vault.remove('pages/Project.md');
    await idx.sync();
    const orphanTags = await idx.query(
      'SELECT COUNT(*) FROM tags t LEFT JOIN blocks b ON b.bkey = t.bkey WHERE b.bkey IS NULL',
    );
    const orphanProps = await idx.query(
      'SELECT COUNT(*) FROM props p LEFT JOIN blocks b ON b.bkey = p.bkey WHERE b.bkey IS NULL',
    );
    expect(orphanTags.rows[0][0]).toBe(0);
    expect(orphanProps.rows[0][0]).toBe(0);
    await idx.close();
  });

  it('syncFile re-indexes just that one file', async () => {
    const vault = seedVault();
    const idx = mk(vault);
    await idx.rebuild();
    vault.set('pages/Person.md', '- rewritten\n');
    await idx.syncFile('pages/Person.md');
    const res = await idx.query("SELECT text FROM blocks WHERE path = 'pages/Person.md'");
    expect(res.rows).toEqual([['rewritten']]);
    await idx.close();
  });

  it('a rebuild after drift produces the same rows as a fresh build', async () => {
    const vault = seedVault();
    const first = mk(vault);
    await first.rebuild();
    const before = await first.query('SELECT bkey, text, depth FROM blocks ORDER BY path, ord');
    await first.close();

    const second = mk(vault);
    await second.rebuild();
    const after = await second.query('SELECT bkey, text, depth FROM blocks ORDER BY path, ord');
    expect(after.rows).toEqual(before.rows);
    await second.close();
  });
});

describe('persistence — the snapshot is disposable', () => {
  it('a saved image is restored instead of rebuilt', async () => {
    const vault = seedVault();
    const snap = new FakeSnapshot();
    const first = mk(vault, snap);
    await first.rebuild();
    await first.close();
    expect(snap.writes).toBeGreaterThan(0);

    const second = mk(vault, snap);
    await second.open();
    const res = await second.query('SELECT COUNT(*) FROM blocks');
    expect(res.rows[0][0]).toBe(5);
    await second.close();
  });

  it('a corrupt image is thrown away and rebuilt from markdown', async () => {
    const vault = seedVault();
    const snap = new FakeSnapshot();
    const first = mk(vault, snap);
    await first.rebuild();
    await first.close();
    snap.bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const second = mk(vault, snap);
    await second.open();
    expect(second.lastError).toBe('');
    // Discarding leaves a schema-correct but EMPTY database …
    const empty = await second.query('SELECT COUNT(*) FROM blocks');
    expect(empty.rows[0][0]).toBe(0);
    // … and an empty `files` table makes the next sync re-derive everything.
    const rebuilt = await second.sync();
    expect(rebuilt.fullRebuild).toBe(true);
    expect(rebuilt.blocks).toBe(5);
    await second.close();
  });

  it('an image written by an older schema version is discarded', async () => {
    const vault = seedVault();
    const snap = new FakeSnapshot();
    const first = mk(vault, snap);
    await first.rebuild();
    await first.query("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    await first.close();

    const second = mk(vault, snap);
    await second.open();
    const v = await second.query("SELECT value FROM meta WHERE key = 'schema_version'");
    expect(v.rows[0][0]).toBe('1');
    const rebuilt = await second.sync();
    expect(rebuilt.blocks).toBe(5);
    await second.close();
  });
});

describe('verify — markdown is the authority', () => {
  it('reports nothing when files and rows agree', async () => {
    const idx = mk(seedVault());
    await idx.rebuild();
    const res = await idx.verify();
    expect(res.checked).toBe(2);
    expect(res.drift).toEqual([]);
    expect(res.missing).toEqual([]);
    await idx.close();
  });

  it('catches drift that mtime/size cannot see', async () => {
    const vault = seedVault();
    const idx = mk(vault);
    await idx.rebuild();
    // Same byte length, same mtime, different bytes: only a content
    // fingerprint can detect this.
    vault.silentEdit('pages/Person.md', '- a persom\nid:: ' + ID_B + '\n- TODO call back\n');
    const res = await idx.verify();
    expect(res.drift).toEqual(['pages/Person.md']);
    await idx.close();
  });

  it('reports a vault file that was never indexed', async () => {
    const vault = seedVault();
    const idx = mk(vault);
    await idx.rebuild();
    vault.set('pages/Late.md', '- late\n');
    const res = await idx.verify();
    expect(res.missing).toContain('pages/Late.md');
    await idx.close();
  });
});

describe('query errors', () => {
  it('a bad statement is reported, not thrown', async () => {
    const idx = mk(seedVault());
    await idx.rebuild();
    const res = await idx.query('SELECT * FROM nope');
    expect(res.error).not.toBe('');
    expect(res.rows).toEqual([]);
    await idx.close();
  });
});
