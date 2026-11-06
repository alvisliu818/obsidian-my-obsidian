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
import { join } from 'path';
import { Notice } from 'obsidian';

export interface PtySessionEvents {
  onData: (data: string) => void; // UTF-8 文本（已解码）
  onExit: (code: number | undefined) => void;
  onError?: (msg: string) => void;
}

export interface PtySession {
  id: string;
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
const NODE_PATH_CACHE_KEY = 'my-obsidian.nodePathCache';

/**
 * findNodeExe 的持久缓存包装（启动提速,2026-11-06）：GUI 启动的 Obsidian
 * PATH 无 node,全量探测（spawn where + 候选 existsSync）每次 ~0.3-1s——
 * 上次解析结果存 localStorage,命中且文件仍在直接返回;失效才走全量探测并回写。
 */
export async function findNodeExe(): Promise<string | null> {
  try {
    const cached = localStorage.getItem(NODE_PATH_CACHE_KEY);
    if (cached) {
      if (existsSync(cached)) return cached;
      localStorage.removeItem(NODE_PATH_CACHE_KEY);
    }
  } catch {
    /* localStorage 不可用则每次全量探测 */
  }
  const found = await probeNodeExe();
  if (found) {
    try {
      localStorage.setItem(NODE_PATH_CACHE_KEY, found);
    } catch {
      /* 写不了就下次再探 */
    }
  }
  return found;
}

async function probeNodeExe(): Promise<string | null> {
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

/** 可选 shell 的统一形态(探测与用户选择共用) */
export interface ShellInfo {
  file: string;
  name: string;
}

/** Windows shell 探测：pwsh7 → powershell → cmd（返回可执行绝对路径与展示名） */
export async function detectShell(): Promise<ShellInfo> {
  const stat = fsPromises.stat;
  const candidates: ShellInfo[] = [
    { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh' },
    { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'PowerShell' },
    { file: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd' },
  ];
  for (const c of candidates) {
    try {
      await stat(c.file);
      return c;
    } catch {
      // 继续下一个候选
    }
  }
  return { file: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd' };
}

/** `where <name>` 的行列表;where 不存在/失败返回空(PATH 精简的 GUI 进程常见) */
function whereExe(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const p = spawn('where', [name], { windowsHide: true });
      let buf = '';
      p.stdout.on('data', (d) => (buf += String(d)));
      p.on('error', () => resolve([]));
      p.on('exit', (code) =>
        resolve(code === 0 ? buf.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []),
      );
    } catch {
      resolve([]);
    }
  });
}

async function statOk(file: string): Promise<boolean> {
  try {
    await fsPromises.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * pwsh 7 探测:标准路径 + `where pwsh`(本机实测装在 D:\programs\PowerShell\7
 * 之类的非标准目录,GUI 进程的 PATH 里 where 才是可靠来源)。
 */
async function detectPwsh(): Promise<ShellInfo | null> {
  const std = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  if (await statOk(std)) return { file: std, name: 'pwsh' };
  for (const p of await whereExe('pwsh')) {
    try {
      if (await statOk(p)) return { file: p, name: 'pwsh' };
    } catch {
      // 下一行
    }
  }
  return null;
}

/**
 * Git Bash 探测:四级依次尝试(与 siyuan-virtual-tree 的 builtin-terminal
 * findGitBash 同规则,两仓改动需同步)。找 bash.exe 而非 git-bash.exe——
 * 后者是拉起 mintty 窗口的启动器,不能当 PTY shell。
 *   1) 注册表 GitForWindows\InstallPath(官方安装器写入,覆盖自定义目录)
 *   2) 标准安装位置(ProgramFiles 64/32 位、用户级 LocalAppData)
 *   3) `where git` 推导(每行试 ..\bin\bash.exe 与 ..\usr\bin\bash.exe)
 *   4) `where bash` 扫描(排除 System32/WindowsApps——那两处是 WSL 存根)
 */
const GIT_BASH_CANDIDATES = (): string[] => {
  const env = process.env;
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pfw = env.ProgramW6432 || pf;
  const pf86 = env['ProgramFiles(x86)'] || pf;
  const lad = env.LocalAppData || '';
  return [
    `${pf}\\Git\\bin\\bash.exe`,
    `${pfw}\\Git\\bin\\bash.exe`,
    `${pf86}\\Git\\bin\\bash.exe`,
    lad ? `${lad}\\Programs\\Git\\bin\\bash.exe` : '',
  ].filter(Boolean);
};

async function detectGitBash(): Promise<ShellInfo | null> {
  // 1) 注册表(官方安装器即使装到自定义目录也写 GitForWindows\InstallPath)
  try {
    const { execSync } = await import('child_process');
    for (const k of [
      'HKLM\\SOFTWARE\\GitForWindows',
      'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
      'HKCU\\SOFTWARE\\GitForWindows',
    ]) {
      try {
        const out = execSync(`reg query "${k}" /v InstallPath`, {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
          windowsHide: true,
        }).toString();
        const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/i);
        const install = m?.[1]?.trim();
        if (install && (await statOk(`${install}\\bin\\bash.exe`))) {
          return { file: `${install}\\bin\\bash.exe`, name: 'Git Bash' };
        }
      } catch {
        // 键不存在,试下一个
      }
    }
  } catch {
    // child_process 动态导入失败(不会发生,渲染进程有 node)
  }
  // 2) 标准安装位置
  for (const file of GIT_BASH_CANDIDATES()) {
    if (await statOk(file)) return { file, name: 'Git Bash' };
  }
  // 3) where git 推导(每行试 ..\bin\bash.exe 与 ..\usr\bin\bash.exe)
  for (const gitExe of await whereExe('git')) {
    if (/system32/i.test(gitExe)) continue; // System32\git.exe 是 WSL 桩
    for (const bash of [join(gitExe, '..', 'bin', 'bash.exe'), join(gitExe, '..', 'usr', 'bin', 'bash.exe')]) {
      if (await statOk(bash)) return { file: bash, name: 'Git Bash' };
    }
  }
  // 4) where bash 扫描(排除 WSL 存根)
  for (const bash of await whereExe('bash')) {
    if (/system32|windowsapps/i.test(bash)) continue;
    if (await statOk(bash)) return { file: bash, name: 'Git Bash' };
  }
  return null;
}

/**
 * 本机全部可选 shell(打开终端的选择菜单数据源):按 pwsh → PowerShell →
 * Git Bash → cmd 排序,只含真实存在的项,同 file 去重。
 */
export async function listShells(): Promise<ShellInfo[]> {
  const found: ShellInfo[] = [];
  const seen = new Set<string>();
  const push = (s: ShellInfo | null) => {
    if (!s) return;
    const key = s.file.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(s);
  };
  push(await detectPwsh());
  const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  if (await statOk(ps5)) push({ file: ps5, name: 'PowerShell' });
  push(await detectGitBash());
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  if (await statOk(comspec)) push({ file: comspec, name: 'cmd' });
  return found;
}

/** 按壳分派启动参数(cmd 无参数;bash 走登录+交互;PowerShell 免 Logo)。 */
function shellArgs(name: string): string[] {
  if (name === 'cmd') return [];
  if (name === 'Git Bash') return ['--login', '-i'];
  return ['-NoLogo'];
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
  opts: { cwd?: string; cols?: number; rows?: number; shell?: ShellInfo },
  ev: PtySessionEvents,
): Promise<PtySession> {
  const nodeExe = await findNodeExe();
  if (!nodeExe) throw new Error('未找到系统 node.exe（运行终端需要 Node.js）');
  await ensureHelper(manifestDir, nodeExe);

  const id = `s${++seq}-${Date.now().toString(36)}`;
  sessions.set(id, ev);
  // shell 可由调用方指定(打开终端时的选择菜单/布局恢复),缺省走探测
  const shell = opts.shell ?? (await detectShell());
  // 终端用纯净 shell 环境：注入 Python 环境 PATH 会与 conda init 的 PowerShell
  // 启动钩子冲突（hook 用环境里的 python 跑 base 的 conda 脚本 → ModuleNotFound）。
  // 终端里用户自行 conda activate；代码块/文件运行与 LSP 才跟随选定环境。
  const env = { ...process.env } as Record<string, string>;
  const cwd = opts.cwd || (env.USERPROFILE ? String(env.USERPROFILE) : 'C:\\');

  const pid = await new Promise<number>((resolve, reject) => {
    pendingSpawns.set(id, { resolve, reject });
    send({
      t: 'spawn',
      id,
      file: shell.file,
      args: shellArgs(shell.name),
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

  return {
    id,
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
