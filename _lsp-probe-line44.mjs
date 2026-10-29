// node 侧 LSP 探针：直连部署在 e2e 库插件目录的 basedpyright(langserver)，
// 以库根为 workspace root didOpen 06-图的流式输出.py，请求 semanticTokens/full，
// 解码 5 元组，打印 43-47 行(1-based)每个 token 的 legend 类型与文本切片。
// 目的：拿到 emission 真相 —— pyright 到底给不给 builder.add_node 发 method token。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LS = 'E:/HOME/Local/logseq-e2e-vault/.obsidian/plugins/obsidian-my-obsidian/basedpyright/dist/pyright-langserver.js';
const FILE = 'E:/HOME/Local/logseq-e2e-vault/06-图的流式输出.py';
const uri = pathToFileURL(FILE).href;
const rootUri = pathToFileURL('E:/HOME/Local/logseq-e2e-vault').href;

// 对照开关：--noenv = 不加 anaconda PATH（模拟插件页内 pyright 探测不到 python 的情况）
const useEnv = !process.argv.includes('--noenv');
const envDir = 'D:\\programs\\anaconda3\\envs\\ai';
const env = useEnv
  ? { ...process.env, PATH: `${envDir};${envDir}\\Scripts;${envDir}\\Library\\bin;${process.env.PATH ?? ''}` }
  : { ...process.env };

const child = spawn(process.execPath, [LS, '--stdio'], { env });
child.on('error', (e) => { console.log('SPAWN FAILED:', String(e)); process.exit(1); });

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
const notifications = [];

function send(method, params) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.get(id).reject(new Error('timeout ' + method)); pending.delete(id); } }, 60000);
  });
}
function notify(method, params) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const header = buf.slice(0, idx).toString();
    const m = header.match(/Content-Length: (\d+)/i);
    if (!m) { buf = buf.slice(idx + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < idx + 4 + len) return;
    const body = buf.slice(idx + 4, idx + 4 + len);
    buf = buf.slice(idx + 4 + len);
    let msg; try { msg = JSON.parse(body.toString()); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg.method);
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const log = (...a) => { out.push(a.join(' ')); };

try {
  const init = await send('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'e2e-vault' }],
    capabilities: { textDocument: { semanticTokens: {} } },
  });
  const legend = init?.capabilities?.semanticTokensProvider?.legend;
  log('legend tokenTypes:', JSON.stringify(legend?.tokenTypes ?? null));
  log('legend tokenModifiers:', JSON.stringify(legend?.tokenModifiers ?? null));
  notify('initialized', {});
  const text = readFileSync(FILE, 'utf8');
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text } });

  // 等首轮分析；连续请求两次（10s / 再 10s），看 emission 是否随分析深入变化
  for (const wait of [10000, 10000]) {
    await sleep(wait);
    const res = await send('textDocument/semanticTokens/full', { textDocument: { uri } });
    const data = res?.data ?? [];
    const count = data.length / 5;
    log(`--- semanticTokens/full after +${wait}ms: ${count} tokens (bytes=${data.length})`);
    const lines = text.split(/\r?\n/);
    let line = 0, ch = 0;
    for (let i = 0; i < count; i++) {
      const dl = data[5 * i], dc = data[5 * i + 1], len = data[5 * i + 2], ti = data[5 * i + 3], mods = data[5 * i + 4];
      line += dl;
      ch = dl === 0 ? ch + dc : dc;
      // 1-based 43..47 => 0-based 42..46
      if (line >= 42 && line <= 46) {
        const type = legend?.tokenTypes?.[ti] ?? `#${ti}`;
        const modNames = [];
        let ms = mods;
        for (let b = 0; ms > 0 && b < (legend?.tokenModifiers?.length ?? 0); b++) { if (ms & 1) modNames.push(legend.tokenModifiers[b]); ms >>= 1; }
        log(`  L${line + 1} [${ch},${ch + len}) ${type}${modNames.length ? ' (' + modNames.join(' ') + ')' : ''}  "${lines[line]?.slice(ch, ch + len)}"`);
      }
    }
  }
} catch (e) {
  log('PROBE FAILED:', String(e && e.stack || e).slice(0, 800));
}
try { child.kill(); } catch { /* gone */ }
console.log(out.join('\n'));
