/**
 * Python 环境(conda / venv / 系统)发现与切换。
 *
 * 与 obsidian-logseq 的 `exec/pythonEnvs.ts` 同源逻辑。为什么不共用一份:
 * 两个插件都可独立安装,硬依赖会让 notebook 在没装 logseq 插件时不可用。
 * 所以这里是**软依赖优先** —— 装了 logseq 插件就用它暴露的同一份发现结果
 * (避免两处清单不一致),没装就用自己的实现降级。
 *
 * 两条实测结论:
 * 1. conda 环境清单优先读 `~/.conda/environments.txt`(conda 自己维护的注册表),
 *    比起进程跑 `conda env list` 快几个数量级,放在设置面板展开时才有意义。
 * 2. 切换环境 = 直接 spawn `<env>\python.exe` + 手动把环境的 bin 目录前置进
 *    PATH。**不要 conda activate**:spawn 不是 shell,activate.bat 跑不了,
 *    绕 `cmd /c activate && python` 还会污染内核的 JSON 协议流。
 */

export type PyEnvKind = 'conda' | 'venv' | 'system';

export interface PythonEnv {
  id: string;
  name: string;
  cmd: string;
  args: string[];
  kind: PyEnvKind;
  /** 环境根目录(conda env / venv),系统解释器为 undefined */
  rootDir?: string;
  version?: string;
}

let active: PythonEnv | null = null;

export function setActiveEnv(env: PythonEnv | null): void {
  active = env;
}

export function getActiveEnv(): PythonEnv | null {
  return active;
}

type Requirer = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

function deps() {
  const proc = (globalThis as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process;
  const fs = nodeRequire('fs') as {
    existsSync(p: string): boolean;
    readFileSync(p: string, e: string): string;
    readdirSync(p: string): string[];
  };
  const pathMod = nodeRequire('path') as { join(...p: string[]): string; dirname(p: string): string };
  return {
    isWin: proc?.platform === 'win32',
    env: proc?.env ?? {},
    exists: (p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    readText: (p: string) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return '';
      }
    },
    readDir: (p: string) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    join: (...p: string[]) => pathMod.join(...p),
    dirname: (p: string) => pathMod.dirname(p),
  };
}

/** 发现本机可用环境(毫秒级,同步)。 */
export function discoverPythonEnvs(): PythonEnv[] {
  // 软依赖:装了 obsidian-logseq 就用它的同一份清单
  const shared = (
    globalThis as {
      app?: { plugins?: { plugins?: Record<string, { pythonEnvs?: { discover?: (r?: string[]) => PythonEnv[] } }> } };
    }
  ).app?.plugins?.plugins?.['obsidian-logseq']?.pythonEnvs;
  if (shared?.discover) {
    try {
      const list = shared.discover();
      if (Array.isArray(list) && list.length) return list;
    } catch {
      /* 回落到自己的实现 */
    }
  }

  const d = deps();
  const out: PythonEnv[] = [];
  const seen = new Set<string>();
  const push = (e: PythonEnv) => {
    const k = e.cmd.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  const py = (dir: string) => (d.isWin ? d.join(dir, 'python.exe') : d.join(dir, 'bin', 'python'));

  // ---- conda ----
  const dirs: string[] = [];
  const home = d.env.USERPROFILE || d.env.HOME || '';
  if (home) {
    const file = d.join(home, '.conda', 'environments.txt');
    if (d.exists(file)) {
      for (const line of d.readText(file).split(/\r?\n/)) {
        const t = line.trim();
        if (t) dirs.push(t);
      }
    }
  }
  const roots: string[] = [];
  if (d.env.CONDA_EXE) roots.push(d.dirname(d.dirname(d.env.CONDA_EXE)));
  for (const r of [
    d.join(home, 'anaconda3'),
    d.join(home, 'miniconda3'),
    'D:\\programs\\anaconda3',
    'C:\\ProgramData\\Anaconda3',
    '/opt/conda',
  ]) {
    if (r) roots.push(r);
  }
  for (const root of roots) {
    dirs.push(root);
    const envsDir = d.join(root, 'envs');
    if (d.exists(envsDir)) for (const n of d.readDir(envsDir)) dirs.push(d.join(envsDir, n));
  }
  for (const dir of dirs) {
    const exe = py(dir);
    if (!d.exists(exe)) continue;
    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;
    push({ id: exe, name: `${name} (conda)`, cmd: exe, args: [], kind: 'conda', rootDir: dir });
  }

  // ---- 系统 ----
  const sysRoot = d.env.SystemRoot || 'C:\\Windows';
  const pf = d.env.ProgramFiles || 'C:\\Program Files';
  const cands: { cmd: string; args: string[]; label: string }[] = d.isWin
    ? [
        { cmd: 'python', args: [], label: '系统 Python (PATH)' },
        { cmd: d.join(sysRoot, 'py.exe'), args: ['-3'], label: 'py -3' },
        ...['313', '312', '311', '310'].map((v) => ({
          cmd: d.join(pf, `Python${v}`, 'python.exe'),
          args: [] as string[],
          label: `Python ${v.slice(0, 1)}.${v.slice(1)}`,
        })),
      ]
    : [
        { cmd: 'python3', args: [], label: '系统 Python3' },
        { cmd: 'python', args: [], label: '系统 Python' },
      ];
  for (const c of cands) {
    if (/[\\/]/.test(c.cmd) && !d.exists(c.cmd)) continue;
    push({ id: c.cmd, name: c.label, cmd: c.cmd, args: c.args, kind: 'system' });
  }
  return out;
}

/**
 * 子进程环境变量:把环境的 bin 目录前置到 PATH。
 * Windows 上 conda 激活会加 <env>、<env>\Library\bin、<env>\Scripts(带 DLL 的包
 * 靠这些目录加载),不补会 `ImportError: DLL load failed`。MPLBACKEND=Agg 防止
 * matplotlib 在装了 GUI 后端的环境里弹窗卡死。
 */
export function spawnEnvFor(env: PythonEnv | null, base?: Record<string, string | undefined>): Record<string, string> {
  const src: Record<string, string | undefined> = { ...(base ?? {}) };
  const out: Record<string, string> = {};

  // Windows 上 process.env 可能同时有 PATH 与 Path;直接展开会写出两个键,
  // 其中一个覆盖另一个 → PATH 被截断。
  let pathVal = '';
  for (const k of Object.keys(src)) {
    if (k.toLowerCase() === 'path') {
      pathVal = src[k] || pathVal;
      delete src[k];
    }
  }
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v;

  const prepend: string[] = [];
  if (env?.rootDir) {
    if (env.kind === 'conda') {
      prepend.push(env.rootDir, `${env.rootDir}\\Library\\bin`, `${env.rootDir}\\Scripts`, `${env.rootDir}\\bin`);
      out.CONDA_PREFIX = env.rootDir;
    } else if (env.kind === 'venv') {
      prepend.push(`${env.rootDir}\\Scripts`, `${env.rootDir}\\bin`);
      out.VIRTUAL_ENV = env.rootDir;
    }
  }
  out.PATH = prepend.length ? [...prepend, pathVal].filter(Boolean).join(';') : pathVal;
  out.PYTHONIOENCODING = 'utf-8';
  out.MPLBACKEND = 'Agg';
  return out;
}
