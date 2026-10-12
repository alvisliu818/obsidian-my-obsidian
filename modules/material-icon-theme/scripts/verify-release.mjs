import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageName = 'material-icon-theme';
const upstreamRepository = 'material-extensions/vscode-material-icon-theme';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitSha = /^[0-9a-f]{40}$/;

function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim();
}

function githubJson(endpoint) {
  return JSON.parse(command('gh', ['api', endpoint]));
}

function npmJson(version) {
  return JSON.parse(command('npm', [
    'view', `${packageName}@${version}`, 'version', 'gitHead', 'dist',
    '--registry=https://registry.npmjs.org', '--json',
  ]));
}

function tagCommit(repository, tag, github) {
  let { object } = github(`repos/${repository}/git/ref/tags/${tag}`);
  while (object?.type === 'tag') {
    ({ object } = github(`repos/${repository}/git/tags/${object.sha}`));
  }
  assert.equal(object?.type, 'commit', '标签必须指向提交');
  assert.match(object.sha, commitSha, '标签必须提供完整提交标识');
  return object.sha;
}

export function verifyRelease(context, { github = githubJson, registry = npmJson } = {}) {
  const { ref, sha, head, repository, pkg, manifest, lock } = context;
  assert.ok(ref?.startsWith('refs/tags/'), '必须从版本标签触发发布');
  const tag = ref.slice('refs/tags/'.length);
  assert.match(tag, stableVersion, '插件标签必须为 x.y.z 格式的正式版本');
  assert.match(sha ?? '', commitSha, '发布必须提供完整提交标识');
  assert.equal(head, sha, '实际构建提交与触发发布的提交不一致');
  assert.equal(pkg.version, tag, 'package.json 版本与发布标签不一致');
  assert.equal(manifest.version, tag, 'manifest.json 版本与发布标签不一致');

  const locked = lock.packages?.[`node_modules/${packageName}`];
  const version = locked?.version;
  assert.match(version ?? '', stableVersion, '锁文件必须固定上游正式版本');
  assert.equal(pkg.devDependencies?.[packageName], version, '上游依赖声明必须与锁文件的精确版本一致');
  assert.ok(locked.resolved && locked.integrity, '锁文件必须记录上游发布包地址和完整性校验值');
  assert.equal(tagCommit(repository, tag, github), head, '远端发布标签与实际构建提交不一致');

  const upstreamTag = `v${version}`;
  const release = github(`repos/${upstreamRepository}/releases/tags/${upstreamTag}`);
  assert.equal(release.tag_name, upstreamTag, '上游发布标签与锁定版本不一致');
  assert.equal(release.draft, false, '上游发布不能是草稿');
  assert.equal(release.prerelease, false, '上游发布不能是预发布');
  assert.ok(release.published_at, '上游版本尚未正式发布');

  const metadata = registry(version);
  const upstreamSha = tagCommit(upstreamRepository, upstreamTag, github);
  assert.equal(metadata.version, version, '上游发布包版本与锁文件不一致');
  assert.equal(metadata.gitHead, upstreamSha, '上游发布包源码提交与正式标签不一致');
  assert.equal(metadata.dist?.tarball, locked.resolved, '上游发布包地址与锁文件不一致');
  assert.equal(metadata.dist?.integrity, locked.integrity, '上游发布包完整性校验值与锁文件不一致');

  return { tag, sha, repository, upstreamTag, upstreamSha, version, resolved: locked.resolved, integrity: locked.integrity };
}

export function releaseNotes(source) {
  return [
    '## 发布来源',
    '',
    `> 插件 ${source.tag} 使用经过核验的上游正式发布版本。`,
    '',
    `- 本仓库提交：[${source.sha}](https://github.com/${source.repository}/commit/${source.sha})`,
    `- 上游版本：[${packageName}@${source.version}](https://github.com/${upstreamRepository}/releases/tag/${source.upstreamTag})`,
    `- 上游提交：[${source.upstreamSha}](https://github.com/${upstreamRepository}/commit/${source.upstreamSha})`,
    `- 上游发布包：[下载](${source.resolved})`,
    `- 发布包完整性校验值：\`${source.integrity}\``,
    '',
    '---',
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const source = verifyRelease({
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      head: command('git', ['rev-parse', 'HEAD']),
      repository: process.env.GITHUB_REPOSITORY,
      pkg: json('package.json'),
      manifest: json('manifest.json'),
      lock: json('package-lock.json'),
    });
    process.stdout.write(releaseNotes(source));
  } catch (error) {
    console.error(`发布来源核验失败：${error.message}`);
    process.exitCode = 1;
  }
}
