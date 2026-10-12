import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseNotes, verifyRelease } from '../scripts/verify-release.mjs';

function fixture() {
  const sha = 'a'.repeat(40);
  const upstreamSha = 'b'.repeat(40);
  const repository = 'example/plugin';
  const upstream = 'material-extensions/vscode-material-icon-theme';
  const locked = {
    version: '5.38.1',
    resolved: 'https://registry.npmjs.org/material-icon-theme/-/material-icon-theme-5.38.1.tgz',
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  };
  const context = {
    ref: 'refs/tags/1.3.1', sha, head: sha, repository,
    pkg: { version: '1.3.1', devDependencies: { 'material-icon-theme': '5.38.1' } },
    manifest: { version: '1.3.1' },
    lock: { packages: { 'node_modules/material-icon-theme': locked } },
  };
  const release = { tag_name: 'v5.38.1', draft: false, prerelease: false, published_at: '2026-08-24T07:12:51Z' };
  const metadata = { version: '5.38.1', gitHead: upstreamSha, dist: { tarball: locked.resolved, integrity: locked.integrity } };
  const responses = {
    [`repos/${repository}/git/ref/tags/1.3.1`]: { object: { type: 'commit', sha } },
    [`repos/${upstream}/releases/tags/v5.38.1`]: release,
    [`repos/${upstream}/git/ref/tags/v5.38.1`]: { object: { type: 'tag', sha: 'c'.repeat(40) } },
    [`repos/${upstream}/git/tags/${'c'.repeat(40)}`]: { object: { type: 'commit', sha: upstreamSha } },
  };
  const clients = {
    github: (endpoint) => {
      assert.ok(endpoint in responses, `未预期的请求：${endpoint}`);
      return responses[endpoint];
    },
    registry: (version) => {
      assert.equal(version, '5.38.1');
      return metadata;
    },
  };
  return { context, clients, responses, release, metadata, locked, upstream, upstreamSha };
}

test('正式发布通过核验，发布说明保留完整来源证据', () => {
  const f = fixture();
  const source = verifyRelease(f.context, f.clients);
  const notes = releaseNotes(source);
  assert.ok(notes.includes(f.context.sha));
  assert.ok(notes.includes(f.upstreamSha));
  assert.ok(notes.includes('/releases/tag/v5.38.1'));
  assert.ok(notes.includes(f.locked.resolved));
  assert.ok(notes.includes(f.locked.integrity));
});

test('上游轻量标签也解析到最终提交', () => {
  const f = fixture();
  f.responses[`repos/${f.upstream}/git/ref/tags/v5.38.1`].object = { type: 'commit', sha: f.upstreamSha };
  assert.equal(verifyRelease(f.context, f.clients).upstreamSha, f.upstreamSha);
});

for (const [name, change, error] of [
  ['分支触发', (f) => { f.context.ref = 'refs/heads/main'; }, /版本标签/],
  ['下游预发布标签', (f) => { f.context.ref = 'refs/tags/1.3.1-beta.1'; }, /正式版本/],
  ['构建提交错误', (f) => { f.context.head = 'd'.repeat(40); }, /实际构建提交/],
  ['包版本错误', (f) => { f.context.pkg.version = '1.3.0'; }, /package.json/],
  ['插件版本错误', (f) => { f.context.manifest.version = '1.3.0'; }, /manifest.json/],
  ['浮动上游依赖', (f) => { f.context.pkg.devDependencies['material-icon-theme'] = '^5.38.1'; }, /精确版本/],
  ['上游预发布包', (f) => { f.locked.version = '5.38.1-beta.1'; }, /正式版本/],
  ['远端标签移动', (f) => { f.responses['repos/example/plugin/git/ref/tags/1.3.1'].object.sha = 'd'.repeat(40); }, /远端发布标签/],
  ['上游草稿', (f) => { f.release.draft = true; }, /草稿/],
  ['上游预发布', (f) => { f.release.prerelease = true; }, /预发布/],
  ['上游未发布', (f) => { f.release.published_at = null; }, /尚未正式发布/],
  ['发布标签错误', (f) => { f.release.tag_name = 'v5.38.0'; }, /上游发布标签/],
  ['发布包版本错误', (f) => { f.metadata.version = '5.38.0'; }, /发布包版本/],
  ['源码提交错误', (f) => { f.metadata.gitHead = 'd'.repeat(40); }, /源码提交/],
  ['缺失源码证据', (f) => { delete f.metadata.gitHead; }, /源码提交/],
  ['发布包地址错误', (f) => { f.metadata.dist.tarball += '.other'; }, /发布包地址/],
  ['完整性值错误', (f) => { f.metadata.dist.integrity += 'x'; }, /完整性校验值/],
]) {
  test(`阻止发布：${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => verifyRelease(f.context, f.clients), error);
  });
}

test('官方来源查询失败时不生成发布说明', () => {
  const f = fixture();
  f.clients.github = () => { throw new Error('HTTP 404'); };
  assert.throws(() => releaseNotes(verifyRelease(f.context, f.clients)), /HTTP 404/);
});

function runPublisher(t, extraEnv = {}, tag = '1.3.1') {
  const dir = mkdtempSync(join(tmpdir(), 'icon-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const previous = fs.existsSync(process.env.RELEASE_TEST_LOG) ? fs.readFileSync(process.env.RELEASE_TEST_LOG, 'utf8') : '';
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'repo' && args[1] === 'view') console.log('example/plugin');
else if (args[0] === 'api') {
  if (args[1].includes('/contents/') && process.env.RELEASE_TEST_LEGACY_TAG) process.exit(1);
  process.exit(Number(process.env.RELEASE_TEST_TAG_STATUS ?? 0));
}
else if (args[0] === 'run' && args[1] === 'list') {
  if (!args.includes('--branch')) console.log('12');
  else if (previous.includes('--branch')) console.log('13');
} else if (args[0] === 'workflow' && args[1] === 'run') {
  if (process.env.RELEASE_TEST_DISPATCH_STATUS) process.exit(1);
  if (!process.env.RELEASE_TEST_NO_URL) console.log('https://github.com/example/plugin/actions/runs/13');
} else if (args[0] === 'run' && args[1] === 'watch') process.exit(Number(process.env.RELEASE_TEST_WATCH_STATUS ?? 0));
else throw new Error('意外调用：' + JSON.stringify(args));
`, { mode: 0o700 });
  const result = spawnSync('bash', [fileURLToPath(new URL('../scripts/release.sh', import.meta.url)), tag], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RELEASE_TEST_LOG: log, ...extraEnv },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...result, calls };
}

test('本地入口触发指定远端标签，并等待返回的运行编号', (t) => {
  const result = runPublisher(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.find((args) => args[0] === 'workflow'), ['workflow', 'run', 'release.yml', '--repo', 'example/plugin', '--ref', '1.3.1']);
  assert.deepEqual(result.calls.at(-1), ['run', 'watch', '13', '--repo', 'example/plugin', '--exit-status']);
  assert.match(result.stdout, /发布完成/);
  assert.ok(result.calls.every((args) => args[0] !== 'release'));
});

test('没有运行链接时等待新增运行，不跟进旧运行', (t) => {
  const result = runPublisher(t, { RELEASE_TEST_NO_URL: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter((args) => args.includes('--branch')).length, 2);
  assert.equal(result.calls.at(-1)[2], '13');
});

for (const [name, env] of [
  ['远端标签不存在', { RELEASE_TEST_TAG_STATUS: '1' }],
  ['历史标签没有核验脚本', { RELEASE_TEST_LEGACY_TAG: '1' }],
  ['触发失败', { RELEASE_TEST_DISPATCH_STATUS: '1' }],
  ['发布运行失败', { RELEASE_TEST_WATCH_STATUS: '1' }],
]) {
  test(`本地入口正确报告失败：${name}`, (t) => {
    const result = runPublisher(t, env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /发布完成/);
  });
}

test('非法标签在调用远端之前被拒绝', (t) => {
  const result = runPublisher(t, {}, 'refs/heads/main');
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 0);
});
