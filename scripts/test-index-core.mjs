// index-core 测试入口：需要带 FTS5 的 node（≥24 官方构建；22.x 官方构建的 SQLite 没有 FTS5）。
// 本机默认可能是 22.x——这里自动探测：当前 node 没有 FTS5 就从 vfox cache 挑最新的带 FTS5 的，
// PATH 前置后照常跑 `yarn vitest run --root modules/index-core`。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function nodeHasFts5(nodeExe) {
  const r = spawnSync(
    nodeExe,
    [
      "-e",
      "try{const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');" +
        "d.exec('CREATE VIRTUAL TABLE _t USING fts5(x)');console.log('FTS5-yes')}" +
        "catch(e){console.log('FTS5-no')}",
    ],
    { encoding: "utf8" },
  );
  return r.stdout?.includes("FTS5-yes") ?? false;
}

function candidateNodes() {
  const list = [process.execPath];
  const vfoxCache = path.join(process.env.USERPROFILE ?? "", ".vfox", "cache", "nodejs");
  if (existsSync(vfoxCache)) {
    const verNum = (v) => v.slice(2).split(".").map(Number);
    const vers = readdirSync(vfoxCache)
      .filter((d) => /^v-\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => {
        const A = verNum(a);
        const B = verNum(b);
        return B[0] - A[0] || B[1] - A[1] || B[2] - A[2];
      });
    for (const v of vers) {
      const exe = path.join(vfoxCache, v, `nodejs-${v.slice(2)}`, "node.exe");
      if (existsSync(exe)) list.push(exe);
    }
  }
  return list;
}

let chosen = null;
for (const exe of candidateNodes()) {
  if (nodeHasFts5(exe)) {
    chosen = exe;
    break;
  }
}
if (!chosen) {
  console.error(
    "index-core 测试需要带 FTS5 的 node（≥24 官方构建），本机未找到。" +
      "可 `vfox install nodejs@26` 后重试。",
  );
  process.exit(1);
}

if (chosen !== process.execPath) {
  console.log(`[test-index-core] node ${path.basename(path.dirname(path.dirname(chosen)))} (FTS5)`);
}

// yarn shim 泥潭（npm-global 是 yarn1、项目是 corepack yarn4、两者都钉死自己的 node）——
// 全部绕开：借项目的 yarn4 解析一次 vitest 入口路径，然后用选定 node + PnP loader 直跑 vitest.mjs。
function resolveVitestEntry() {
  const r = spawnSync("cmd", ["/c", "yarn", "node", "-e", "console.log(require.resolve('vitest/package.json'))"], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  const pkg = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  if (r.status !== 0 || !pkg.endsWith("package.json")) return null;
  return path.join(path.dirname(pkg), "vitest.mjs");
}

const vitestEntry = resolveVitestEntry();
if (!vitestEntry) {
  console.error("无法通过项目 yarn 解析 vitest 入口。");
  process.exit(1);
}

const pnp = path.join(repoRoot, ".pnp.cjs");
const loader = path.join(repoRoot, ".pnp.loader.mjs");
const env = { ...process.env };
if (existsSync(pnp)) {
  env.NODE_OPTIONS = existsSync(loader)
    ? `--require ${pnp} --experimental-loader file:///${loader.replace(/\\/g, "/")}`
    : `--require ${pnp}`;
}
const r = spawnSync(
  chosen,
  [vitestEntry, "run", "--root", "modules/index-core", ...process.argv.slice(2)],
  { env, stdio: "inherit", cwd: repoRoot },
);
process.exit(r.status ?? 1);
