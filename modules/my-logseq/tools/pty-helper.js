// PTY helper —— 由系统 node.exe 运行的独立进程（ELECTRON_RUN_AS_NODE 对
// Obsidian.exe 无效，helper 必须是真 node；node-pty 1.1.0 自带 prebuilds 免编译）。
//
// 协议：stdin/stdout 每行一个 JSON（UTF-8）。
//   父进程 → helper：
//     {t:'spawn', id, file, args?, cwd?, env?, cols?, rows?}
//     {t:'input', id, b64}          —— base64(UTF-8) 键入数据
//     {t:'resize', id, cols, rows}
//     {t:'kill', id}
//     {t:'shutdown'}                —— 退出 helper
//   helper → 父进程：
//     {t:'ready'}                   —— 启动完成（node-pty 可用）
//     {t:'spawned', id, pid}
//     {t:'data', id, b64}           —— PTY 输出（base64）
//     {t:'exit', id, exitCode, signal}
//     {t:'error', id?, msg}
//
// node-pty 从 helper.js 同目录的 ./node-pty 解析（部署时一并复制，见部署脚本）。

'use strict';

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    // 管道断开时静默（父进程已退出）
  }
}

let pty;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pty = require('./node-pty');
} catch (e) {
  send({ t: 'error', msg: 'node-pty 加载失败: ' + String((e && e.message) || e) });
  process.exit(1);
}

const terms = new Map(); // id -> IPty

function bufToB64(buf) {
  return Buffer.from(buf).toString('base64');
}

process.stdin.setEncoding('utf8');
let lineBuf = '';
process.stdin.on('data', (chunk) => {
  lineBuf += chunk;
  let idx;
  while ((idx = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, idx);
    lineBuf = lineBuf.slice(idx + 1);
    if (line.trim()) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    switch (msg.t) {
      case 'spawn': {
        const ptyProcess = pty.spawn(msg.file, msg.args || [], {
          name: 'xterm-256color',
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          cwd: msg.cwd || process.cwd(),
          env: msg.env || process.env,
        });
        terms.set(msg.id, ptyProcess);
        ptyProcess.onData((data) => send({ t: 'data', id: msg.id, b64: bufToB64(Buffer.from(data, 'utf8')) }));
        ptyProcess.onExit(({ exitCode, signal }) => {
          terms.delete(msg.id);
          send({ t: 'exit', id: msg.id, exitCode, signal });
        });
        send({ t: 'spawned', id: msg.id, pid: ptyProcess.pid });
        break;
      }
      case 'input': {
        const p = terms.get(msg.id);
        if (p) p.write(Buffer.from(msg.b64, 'base64').toString('utf8'));
        break;
      }
      case 'resize': {
        const p = terms.get(msg.id);
        if (p && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          try { p.resize(msg.cols, msg.rows); } catch { /* 越界时 conpty 可能抛错，忽略 */ }
        }
        break;
      }
      case 'kill': {
        const p = terms.get(msg.id);
        if (p) {
          try { p.kill(); } catch { /* 忽略 */ }
          terms.delete(msg.id);
        }
        break;
      }
      case 'shutdown': {
        for (const p of terms.values()) {
          try { p.kill(); } catch { /* 忽略 */ }
        }
        process.exit(0);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    send({ t: 'error', id: msg && msg.id, msg: String((e && e.message) || e) });
  }
}

send({ t: 'ready' });
