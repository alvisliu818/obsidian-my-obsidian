/**
 * 统一的代码执行入口:代码块与代码文件共用,按语言分派。
 *
 * Python 走 `pythonRunner`(真子进程 + 临时 .py,保留 stdin);其余语言同样是
 * 「写临时文件 → spawn」——与 Python 一致的理由:`node -e "<代码>"` /
 * `bash -c "<代码>"` 在 Windows 上会被命令行引号规则搞坏,且中文/换行不可靠。
 *
 * Node 的解释器要注意:**不能用 `process.execPath` 当 node** —— 实测
 * Obsidian.exe 即使带 ELECTRON_RUN_AS_NODE=1 也会照常启动整个应用
 * (思源那套 helper 技巧在这里不适用),所以只找真正的 node。
 */

import { runPythonCode, stripANSI, type RunHandle } from './pythonRunner';
import { getActivePythonEnv } from './activeEnv';
import { resolvePythonInterpreter } from './pythonInterpreter';

export type RunLang = 'python' | 'javascript' | 'shell';

export interface RunCodeOptions {
  code: string;
  lang: RunLang;
  cwd?: string;
  onOutput: (chunk: string) => void;
  onExit: (code: number) => void;
}

/** 代码块语言标签 → 内部语言。新增语言改这一张表即可。 */
export function langFromTag(lang: string): RunLang | null {
  const l = (lang || '').trim().toLowerCase();
  if (l === 'python' || l === 'py') return 'python';
  if (l === 'javascript' || l === 'js' || l === 'node') return 'javascript';
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh' || l === 'powershell' || l === 'ps1') return 'shell';
  return null;
}

/** 文件扩展名 → 内部语言(用于"运行代码文件")。 */
export function langFromExt(extOrPath: string): RunLang | null {
  const ext = (extOrPath || '').replace(/^.*\./, '').toLowerCase();
  if (ext === 'py') return 'python';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1' || ext === 'bat' || ext === 'cmd') return 'shell';
  return null;
}

/** 代码块是否显示 ▶ 运行(与 exec/codeBlockRun 的历史口径一致,多语言后放宽)。 */
export function isRunnableLang(lang: string): boolean {
  return langFromTag(lang) !== null;
}

export { stripANSI };

export function runCode(options: RunCodeOptions): RunHandle {
  if (options.lang === 'python') {
    return runPythonCode({
      code: options.code,
      cwd: options.cwd,
      env: getActivePythonEnv(),
      onOutput: options.onOutput,
      onExit: options.onExit,
    });
  }
  return runScriptFile(options.code, options.lang, options.cwd, options.onOutput, options.onExit);
}

/** 运行一个磁盘上的代码文件。 */
export function runFile(absPath: string, lang: RunLang, cwd: string | undefined, onOutput: (c: string) => void, onExit: (c: number) => void): RunHandle {
  return spawnScript({ file: absPath, lang, cwd, onOutput, onExit });
}

// ---------------------------------------------------------------------

type Requirer = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

interface NodeProcess {
  stdout: { setEncoding(enc: string): void; on(ev: 'data', cb: (c: string) => void): void };
  stderr: { setEncoding(enc: string): void; on(ev: 'data', cb: (c: string) => void): void };
  stdin: { write(s: string): void; destroyed: boolean };
  on(ev: 'error', cb: (e: Error) => void): void;
  on(ev: 'exit', cb: (code: number) => void): void;
  kill(): void;
  pid?: number;
}

let seq = 0;

function tempDir(): string {
  const os = nodeRequire('os') as { tmpdir(): string };
  const fs = nodeRequire('fs') as { existsSync(p: string): boolean; mkdirSync(p: string, o: { recursive: true }): void };
  const path = nodeRequire('path') as { join(...p: string[]): string };
  const dir = path.join(os.tmpdir(), 'obsidian-logseq-run');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
}

/** Windows:PowerShell;其它:bash。 */
function shellCommand(isWin: boolean): { cmd: string; args: string[]; ext: string } {
  if (isWin) {
    const ps =
      process.env?.SystemRoot
        ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : 'powershell.exe';
    return { cmd: ps, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'], ext: 'ps1' };
  }
  return { cmd: 'bash', args: [], ext: 'sh' };
}

/**
 * PowerShell scripts (.ps1) go to PowerShell; every other shell family member
 * goes to bash — including on Windows, where that means Git Bash or WSL.
 *
 * The old code handed EVERYTHING non-JavaScript to `powershell -File`, so a
 * `.py` was executed as a PowerShell script and died with
 * "… is not a valid Windows PowerShell script file" (the `.ps1 extension` is
 * in the message). Windows has no association between an extension and an
 * interpreter — that mapping is ours to make.
 */
function scriptCommand(
  file: string,
  isWin: boolean,
): { cmd: string; args: string[] } {
  if (/\.ps1$/i.test(file)) {
    const ps = shellCommand(isWin);
    return { cmd: ps.cmd, args: [...ps.args, file] };
  }
  return { cmd: 'bash', args: [file] };
}

function isWindows(): boolean {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  return proc?.platform === 'win32';
}

/** A handle with nothing behind it — used when the run cannot even start. */
function emptyHandle(): RunHandle {
  return { sendInput: () => {}, interrupt: () => {} };
}

/** 把代码落到临时文件再执行。 */
function runScriptFile(
  code: string,
  lang: RunLang,
  cwd: string | undefined,
  onOutput: (c: string) => void,
  onExit: (c: number) => void,
): RunHandle {
  const fs = nodeRequire('fs') as {
    writeFileSync(p: string, data: string, enc: { encoding: 'utf8' }): void;
    existsSync(p: string): boolean;
    unlinkSync(p: string): void;
  };
  const path = nodeRequire('path') as { join(...p: string[]): string };
  const ext = lang === 'javascript' ? '.js' : isWindows() ? '.ps1' : '.sh';
  const file = path.join(tempDir(), `run-${Date.now().toString(36)}-${(seq++).toString(36)}${ext}`);
  fs.writeFileSync(file, code.replace(/\r\n/g, '\n'), { encoding: 'utf8' });
  // 临时文件在进程结束后删除
  const cleanup = () => {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
  return spawnScript({ file, lang, cwd, onOutput, onExit, onDone: cleanup });
}

function spawnScript(opts: {
  file: string;
  lang: RunLang;
  cwd?: string;
  onOutput: (c: string) => void;
  onExit: (c: number) => void;
  onDone?: () => void;
}): RunHandle {
  const cp = nodeRequire('child_process') as { spawn(cmd: string, args: string[], opts: unknown): NodeProcess };
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const win = isWindows();

  let cmd: string;
  let args: string[];
  if (opts.lang === 'javascript') {
    cmd = 'node';
    args = [opts.file];
  } else if (opts.lang === 'python') {
    // Same interpreter the code-block ▶ button uses — the one picked in
    // settings, so a conda env / venv wins over whatever `python` resolves to.
    const py = resolvePythonInterpreter(getActivePythonEnv());
    if (!py) {
      opts.onOutput(
        '\n[未找到 Python] 请在设置里选择环境，或安装 Python 3 并确保它在 PATH 中。\n',
      );
      opts.onExit(-1);
      return emptyHandle();
    }
    cmd = py.cmd;
    args = [...py.args, opts.file];
  } else {
    const sh = scriptCommand(opts.file, win);
    cmd = sh.cmd;
    args = sh.args;
  }

  const child = cp.spawn(cmd, args, {
    cwd: opts.cwd || undefined,
    env: { ...proc?.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => opts.onOutput(stripANSI(chunk)));
  child.stderr.on('data', (chunk: string) => opts.onOutput(stripANSI(chunk)));

  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    opts.onDone?.();
    opts.onExit(code);
  };
  child.on('error', (e: Error) => {
    if (exited) return;
    const hint = opts.lang === 'javascript' ? '未找到 node,请在 PATH 中安装 Node.js' : '启动失败';
    opts.onOutput(`\n[${hint}] ${e?.message || e}\n`);
    finish(-1);
  });
  child.on('exit', (code: number) => {
    finish(code ?? 0);
  });

  return {
    sendInput(line: string) {
      if (exited || child.stdin.destroyed) return;
      try {
        child.stdin.write(line.replace(/\r?\n$/, '') + '\n');
      } catch {
        /* ignore */
      }
    },
    interrupt() {
      if (exited) return;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}
