// 协议级测试：node 直连 pyright-langserver，验证 initialize→didOpen→publishDiagnostics
// （剥离 Obsidian 集成层；ai 环境前置 PATH）
const { spawn } = require('child_process');
const path = require('path');

const NODE = 'C:\\Users\\alvisliu\\.vfox\\sdks\\nodejs\\node.exe';
const LS = path.resolve('dist/pyright/dist/pyright-langserver.js');
const PY_FILE = 'E:\\HOME\\Local\\lsp-e2e-test.py';
const AI_PY = 'D:\\programs\\anaconda3\\envs\\ai\\python.exe';

const env = { ...process.env };
env.PATH = 'D:\\programs\\anaconda3\\envs\\ai;D:\\programs\\anaconda3\\envs\\ai\\Library\\bin;D:\\programs\\anaconda3\\envs\\ai\\Scripts;' + env.PATH;

const proc = spawn(NODE, [LS, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
let buf = '';
proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', (d) => console.error('[stderr]', d.slice(0, 200)));

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

let diagCount = 0;
buf = '';
proc.stdout.on('data', (d) => {
  buf += d;
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) return;
    const header = buf.slice(0, h);
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.slice(h + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buf.length < h + 4 + len) return;
    const body = buf.slice(h + 4, h + 4 + len);
    buf = buf.slice(h + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id === 1) {
      // initialize 响应 → initialized + didOpen
      frame({ jsonrpc: '2.0', method: 'initialized', params: {} });
      frame({
        jsonrpc: '2.0', method: 'textDocument/didOpen',
        params: { textDocument: { uri: 'file:///E:/HOME/Local/lsp-e2e-test.py', languageId: 'python', version: 1, text: 'import os\nimport numpy as np\n\nundefined_var_xyz = undefined_fn_xyz()\n' } },
      });
      console.log('[flow] didOpen sent');
    } else if (msg.method === 'workspace/configuration' && msg.id != null) {
      const items = (msg.params && msg.params.items) || [];
      frame({
        jsonrpc: '2.0', id: msg.id,
        result: items.map((it) => (it.section === 'python' ? { pythonPath: AI_PY } : it.section === 'pyright' ? { pythonPath: AI_PY, openFilesOnly: false, useLibraryCodeForTypes: true } : {})),
      });
      console.log('[flow] configuration replied');
    } else if (msg.method === 'client/registerCapability' || msg.method === 'window/workDoneProgress/create') {
      if (msg.id != null) frame({ jsonrpc: '2.0', id: msg.id, result: null });
      console.log('[flow] replied', msg.method);
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      const diags = (msg.params && msg.params.diagnostics) || [];
      diagCount++;
      console.log(`[flow] publishDiagnostics #${diagCount}: ${diags.length} items`);
      for (const d of diags.slice(0, 5)) console.log('  -', d.severity, JSON.stringify(d.message.slice(0, 80)), (d.range.start.line + 1) + ':' + d.range.start.character);
      if (diagCount >= 2) { console.log('[flow] got diagnostics, exiting OK'); proc.kill(); process.exit(0); }
    }
  }
});

// initialize
frame({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    processId: null,
    rootUri: 'file:///E:/HOME/Local',
    capabilities: {
      textDocument: {
        completion: { completionItem: { documentationFormat: ['markdown'] } },
        hover: { contentFormat: ['markdown'] },
        signatureHelp: { signatureInformation: { documentationFormat: ['markdown'] } },
      },
    },
    initializationOptions: { pythonPath: AI_PY },
  },
});

setTimeout(() => { console.log('[flow] TIMEOUT, diagCount=' + diagCount); proc.kill(); process.exit(1); }, 60000);
