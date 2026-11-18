/**
 * 脚本/命令挂载（思源 action-mount 对齐）：action:// 叶子。
 *
 * vPath = "action://" + encodeURIComponent(JSON.stringify(spec))——spec 即身份，
 * 编辑 = 原位重写 vPath。shell 走 child_process.exec（120s/10MB/windowsHide），
 * js 在宿主页面上下文跑（new Function，console 被捕获进输出）。
 */
import { App, Modal } from 'obsidian';

export interface ActionSpec {
  type: 'shell' | 'js';
  cmd: string;
  cwd?: string;
}

export const ACTION_PREFIX = 'action://';

export function makeActionVPath(spec: ActionSpec): string {
  return ACTION_PREFIX + encodeURIComponent(JSON.stringify(spec));
}

export function isActionPath(p: string): boolean {
  return String(p || '').startsWith(ACTION_PREFIX);
}

export function parseActionSpec(p: string): ActionSpec | null {
  try {
    const raw = decodeURIComponent(String(p).slice(ACTION_PREFIX.length));
    const spec = JSON.parse(raw) as ActionSpec;
    if (!spec || (spec.type !== 'shell' && spec.type !== 'js') || !spec.cmd) return null;
    return spec;
  } catch {
    return null;
  }
}

export interface ActionRunResult {
  ok: boolean;
  output: string;
}

function nodeRequire(): any | null {
  try {
    return (window as any).require?.('electron') ? (window as any).require : null;
  } catch {
    return null;
  }
}

/** 运行一个 action。shell 桌面端专属；js 任何环境可跑。 */
export async function runActionSpec(spec: ActionSpec): Promise<ActionRunResult> {
  if (spec.type === 'js') {
    const logs: string[] = [];
    const fakeConsole = {
      log: (...a: unknown[]) => logs.push(a.map((x) => String(x)).join(' ')),
      warn: (...a: unknown[]) => logs.push('[warn] ' + a.map((x) => String(x)).join(' ')),
      error: (...a: unknown[]) => logs.push('[error] ' + a.map((x) => String(x)).join(' ')),
      info: (...a: unknown[]) => logs.push('[info] ' + a.map((x) => String(x)).join(' ')),
    };
    try {
      const fn = new Function('console', spec.cmd) as (c: typeof fakeConsole) => void;
      fn(fakeConsole);
      return { ok: true, output: logs.join('\n') || '(无输出)' };
    } catch (e) {
      return { ok: false, output: logs.join('\n') + '\n[异常] ' + String((e as Error)?.message ?? e) };
    }
  }
  // shell
  const req = nodeRequire();
  if (!req) return { ok: false, output: 'shell 命令需要桌面端（Node 能力不可用）' };
  return new Promise((resolve) => {
    try {
      const cp = req('child_process');
      cp.exec(
        spec.cmd,
        {
          cwd: spec.cwd || undefined,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (err: Error | null, stdout: string, stderr: string) => {
          let output = String(stdout || '');
          if (stderr) output += (output ? '\n' : '') + '[stderr]\n' + stderr;
          const code = err ? (err as any)?.code ?? 1 : 0;
          output += (output ? '\n' : '') + `[退出码] ${code}`;
          if (err && code === null) output += '\n[错误] ' + String(err.message ?? err);
          resolve({ ok: !err || code === 0, output });
        },
      );
    } catch (e) {
      resolve({ ok: false, output: '[异常] ' + String((e as Error)?.message ?? e) });
    }
  });
}

/** 执行 action 并用 Obsidian Modal 展示输出（思源 Dialog 同款形态）。 */
export async function executeActionMount(app: App, vPath: string): Promise<void> {
  const spec = parseActionSpec(vPath);
  if (!spec) {
    // 动态导入失败/坏 spec：静默（调用方已有 Notice 面）
    return;
  }
  const modal = new (class extends Modal {
    onOpen(): void {
      this.contentEl.createEl('h3', { text: '执行中…' });
      const pre = this.contentEl.createEl('pre', { cls: 'ob-action-out' });
      pre.setText('运行中…');
      void runActionSpec(spec).then((r) => {
        pre.setText(r.output);
        if (!r.ok) pre.style.color = 'var(--text-error)';
      });
    }
    onClose(): void {
      this.contentEl.empty();
    }
  })(app);
  modal.open();
}
