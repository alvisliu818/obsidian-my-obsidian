/**
 * Minimal raw-CDP driver for Obsidian — no external deps.
 *
 * Why hand-rolled: Playwright's connectOverCDP fails in this environment
 * (socket hang up, then 502s) and Node's BUILT-IN global WebSocket opens but
 * never delivers a single frame to this Electron build. So we do the RFC 6455
 * handshake over `http.request` and parse text frames ourselves. CDP traffic is
 * short JSON text frames, which is all we need.
 */
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { prepareTestProfile, killTestVaultObsidian, TEST_PROFILE, TEST_VAULT_URI } from './obsidian-process.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch JSON from the DevTools HTTP endpoint. */
function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
  });
}

export async function launchObsidian({ port = 9281, exe = 'D:/programs/Obsidian/Obsidian.exe' } = {}) {
  killTestVaultObsidian();
  await sleep(2000);
  prepareTestProfile();
  const proc = spawn(exe, [`--user-data-dir=${TEST_PROFILE}`, `--remote-debugging-port=${port}`, TEST_VAULT_URI], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();

  const deadline = Date.now() + 90000;
  let version = null;
  while (Date.now() < deadline) {
    try { version = await httpJson(port, '/json/version'); } catch { /* not up */ }
    if (version) break;
    await sleep(500);
  }
  if (!version) throw new Error('CDP endpoint never came up');
  return { port, version };
}

/** RFC 6455 client: handshake, then frame decode (text + continuation + ping). */
export class RawWs {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.onmessage = () => {};
    this.onclose = () => {};
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('close', () => this.onclose());
    socket.on('error', () => this.onclose());
  }

  static connect(wsUrl) {
    // Hand-rolled over net, NOT http.request: the sandbox's proxy env makes
    // Playwright's WS path unreliable, and Node's http client hides bytes that
    // arrive in the same TCP segment as the 101 (an upgrade-handler buffering
    // quirk) — a raw net socket sees every byte (verified by experiment).
    return new Promise((resolve, reject) => {
      const u = new URL(wsUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect({ host: u.hostname, port: Number(u.port) });
      let buf = Buffer.alloc(0);
      let stage = 'headers';
      let ws = null;
      const timer = setTimeout(() => fail(new Error('handshake timeout')), 10000);
      const fail = (e) => { clearTimeout(timer); try { sock.destroy(); } catch { /* gone */ } reject(e instanceof Error ? e : new Error(String(e))); };
      sock.on('error', fail);
      const onData = (chunk) => {
        if (stage === 'headers') {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = buf.slice(0, idx).toString('latin1');
          if (!/^HTTP\/1\.1 101 /.test(head)) { fail(new Error('handshake rejected: ' + head.split('\r\n')[0])); return; }
          stage = 'stream';
          const rest = buf.slice(idx + 4);
          clearTimeout(timer);
          sock.removeListener('data', onData);
          ws = new RawWs(sock);
          resolve(ws);
          // Removing our 'data' listener paused the stream (Node exits flowing
          // mode with no data listeners); resume it, then hand over any bytes
          // that arrived in the same segment as the 101.
          sock.resume();
          if (rest.length > 0) ws._feed(rest);
        }
      };
      sock.on('data', onData);
      sock.on('connect', () => {
        sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
    });
  }

  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) { this.socket.end(); return; }             // close
      if (opcode === 0x9) { this._send(payload, 0xa); continue; }    // ping -> pong
      if (opcode === 0xa) continue;                                  // pong
      if (opcode === 0x0 && this.fragments.length > 0) this.fragments.push(payload);
      else this.fragments = [payload];
      if (fin) {
        const text = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.onmessage(text);
      }
    }
  }

  _send(data, opcode = 0x1) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    // FRAGMENT everything above ~100 bytes. This environment silently drops
    // UNfragmented client->server frames whose payload exceeds the 126-byte
    // 7-bit header boundary (verified: identical short frame answered, long
    // frame ignored; Edge answers the same long frame fine). WebSocket
    // fragmentation is standard: first frame carries the opcode with FIN=0,
    // continuations carry opcode 0, the last one sets FIN=1 — the peer
    // reassembles before parsing, so every single frame stays small.
    const mask = crypto.randomBytes(4);
    const maskPayload = (p) => {
      const m = crypto.randomBytes(4);
      const out = Buffer.from(p);
      for (let i = 0; i < out.length; i++) out[i] ^= m[i % 4];
      return { m, out };
    };
    const CHUNK = 100;
    if (payload.length <= CHUNK) {
      const header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payload.length;
      const { m, out } = maskPayload(payload);
      m.copy(header, 2);
      this.socket.write(Buffer.concat([header, out]));
      return;
    }
    let off = 0;
    let first = true;
    while (off < payload.length) {
      const chunk = payload.subarray(off, Math.min(off + CHUNK, payload.length));
      const last = off + chunk.length >= payload.length;
      const op = first ? opcode : 0x0;
      const header = Buffer.alloc(6);
      header[0] = (last ? 0x80 : 0x00) | op;
      header[1] = 0x80 | chunk.length;
      const { m, out } = maskPayload(chunk);
      m.copy(header, 2);
      this.socket.write(Buffer.concat([header, out]));
      first = false;
      off += chunk.length;
    }
  }

  send(text) { this._send(text); }
  close() { try { this._send(Buffer.alloc(0), 0x8); this.socket.end(); } catch { /* gone */ } }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.log = [];
    ws.onmessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
  }

  static async attach(port) {
    // Attach to the BROWSER-level DevTools socket. Experiment-verified in this
    // environment: the page-level socket completes the 101 handshake and then
    // never answers a single frame, while the browser-level one answers
    // immediately (Edge control test proved our frames are correct).
    //
    // Session routing uses the LEGACY Target.sendMessageToTarget envelope:
    // flatten:true attaches fine but page commands sent with a sessionId are
    // then silently dropped (no response, no error), while the legacy
    // envelope round-trips.
    const version = await httpJson(port, '/json/version');
    const ws = await RawWs.connect(version.webSocketDebuggerUrl);
    const cdp = new Cdp(ws);
    const list = await httpJson(port, '/json/list');
    const page = list.find((t) => t.type === 'page' && t.url.startsWith('app://'))
      ?? list.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
    cdp.sessionId = sessionId;
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20000);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** Evaluate a function (called with JSON-serialized args) or an expression.
   * The sandbox link occasionally eats a frame even fragmented — retry once. */
  async eval(fnOrExpr, ...args) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this._evalOnce(fnOrExpr, args); }
      catch (e) {
        if (attempt === 1 || !/timed out/.test(String(e))) throw e;
      }
    }
  }

  async _evalOnce(fnOrExpr, args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
      : fnOrExpr;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error('page eval threw: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
    }
    return r.result?.value;
  }

  /**
   * Real key press through the input pipeline.
   *
   * A printable key needs THREE events, not two: `rawKeyDown` (no text) for
   * keymap handlers, then `char` to actually insert the character, then
   * `keyUp`. Sending only rawKeyDown+keyUp makes modifiers and shortcuts work
   * but silently drops printable text — which looks exactly like "the input
   * swallowed my typing" when you are really just missing the `char` event.
   */
  async key(key, { code, ctrl = false, shift = false, alt = false, meta = false } = {}) {
    const mods = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    const base = { modifiers: mods, key, code: code ?? key, windowsVirtualKeyCode: VK[key] ?? 0, nativeVirtualKeyCode: VK[key] ?? 0 };
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    // Printable single characters need the char event to produce text.
    if (key.length === 1 && !ctrl && !meta && !alt) {
      await this.send('Input.dispatchKeyEvent', { ...base, type: 'char', text: shift ? key.toUpperCase() : key });
    }
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  close() { this.ws.close(); }
}

const VK = {
  f: 70, F: 70, h: 72, H: 72, a: 65, A: 65, p: 80, P: 80, o: 79, O: 79,
  n: 78, N: 78, e: 69, E: 69, z: 90, Z: 90, y: 89, Y: 89, '\\': 220,
  Escape: 27, Enter: 13, Tab: 9, Backspace: 8, ' ': 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
};

export { sleep, killTestVaultObsidian, httpJson };
export function killAll() {
  try { execSync('taskkill /IM Obsidian.exe /F /T', { stdio: 'ignore' }); } catch { /* none */ }
}
