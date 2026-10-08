/**
 * 文档内 Python 代码块的执行器 — 移植自 siyuan-editor
 * `src/protyle/code-block-run-exec.ts`(实机验证过的实现),环境适配:
 *
 * - 临时目录:思源侧放工作空间 data/temp/(同步时不会带上);Obsidian 没有
 *   workspaceDir 概念,改走 os.tmpdir() 下的专用子目录。
 * - require:同 extFs.ts,懒加载(eval 兜底 esbuild 打包环境)。
 *
 * 三个原样保留的设计决定(思源侧注释原文的结论,别改回去):
 *
 * 1. 为什么不用持久内核(kernel.execute):内核走「发代码 → 拿结果」模型,
 *    没有 stdin 通道,input() 直接 EOF 报错。文档里的代码块经常是交互式脚本,
 *    必须走**真子进程 + 管道**。
 * 2. 为什么每次都新建进程:代码块之间没有「共享变量」语义,复用反而让状态
 *    互相污染;长驻进程一旦被用户代码 sys.exit() 带走就废了。
 * 3. 为什么落到临时 .py 文件:代码可能有非 ASCII、缩进、CRLF,直接
 *    `python -c "<整段代码>"` 在 Windows 上会被命令行引号规则搞坏。
 */

import { resolvePythonInterpreter } from './pythonInterpreter';

export interface RunHandle {
  /** 向 stdin 写一行(input() 会消费掉它) */
  sendInput(line: string): void;
  /** 中断:杀进程 */
  interrupt(): void;
}

export interface RunOptions {
  code: string;
  /** 工作目录(缺省 = 临时目录) */
  cwd?: string;
  onOutput: (chunk: string) => void;
  onExit: (code: number) => void;
}

// ANSI 转义序列:子进程输出可能带颜色,面板是纯文本展示,留着会显示成乱码。
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)|\r/g;

/**
 * Windows 上 Python 的输出全是 \r\n。只能删 \r **不能删整个 \r\n** ——
 * 之前用 /\r\n?/g 一起删,两行的输出会粘成一行(思源侧踩过的坑)。
 */
export function stripANSI(text: string): string {
  return text.replace(ANSI_RE, '');
}

type Requirer = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

let runSeq = 0;

/** 临时脚本目录:os.tmpdir() 下的专用子目录,建不了就退回 tmpdir 本身。 */
function tempScriptDir(): string {
  const os = nodeRequire('os') as { tmpdir(): string };
  const fs = nodeRequire('fs') as { existsSync(p: string): boolean; mkdirSync(p: string, o: { recursive: true }): void };
  const base = os.tmpdir();
  const dir = base.replace(/[\\/]+$/, '') + '\\obsidian-logseq-py-run';
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return base;
  }
}

/** 执行一段 Python 代码;返回句柄。同步抛错表示根本没起来(调用方展示原因)。 */
export function runPythonCode(options: RunOptions): RunHandle {
  const python = resolvePythonInterpreter();
  if (!python) {
    throw new Error('未找到 Python。请安装 Python 3 并确保 python 在 PATH 中');
  }

  const fs = nodeRequire('fs') as {
    writeFileSync(p: string, data: string, enc: { encoding: 'utf8' }): void;
    existsSync(p: string): boolean;
    unlinkSync(p: string): void;
  };
  const cp = nodeRequire('child_process') as {
    spawn(cmd: string, args: string[], opts: unknown): NodeProcess;
  };

  const runId = `${Date.now().toString(36)}-${(runSeq++).toString(36)}`;
  const script = `${tempScriptDir()}\\run-${runId}.py`;
  // BOM 必须写:Windows 上 Python 3 默认按本地代码页读源文件,
  // 没有 BOM 会把 UTF-8 中文当 GBK 解,报出来的语法错误莫名其妙。
  fs.writeFileSync(script, '\ufeff' + options.code.replace(/\r\n/g, '\n'), { encoding: 'utf8' });

  const proc = nodeRequire('process') as { env?: Record<string, string | undefined> };
  const child = cp.spawn(
    python.cmd,
    [...python.args, '-u', script],
    {
      cwd: options.cwd || undefined,
      env: {
        ...proc?.env,
        PYTHONIOENCODING: 'utf-8', // 双保险:输出固定 UTF-8
        PYTHONNOUSERSITE: '1',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => options.onOutput(stripANSI(chunk)));
  child.stderr.on('data', (chunk: string) => options.onOutput(stripANSI(chunk)));

  let exited = false;
  child.on('error', (e: Error) => {
    if (exited) return;
    exited = true;
    cleanup();
    options.onOutput(`\n[无法启动进程] ${e?.message || e}\n`);
    options.onExit(-1);
  });
  child.on('exit', (code: number) => {
    if (exited) return;
    exited = true;
    cleanup();
    options.onExit(code ?? 0);
  });

  function cleanup() {
    try {
      if (fs.existsSync(script)) fs.unlinkSync(script);
    } catch {
      // 临时文件删不掉不影响功能
    }
  }

  return {
    sendInput(line: string) {
      if (exited || child.stdin.destroyed) return;
      try {
        // 必须补换行:input() 读到的是一行,不给 \n 它会一直等
        child.stdin.write(line.replace(/\r?\n$/, '') + '\n');
      } catch {
        // 进程可能刚退出,忽略
      }
    },
    interrupt() {
      if (exited) return;
      try {
        child.kill();
      } catch {
        // 已退出
      }
    },
  };
}

/** 子进程最小接口(避免引 @types/node 的 ChildProcess 全家桶)。 */
interface NodeProcess {
  stdout: { setEncoding(enc: string): void; on(ev: 'data', cb: (c: string) => void): void };
  stderr: { setEncoding(enc: string): void; on(ev: 'data', cb: (c: string) => void): void };
  stdin: { write(s: string): void; destroyed: boolean };
  on(ev: 'error', cb: (e: Error) => void): void;
  on(ev: 'exit', cb: (code: number) => void): void;
  kill(): void;
  pid?: number;
}
