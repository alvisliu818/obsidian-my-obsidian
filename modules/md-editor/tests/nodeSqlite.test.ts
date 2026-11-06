/**
 * NodeSqliteRuntime（M2-6）：node:sqlite 直连运行时的契约——与 waSqlite
 * 同一异步方法面，batch 事务语义（rc=0 成功 / rc=-1 回滚），exportImage
 * 恒空（persist 短路信号）。vitest 跑在 node 26 上，node:sqlite 原生可用。
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destroyNodeSqliteFile, NodeSqliteRuntime } from '../src/index/nodeSqlite';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'us-node-sqlite-'));
  file = join(dir, 'logseq-index.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('NodeSqliteRuntime', () => {
  it('run/all：建表、带参写入、按列序回位置数组、limit 截断', async () => {
    const rt = await NodeSqliteRuntime.open(file);
    try {
      await rt.run('CREATE TABLE t (a INTEGER, b TEXT)');
      await rt.run('INSERT INTO t VALUES (?, ?)', [1, '一']);
      await rt.run('INSERT INTO t VALUES (?, ?)', [2, '二']);
      const res = await rt.all('SELECT a, b FROM t ORDER BY a');
      expect(res.columns).toEqual(['a', 'b']);
      expect(res.rows).toEqual([[1, '一'], [2, '二']]);
      const capped = await rt.all('SELECT a FROM t', undefined, 1);
      expect(capped.rows).toHaveLength(1);
      const empty = await rt.all('SELECT a FROM t WHERE a = 99');
      expect(empty).toEqual({ columns: [], rows: [] });
    } finally {
      await rt.close();
    }
  });

  it('batch：整体提交（rc=0）；语句失败回滚整批（rc=-1）', async () => {
    const rt = await NodeSqliteRuntime.open(file);
    try {
      await rt.run('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
      const ok = await rt.batch(
        ['INSERT INTO t VALUES (?, ?)', 'INSERT INTO t VALUES (?, ?)'],
        [[1, 'x'], [2, 'y']],
      );
      expect(ok).toBe(0);
      const boom = await rt.batch(
        ['INSERT INTO t VALUES (?, ?)', 'INSERT INTO t VALUES (?, ?)'],
        [[3, 'z'], [1, 'dup']],
      );
      expect(boom).toBe(-1);
      const rows = await rt.all('SELECT a FROM t ORDER BY a');
      expect(rows.rows).toEqual([[1], [2]]); // 第三行随整批回滚
    } finally {
      await rt.close();
    }
  });

  it('直连模式：exportImage 恒空（persist 短路）、integrityCheck 通过、close 落盘', async () => {
    const rt = await NodeSqliteRuntime.open(file);
    await rt.run('CREATE TABLE t (a INTEGER)');
    expect(rt.exportImage().byteLength).toBe(0);
    expect(await rt.integrityCheck()).toBe(true);
    await rt.close();
    expect(existsSync(file)).toBe(true);
    // 重开数据仍在（文件即库，无镜像往返）
    const rt2 = await NodeSqliteRuntime.open(file);
    const rows = await rt2.all('SELECT COUNT(*) AS c FROM t');
    expect(rows.rows).toEqual([[0]]);
    await rt2.close();
  });

  it('destroyNodeSqliteFile：连 WAL 伴生文件一起清（判废重建用）', async () => {
    const rt = await NodeSqliteRuntime.open(file);
    await rt.run('CREATE TABLE t (a INTEGER)');
    await rt.close();
    destroyNodeSqliteFile(file);
    expect(existsSync(file)).toBe(false);
    // 不存在的文件静默通过
    expect(() => destroyNodeSqliteFile(file)).not.toThrow();
  });
});
