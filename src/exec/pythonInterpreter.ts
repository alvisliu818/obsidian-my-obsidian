/**
 * Python 解释器探测 — 移植自 siyuan-editor `src/utils/kernel/legacy-python.ts`
 * 的 `resolvePythonInterpreter()`(思源侧「内核启动」与「编辑器 ▶ 运行」共用
 * 这一份候选逻辑,移植后本插件同样共用)。
 *
 * 探测顺序(Windows):
 *   PATH 上的 python / python3 → 系统盘 py.exe → Program Files 与
 *   LocalAppData 下的 Python310–313。
 * 绝对路径候选先试(`fs.existsSync` 能预先验证);PATH 命令无法预先探测,
 * 返回第一个让 spawn 去试,ENOENT 由 child 的 error 事件回报。
 *
 * 纯逻辑拆成 `resolveFrom`,依赖(fs/path/platform/env)全部注入 —— 可单测;
 * `resolvePythonInterpreter()` 是薄封装,按 Obsidian 桌面端的惯例懒取 node 模块
 * (同 `features/extFs.ts` / `features/openWith.ts`,顶层 require 会被 esbuild 当
 * 浏览器代码打包,必须运行时才解析)。
 */

export interface PythonCandidate {
  cmd: string;
  args: string[];
}

interface ResolveDeps {
  existsSync(p: string): boolean;
  join(...parts: string[]): string;
  isWin: boolean;
  env: Record<string, string | undefined>;
}

/** 纯函数:在给定依赖下解析候选;找不到返回 null(不应发生,PATH 恒有兜底)。 */
export function resolveFrom(deps: ResolveDeps): PythonCandidate | null {
  const { existsSync, join, isWin, env } = deps;

  const absCandidates: PythonCandidate[] = [];
  const pathCandidates: PythonCandidate[] = [];

  if (isWin) {
    const sysRoot = env.SystemRoot || 'C:\\Windows';
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const localApp = env.LOCALAPPDATA || '';
    pathCandidates.push({ cmd: 'python', args: [] });
    pathCandidates.push({ cmd: 'python3', args: [] });
    absCandidates.push({ cmd: join(sysRoot, 'py.exe'), args: ['-3'] });
    for (const v of ['313', '312', '311', '310']) {
      absCandidates.push({ cmd: join(pf, `Python${v}`, 'python.exe'), args: [] });
      absCandidates.push({ cmd: join(localApp, 'Programs', 'Python', `Python${v}`, 'python.exe'), args: [] });
    }
  } else {
    pathCandidates.push({ cmd: 'python3', args: [] });
    pathCandidates.push({ cmd: 'python', args: [] });
    absCandidates.push({ cmd: '/usr/bin/python3', args: [] });
    absCandidates.push({ cmd: '/usr/local/bin/python3', args: [] });
  }

  for (const c of absCandidates) {
    try {
      if (existsSync(c.cmd)) return c;
    } catch {
      // 试下一个
    }
  }
  // PATH 上的命令无法预先探测,返回第一个让 spawn 决定;
  // 若它 ENOENT,child 的 error 事件会给出足够信息
  return pathCandidates[0] || null;
}

type Requirer = (id: string) => unknown;

/** 懒取 node require(同 openWith.ts 的惯例,eval 兜底 esbuild 打包环境)。 */
function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (r) return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

/**
 * 探测/选择解释器。
 *
 * `preferred` 是用户在设置里选中的环境(conda / venv / 自定义路径)——命中就
 * 直接用,不再走探测链。环境切换的意义正在于此:选了 ai 环境就必须是 ai 的
 * python,而不是 PATH 上第一个。
 */
export function resolvePythonInterpreter(preferred?: PythonCandidate | null): PythonCandidate | null {
  if (preferred && preferred.cmd) return { cmd: preferred.cmd, args: preferred.args ?? [] };
  const proc = (globalThis as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process;
  if (!proc) return null;
  const fs = nodeRequire('fs') as { existsSync(p: string): boolean };
  const path = nodeRequire('path') as { join(...parts: string[]): string };
  return resolveFrom({
    existsSync: (p) => fs.existsSync(p),
    join: (...parts) => path.join(...parts),
    isWin: proc.platform === 'win32',
    env: proc.env ?? {},
  });
}
