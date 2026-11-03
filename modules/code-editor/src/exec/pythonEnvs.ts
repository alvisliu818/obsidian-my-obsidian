/**
 * Python 环境(conda / venv / 系统)发现与切换 — 本轮「运行」与 jupyter 插件
 * 环境切换的共同地基。
 *
 * 设计取舍,三条实测结论:
 *
 * 1. **conda 环境清单优先读 `~/.conda/environments.txt`**。这是 conda 自己维护的
 *    注册表(创建/删除环境时同步),比扫磁盘可靠得多;跑 `conda env list` 要起
 *    进程且慢(实测 1–3 秒),放在设置面板展开时不可用。
 * 2. **不要 `conda activate`**。`spawn` 不是 shell,`activate.bat` / `&&` 都跑不了;
 *    绕 `cmd /c activate && python` 会污染 stdin/stdout 协议流。正确做法是
 *    **直接 spawn `<env>\python.exe` + 手动把环境的 bin 目录前置进 PATH**
 *    (见 `spawnEnvFor`),conda 激活脚本干的事本质上就是这个。
 * 3. **venv 只扫给定的根目录**(默认仓库根 + 常见 `.venv`),不做全盘扫描。
 *
 * 依赖(fs/path/os/child_process)全部走懒 require + 可注入的纯函数,便于单测
 * (同 pythonInterpreter.ts 的 `resolveFrom` 写法)。
 */

export type PyEnvKind = 'conda' | 'venv' | 'system';

export interface PythonEnv {
  /** 用可执行路径作 id:稳定、可直接回写设置 */
  id: string;
  /** 显示名,如 `ai (conda)` / `Python 3.12 (系统)` */
  name: string;
  cmd: string;
  args: string[];
  kind: PyEnvKind;
  /** 环境根目录(conda env / venv 目录);系统解释器为 undefined */
  rootDir?: string;
  /** 懒探测(`probeVersions`),不阻塞列表展示 */
  version?: string;
}

export interface DiscoverDeps {
  isWin: boolean;
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  readdirSync(p: string): string[];
  join(...parts: string[]): string;
  dirname(p: string): string;
  env: Record<string, string | undefined>;
  /** venv 额外扫描根(默认空) */
  extraRoots?: string[];
}

/** conda 会在用户目录写这个文件,每行一个环境目录。 */
function condaEnvironmentsFile(deps: DiscoverDeps): string[] {
  const home = deps.env.USERPROFILE || deps.env.HOME || '';
  if (!home) return [];
  const file = deps.isWin
    ? deps.join(home, '.conda', 'environments.txt')
    : deps.join(home, '.conda', 'environments.txt');
  try {
    if (!deps.existsSync(file)) return [];
    return deps
      .readFileSync(file)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** conda 安装根:CONDA_EXE(<root>\Scripts\conda.exe)上两级,再加常见位置。 */
function condaRoots(deps: DiscoverDeps): string[] {
  const roots: string[] = [];
  const exe = deps.env.CONDA_EXE;
  if (exe) {
    // <root>\Scripts\conda.exe / <root>\bin\conda → 上两级即 root
    roots.push(deps.dirname(deps.dirname(exe)));
  }
  const home = deps.env.USERPROFILE || deps.env.HOME || '';
  const pd = deps.env.ProgramData || '';
  for (const r of [
    deps.join(home, 'anaconda3'),
    deps.join(home, 'miniconda3'),
    deps.join(home, 'miniforge3'),
    pd ? deps.join(pd, 'anaconda3') : '',
    pd ? deps.join(pd, 'miniconda3') : '',
    'D:\\programs\\anaconda3',
    'C:\\ProgramData\\Anaconda3',
    '/opt/conda',
    '/usr/local/anaconda3',
  ]) {
    if (r) roots.push(r);
  }
  return roots;
}

function pythonExe(deps: DiscoverDeps, dir: string): string {
  return deps.isWin ? deps.join(dir, 'python.exe') : deps.join(dir, 'bin', 'python');
}

/** 纯函数:发现全部可用环境(不探测版本)。 */
export function discoverFrom(deps: DiscoverDeps): PythonEnv[] {
  const out: PythonEnv[] = [];
  const seen = new Set<string>();
  const push = (e: PythonEnv) => {
    const key = e.cmd.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  // ---- conda ----
  const condaDirs: string[] = [];
  for (const d of condaEnvironmentsFile(deps)) condaDirs.push(d);
  for (const root of condaRoots(deps)) {
    condaDirs.push(root); // base
    try {
      if (deps.existsSync(root)) {
        const envsDir = deps.join(root, 'envs');
        if (deps.existsSync(envsDir)) {
          for (const name of deps.readdirSync(envsDir)) {
            condaDirs.push(deps.join(envsDir, name));
          }
        }
      }
    } catch {
      /* 目录不可读,跳过 */
    }
  }
  for (const dir of condaDirs) {
    const exe = pythonExe(deps, dir);
    try {
      if (!deps.existsSync(exe)) continue;
    } catch {
      continue;
    }
    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;
    push({
      id: exe,
      name: `${name} (conda)`,
      cmd: exe,
      args: [],
      kind: 'conda',
      rootDir: dir,
    });
  }

  // ---- venv ----
  const venvRoots = (deps.extraRoots ?? []).filter(Boolean);
  for (const root of venvRoots) {
    for (const cand of [deps.join(root, '.venv'), deps.join(root, 'venv'), deps.join(root, 'env')]) {
      const exe = pythonExe(deps, cand);
      try {
        if (!deps.existsSync(exe)) continue;
      } catch {
        continue;
      }
      push({
        id: exe,
        name: `${cand.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'venv'} (venv)`,
        cmd: exe,
        args: [],
        kind: 'venv',
        rootDir: cand,
      });
    }
  }

  // ---- 系统解释器 ----
  const sysRoot = deps.env.SystemRoot || 'C:\\Windows';
  const pf = deps.env.ProgramFiles || 'C:\\Program Files';
  const localApp = deps.env.LOCALAPPDATA || '';
  const sysCands: { cmd: string; args: string[]; label: string }[] = deps.isWin
    ? [
        { cmd: 'python', args: [], label: '系统 Python (PATH)' },
        { cmd: 'python3', args: [], label: '系统 Python3 (PATH)' },
        { cmd: deps.join(sysRoot, 'py.exe'), args: ['-3'], label: 'py -3' },
        ...['313', '312', '311', '310'].flatMap((v) => [
          { cmd: deps.join(pf, `Python${v}`, 'python.exe'), args: [], label: `Python ${v.slice(0, 1)}.${v.slice(1)} (Program Files)` },
          {
            cmd: deps.join(localApp, 'Programs', 'Python', `Python${v}`, 'python.exe'),
            args: [],
            label: `Python ${v.slice(0, 1)}.${v.slice(1)} (用户)`,
          },
        ]),
      ]
    : [
        { cmd: 'python3', args: [], label: '系统 Python3' },
        { cmd: 'python', args: [], label: '系统 Python' },
        { cmd: '/usr/bin/python3', args: [], label: '/usr/bin/python3' },
        { cmd: '/usr/local/bin/python3', args: [], label: '/usr/local/bin/python3' },
      ];

  for (const c of sysCands) {
    // PATH 上的命令无法预验证,直接收录(与 pythonInterpreter 的口径一致)
    const isAbs = /[\\/]/.test(c.cmd);
    if (isAbs) {
      try {
        if (!deps.existsSync(c.cmd)) continue;
      } catch {
        continue;
      }
    }
    push({ id: c.cmd, name: c.label, cmd: c.cmd, args: c.args, kind: 'system' });
  }

  return out;
}

/**
 * 构造子进程环境变量:把环境的 bin 目录前置到 PATH。
 *
 * Windows 上 conda 激活会加 `<env>`、`<env>\Library\bin`、`<env>\Scripts`
 * (带 DLL 的包靠这些目录加载),不补会 `ImportError: DLL load failed`。
 * 另外 `MPLBACKEND=Agg` 防止 matplotlib 在装了 GUI 后端的环境里弹窗卡死。
 */
export function spawnEnvFor(env: PythonEnv | null, base?: Record<string, string | undefined>): Record<string, string> {
  const src: Record<string, string | undefined> = { ...(base ?? {}) };
  const out: Record<string, string> = {};

  // PATH 在 Windows 上大小写不敏感,process.env 里可能同时有 PATH 与 Path。
  // 直接展开会写出两个键 → 其中一个覆盖另一个,PATH 被截断。
  let pathVal = '';
  for (const k of Object.keys(src)) {
    if (k.toLowerCase() === 'path') {
      pathVal = src[k] || pathVal;
      delete src[k];
    }
  }
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined) out[k] = v;
  }

  const prepend: string[] = [];
  if (env?.rootDir) {
    if (env.kind === 'conda') {
      prepend.push(
        env.rootDir,
        `${env.rootDir}\\Library\\bin`,
        `${env.rootDir}\\Scripts`,
        `${env.rootDir}\\Library\\mingw-w64\\bin`,
        `${env.rootDir}\\bin`,
      );
      out.CONDA_PREFIX = env.rootDir;
      // conda 的 python 靠 PYTHONHOME 之外的机制定位,不要设 PYTHONHOME
    } else if (env.kind === 'venv') {
      prepend.push(`${env.rootDir}\\Scripts`, `${env.rootDir}\\bin`);
      out.VIRTUAL_ENV = env.rootDir;
    }
  }
  const cleaned = prepend.filter(Boolean);
  out.PATH = cleaned.length ? [...cleaned, pathVal].filter(Boolean).join(';') : pathVal;

  out.PYTHONIOENCODING = 'utf-8';
  out.MPLBACKEND = 'Agg';
  return out;
}

// ---------------- 运行时封装(懒 require) ----------------

type Requirer = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

function runtimeDeps(extraRoots: string[] = []): DiscoverDeps {
  const proc = (globalThis as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process;
  const fs = nodeRequire('fs') as {
    existsSync(p: string): boolean;
    readFileSync(p: string, enc: string): string;
    readdirSync(p: string): string[];
  };
  const path = nodeRequire('path') as { join(...p: string[]): string; dirname(p: string): string };
  const isWin = proc?.platform === 'win32';
  return {
    isWin,
    existsSync: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    readFileSync: (p) => fs.readFileSync(p, 'utf8'),
    readdirSync: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    join: (...parts) => path.join(...parts),
    dirname: (p) => path.dirname(p),
    env: proc?.env ?? {},
    extraRoots,
  };
}

/** 发现环境(同步,毫秒级)。`extraRoots` 传仓库根可带上其内的 venv。 */
export function discoverPythonEnvs(extraRoots: string[] = []): PythonEnv[] {
  return discoverFrom(runtimeDeps(extraRoots));
}

const versionCache = new Map<string, string>();

/** 并发探测各环境的 Python 版本(带缓存);失败留空,不影响使用。 */
export async function probeVersions(envs: PythonEnv[], concurrency = 4): Promise<PythonEnv[]> {
  const pending = envs.filter((e) => !versionCache.has(e.cmd));
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const env = pending[cursor++];
      if (!env) return;
      const v = await probeOnce(env);
      if (v) versionCache.set(env.cmd, v);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return envs.map((e) => ({ ...e, version: versionCache.get(e.cmd) }));
}

function probeOnce(env: PythonEnv): Promise<string | null> {
  const cp = nodeRequire('child_process') as {
    spawn(cmd: string, args: string[], opts: unknown): {
      stdout: { setEncoding(e: string): void; on(ev: 'data', cb: (c: string) => void): void };
      stderr: { on(ev: 'data', cb: () => void): void };
      on(ev: 'error', cb: (e: Error) => void): void;
      on(ev: 'close', cb: () => void): void;
      kill(): void;
    };
  };
  const base = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      const child = cp.spawn(env.cmd, [...env.args, '-c', 'import sys;print(sys.version.split()[0])'], {
        env: spawnEnvFor(env, base),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (out += c));
      child.stderr.on('data', () => undefined);
      child.on('error', () => finish(null));
      child.on('close', () => finish(out.trim() || null));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(out.trim() || null);
      }, 8000);
    } catch {
      finish(null);
    }
  });
}
