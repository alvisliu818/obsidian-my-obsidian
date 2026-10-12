// PTY 客户端（渲染进程侧）
//
// helper 进程：系统 node.exe 跑 pty-helper.js（ELECTRON_RUN_AS_NODE 对
// Obsidian.exe 无效；helper 与 node-pty 预编译二进制部署在插件目录
// pty-helper/ 下，见部署脚本）。stdio 每行一个 JSON，协议见 pty-helper.js。
//
// 一个 helper 实例服务多个终端会话（多 Tab 共享进程，会话以 id 区分）；
// helper 崩溃/退出后下次 createSession 自动重启。

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, promises as fsPromises } from 'fs';
import { Notice } from 'obsidian';

export interface PtySessionEvents {
  onData: (data: string) => void; // UTF-8 文本（已解码）
  onExit: (code: number | undefined) => void;
  onError?: (msg: string) => void;
}

export interface PtySession {
  id: string;
  /** Which shell actually came up (may be the fallback when the pick is absent). */
  shellName: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void; // 结束会话（shell 被杀，onExit 会触发）
}

interface PendingSpawn {
  resolve: (pid: number) => void;
  reject: (e: Error) => void;
}

let helperProc: ChildProcess | null = null;
let helperReady = false;
let seq = 0;
const sessions = new Map<string, PtySessionEvents>();
const pendingSpawns = new Map<string, PendingSpawn>();
let launchPromise: Promise<void> | null = null;

function helperDir(): string {
  // 部署形态：插件目录/pty-helper/{pty-helper.js, package.json, node-pty/}
  return 'pty-helper';
}

function helperScript(): string {
  // adapter 不可用于子进程 spawn（需要 OS 路径）；插件目录即 manifest.dir。
  // 此函数在调用方（TerminalView/main）处用 manifest.dir 拼接，见 openHelper。
  return '';
}
void helperDir;
void helperScript;

/** 行 JSON 分帧（helper 的 stdout/stderr） */
function wireHelper(proc: ChildProcess, scriptPath: string): void {
  helperReady = false;
  let buf = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      handleHelperMessage(m as { t: string; [k: string]: unknown });
    }
  });
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (d: string) => {
    // helper 的 node-pty 加载失败等信息走 stderr（加载失败已在 stdout error 帧里），静默记录
    console.debug('[lgp-pty-helper]', d.trim().slice(0, 200));
  });
  proc.on('exit', () => {
    helperProc = null;
    helperReady = false;
    // 所有活会话通知退出
    for (const [id, s] of sessions) {
      s.onExit?.(undefined);
      sessions.delete(id);
    }
    for (const [, p] of pendingSpawns) p.reject(new Error('PTY helper 已退出'));
    pendingSpawns.clear();
    void scriptPath;
  });
}

function handleHelperMessage(m: { t: string; id?: string; b64?: string; exitCode?: number; msg?: string; pid?: number }): void {
  switch (m.t) {
    case 'ready':
      helperReady = true;
      break;
    case 'spawned': {
      const p = pendingSpawns.get(m.id!);
      if (p) {
        pendingSpawns.delete(m.id!);
        p.resolve(m.pid ?? 0);
      }
      break;
    }
    case 'data': {
      const s = sessions.get(m.id!);
      if (s && typeof m.b64 === 'string') s.onData(Buffer.from(m.b64, 'base64').toString('utf8'));
      break;
    }
    case 'exit': {
      const s = sessions.get(m.id!);
      if (s) {
        s.onExit(m.exitCode);
        sessions.delete(m.id!);
      }
      break;
    }
    case 'error': {
      const s = m.id ? sessions.get(m.id) : undefined;
      if (s?.onError) s.onError(m.msg ?? 'unknown error');
      else new Notice(`终端错误: ${m.msg ?? ''}`);
      const p = m.id ? pendingSpawns.get(m.id) : undefined;
      if (p) {
        pendingSpawns.delete(m.id!);
        p.reject(new Error(m.msg ?? 'spawn failed'));
      }
      break;
    }
    default:
      break;
  }
}

function send(msg: Record<string, unknown>): void {
  helperProc?.stdin?.write(JSON.stringify(msg) + '\n');
}

/**
 * 插件目录绝对路径：manifest.dir 在部分环境是相对 vault 的路径（如
 * .obsidian/plugins/xxx），PTY helper 的 spawn 需要绝对 OS 路径。
 */
export function absolutePluginDir(manifestDir: string, vaultAdapter: unknown): string {
  if (/^[a-zA-Z]:[\\/]/.test(manifestDir) || manifestDir.startsWith('\\\\')) return manifestDir;
  try {
    const getBasePath = (vaultAdapter as { getBasePath?: () => string } | null)?.getBasePath;
    if (typeof getBasePath === 'function') {
      const base = getBasePath.call(vaultAdapter);
      if (base) return `${base}\\${manifestDir.replace(/\//g, '\\')}`;
    }
  } catch {
    // adapter 不支持时原样返回
  }
  return manifestDir;
}

/** POSIX 风格 PATH 条目（/c/foo）转 Windows 路径（C:\\foo）；非 POSIX 返回 null */
function posixPathToWin(p: string): string | null {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (!m) return null;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

/** 从 PATH 环境变量中找 node.exe（兼容 Windows 分号与 Git Bash 冒号两种格式） */
function findNodeInPathEnv(): string | null {
  const raw = process.env.PATH || '';
  const dirs: string[] = [];
  for (const seg of raw.split(';')) {
    if (seg.includes(':') && seg.split(':').length > 2) {
      // POSIX 冒号列表（Git Bash 启动的进程）
      for (const entry of seg.split(':')) {
        if (!entry) continue;
        const win = posixPathToWin(entry) ?? entry;
        dirs.push(win);
      }
    } else if (seg.trim()) {
      dirs.push(seg.trim());
    }
  }
  for (const d of dirs) {
    try {
      const p = `${d}\\node.exe`;
      if (existsSync(p)) return p;
    } catch {
      // 无效路径字符等
    }
  }
  return null;
}

/** 找系统 node.exe：where → PATH 双格式扫描 → 常见安装位置（含灵犀便携 node） */
export async function findNodeExe(): Promise<string | null> {
  const where = await new Promise<string>((resolve) => {
    try {
      const p = spawn('where', ['node'], { windowsHide: true });
      let out = '';
      p.stdout!.on('data', (d) => (out += String(d)));
      p.on('exit', (code) => resolve(code === 0 ? out : ''));
      p.on('error', () => resolve(''));
    } catch {
      resolve('');
    }
  });
  for (const line of where.split(/\r?\n/)) {
    const t = line.trim();
    if (t && t.toLowerCase().endsWith('node.exe') && existsSync(t)) return t;
  }
  const inPath = findNodeInPathEnv();
  if (inPath) return inPath;
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    appData ? `${appData}\\nvm\\node.exe` : '',
    localAppData ? `${localAppData}\\Volta\\bin\\node.exe` : '',
    userProfile ? `${userProfile}\\scoop\\shims\\node.exe` : '',
    userProfile ? `${userProfile}\\.vfox\\sdks\\nodejs\\node.exe` : '',
    localAppData ? `${localAppData}\\Programs\\nodejs\\node.exe` : '',
  ];
  // 灵犀自带的便携 node（WPS 灵犀环境下的稳定兜底）
  try {
    const portableRoot = appData ? `${appData}\\WPS 灵犀\\portable-node` : '';
    if (portableRoot) {
      for (const d of require('fs').readdirSync(portableRoot)) {
        candidates.push(`${portableRoot}\\${d}\\node.exe`);
      }
    }
  } catch {
    // 目录不存在
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** Windows shell 探测：pwsh7 → powershell → cmd（返回可执行绝对路径与展示名） */
export async function detectShell(): Promise<{ file: string; name: string; args: string[] }> {
  const stat = fsPromises.stat;
  const candidates: { file: string; name: string; args: string[] }[] = [
    { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh', args: ['-NoLogo'] },
    { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'PowerShell', args: ['-NoLogo'] },
    { file: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd', args: [] },
  ];
  for (const c of candidates) {
    try {
      await stat(c.file);
      return c;
    } catch {
      // 继续下一个候选
    }
  }
  return { file: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd', args: [] };
}

/**
 * The shells the terminal can run, by id.
 *
 * 'auto' is what detectShell() used to be the only option: pick whatever is
 * installed. The rest let the user choose — the reason this exists is that
 * detect() stops at PowerShell and never reaches Git Bash or WSL, which is
 * where a lot of shell scripts actually run.
 */
export interface ShellChoice {
  id: string;
  name: string;
  /** How to find the executable: an absolute path, or a bare name on PATH. */
  file: string;
  /** Extra argv for the shell itself (before any script). */
  args?: string[];
  /** Windows only (WSL runs a Linux distro). */
  win?: boolean;
}

export const SHELL_CHOICES: ShellChoice[] = [
  { id: 'auto', name: '自动检测（pwsh7 → PowerShell → cmd）', file: '' },
  { id: 'pwsh', name: 'PowerShell 7 (pwsh)', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'], win: true },
  { id: 'powershell', name: 'Windows PowerShell 5.1', file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'], win: true },
  { id: 'cmd', name: '命令提示符 (cmd)', file: 'C:\\Windows\\System32\\cmd.exe', win: true },
  { id: 'gitbash', name: 'Git Bash', file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--norc', '-i'], win: true },
  { id: 'wsl', name: 'WSL', file: 'wsl.exe', win: true },
  { id: 'bash', name: 'bash', file: '/bin/bash', args: ['-i'] },
  { id: 'zsh', name: 'zsh', file: '/bin/zsh', args: ['-i'] },
];

/**
 * Resolve a shell id to something spawnable, or null when that shell is not
 * installed (caller then falls back to auto-detect and says so).
 */
export async function resolveShell(id: string): Promise<{ file: string; name: string; args: string[] } | null> {
  const choice = SHELL_CHOICES.find((c) => c.id === id);
  if (!choice || choice.id === 'auto' || !choice.file) return null;
  const exists = async (file: string): Promise<boolean> => {
    // An absolute path must exist on disk; a bare name is assumed to be on PATH
    // (wsl.exe lives there and has no fixed install dir).
    if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/')) {
      try {
        await fsPromises.stat(file);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  };
  if (!(await exists(choice.file))) return null;
  return { file: choice.file, name: choice.name, args: choice.args ?? [] };
}

/** 拉起（或复用）helper 进程；插件目录路径由调用方提供 */
async function ensureHelper(manifestDir: string, nodeExe: string): Promise<void> {
  if (helperProc && helperReady) return;
  if (launchPromise) return launchPromise;
  launchPromise = new Promise<void>((resolve, reject) => {
    if (!manifestDir) {
      reject(new Error('插件目录未知，无法启动终端'));
      return;
    }
    const scriptPath = `${manifestDir}\\pty-helper\\pty-helper.js`;
    try {
      helperProc = spawn(nodeExe, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      launchPromise = null;
      reject(e as Error);
      return;
    }
    wireHelper(helperProc, scriptPath);
    // 等 ready（最多 5s）
    const deadline = Date.now() + 5000;
    const waitReady = () => {
      if (helperReady) {
        launchPromise = null;
        resolve();
      } else if (!helperProc) {
        launchPromise = null;
        reject(new Error('PTY helper 启动失败（node.exe 缺失或 node-pty 不兼容）'));
      } else if (Date.now() > deadline) {
        launchPromise = null;
        helperProc?.kill();
        helperProc = null;
        reject(new Error('PTY helper 启动超时'));
      } else {
        setTimeout(waitReady, 100);
      }
    };
    waitReady();
  });
  return launchPromise;
}



/**
 * 创建终端会话。
 * @param manifestDir 插件目录（this.manifest.dir）
 * @param opts.cwd 启动目录；opts.cols/rows 初始尺寸
 */
export async function createPtySession(
  manifestDir: string,
  opts: { cwd?: string; cols?: number; rows?: number; shell?: string },
  ev: PtySessionEvents,
): Promise<PtySession> {
  const nodeExe = await findNodeExe();
  if (!nodeExe) throw new Error('未找到系统 node.exe（运行终端需要 Node.js）');
  await ensureHelper(manifestDir, nodeExe);

  const id = `s${++seq}-${Date.now().toString(36)}`;
  sessions.set(id, ev);
  // A shell the user picked that turns out not to be installed falls back to
  // auto-detect, and the view says so — better a working terminal than an
  // error the user has to decode.
  const picked = opts.shell && opts.shell !== 'auto' ? await resolveShell(opts.shell) : null;
  const shell = picked ?? (await detectShell());
  const fellBack = !!opts.shell && opts.shell !== 'auto' && !picked;
  // 终端用纯净 shell 环境：注入 Python 环境 PATH 会与 conda init 的 PowerShell
  // 启动钩子冲突（hook 用环境里的 python 跑 base 的 conda 脚本 → ModuleNotFound）。
  // 终端里用户自行 conda activate；代码块/文件运行与 LSP 才跟随选定环境。
  const env = { ...process.env } as Record<string, string>;
  const cwd = opts.cwd || (env.USERPROFILE ? String(env.USERPROFILE) : 'C:\\');

  const pid = await new Promise<number>((resolve, reject) => {
    pendingSpawns.set(id, { resolve, reject });
    // `shell.args` are the shell's OWN flags (-NoLogo for PowerShell, --norc -i
    // for bash); the old code hard-coded ['-NoLogo'] for everything, which
    // bash rejects.
    send({
      t: 'spawn',
      id,
      file: shell.file,
      args: shell.args ?? (shell.name === 'cmd' ? [] : ['-NoLogo']),
      cwd,
      env,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });
    setTimeout(() => {
      if (pendingSpawns.has(id)) {
        pendingSpawns.delete(id);
        reject(new Error('shell 启动超时'));
      }
    }, 10000);
  });
  void pid;

  if (fellBack) ev.onError?.(`未找到所选 shell，已改用自动检测（${shell.name}）`);
  return {
    id,
    /** Which shell actually came up — the view shows it in its bar. */
    shellName: picked?.name ?? shell.name,
    write: (data: string) => send({ t: 'input', id, b64: Buffer.from(data, 'utf8').toString('base64') }),
    resize: (cols: number, rows: number) => send({ t: 'resize', id, cols, rows }),
    dispose: () => send({ t: 'kill', id }),
  };
}

/** 插件卸载时调用：结束 helper 进程 */
export function shutdownPtyHelper(): void {
  if (helperProc) {
    try {
      send({ t: 'shutdown' });
    } catch {
      // 忽略
    }
    const proc = helperProc;
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // 忽略
      }
    }, 500);
    helperProc = null;
    helperReady = false;
    sessions.clear();
  }
}
