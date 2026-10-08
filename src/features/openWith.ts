/**
 * "Open with" — hand a file to an external application.
 *
 * Ported from `siyuan-editor/src/open-with/*` and `utils/external-app.ts`.
 * Obsidian is desktop-only here (`isDesktopOnly: true`), so Node's
 * `child_process` and Electron's `shell` are both reachable; both are loaded
 * lazily through `require` for the same reason `extFs.ts` does it — a top-level
 * import would break unit tests and touch node builtins during plugin load.
 */

import { Notice, type App, type TAbstractFile, type TFile } from 'obsidian';
import type { OpenWithApp } from '../types';

export type { OpenWithApp };

/** Built-ins a user gets before configuring anything. */
export const PRESET_OPEN_WITH: OpenWithApp[] = [
  { id: 'vscode', name: 'VS Code', command: 'code', args: '%1', enabled: true },
  { id: 'cursor', name: 'Cursor', command: 'cursor', args: '%1', enabled: true },
  { id: 'typora', name: 'Typora', command: 'typora', args: '%1', enabled: true },
  { id: 'notepad', name: '记事本', command: 'notepad', args: '%1', enabled: true },
];

type Requirer = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

interface ElectronShell {
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
}

function electronShell(): ElectronShell | null {
  try {
    const e = nodeRequire('electron') as { shell?: ElectronShell };
    return e?.shell ?? null;
  } catch {
    return null;
  }
}

/**
 * Absolute path of a vault file on disk.
 * `vault.adapter` exposes `basePath` on the desktop `FileSystemAdapter`; the
 * vault API itself never resolves outside the vault root (see extFs.ts).
 */
export function absolutePath(app: App, file: TAbstractFile): string {
  const adapter = app.vault.adapter as unknown as {
    basePath?: string;
    getBasePath?: () => string;
  };
  let base = '';
  try {
    base = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : adapter.basePath || '';
  } catch {
    base = '';
  }
  if (!base) return '';
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${file.path.split('/').join(sep)}`;
}

/** Open with the OS default handler for the file type. */
export async function openWithSystemDefault(app: App, file: TFile): Promise<void> {
  const abs = absolutePath(app, file);
  if (!abs) {
    new Notice('无法确定文件在磁盘上的绝对路径。');
    return;
  }
  const shell = electronShell();
  if (!shell) {
    new Notice('当前环境不支持外部打开。');
    return;
  }
  const err = await shell.openPath(abs);
  if (err) new Notice(`打开失败：${err}`);
}

/** Reveal the file in the OS file manager. */
export function revealInSystemExplorer(app: App, file: TAbstractFile): void {
  const abs = absolutePath(app, file);
  if (!abs) {
    new Notice('无法确定文件在磁盘上的绝对路径。');
    return;
  }
  const shell = electronShell();
  if (shell) {
    shell.showItemInFolder(abs);
    return;
  }
  // No Electron shell (unlikely on desktop): fall back to spawning the
  // platform's file manager directly.
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  void spawnDetached(cmd, [process.platform === 'win32' ? `/select,${abs}` : abs]);
}

function substitute(tpl: string, abs: string, dir: string): string {
  return tpl.replace(/%1/g, abs).replace(/%d/g, dir);
}

/** Start a process fully detached from Obsidian. */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const cp = nodeRequire('child_process') as {
        spawn(cmd: string, args: string[], opts: unknown): { unref(): void; on(ev: string, cb: (e: unknown) => void): void };
      };
      const sep = command.includes('\\') ? '\\' : '/';
      const cwd = command.includes(sep) ? command.slice(0, command.lastIndexOf(sep)) : undefined;
      const child = cp.spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
      });
      child.on('error', (e: unknown) => {
        new Notice(`无法启动「${command}」：${String((e as { message?: string })?.message ?? e)}`);
      });
      child.unref();
    } catch (e) {
      new Notice(`无法启动「${command}」：${String(e)}`);
    }
    resolve();
  });
}

/** Launch one configured external app against a file. */
export async function openWithApp(app: App, file: TFile, target: OpenWithApp): Promise<void> {
  const abs = absolutePath(app, file);
  if (!abs) {
    new Notice('无法确定文件在磁盘上的绝对路径。');
    return;
  }
  const sep = abs.includes('\\') ? '\\' : '/';
  const dir = abs.slice(0, abs.lastIndexOf(sep));
  const argv = substitute(target.args, abs, dir)
    .split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => s.replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  await spawnDetached(target.command, argv);
}

/** Launch a configured app by id (used by the command-palette entries). */
export async function openWithAppById(
  app: App,
  file: TFile,
  apps: OpenWithApp[],
  id: string,
): Promise<void> {
  const target = apps.find((a) => a.id === id);
  if (!target) {
    new Notice(`未找到「${id}」的打开方式配置。`);
    return;
  }
  await openWithApp(app, file, target);
}

/**
 * Copy the file's absolute path to the clipboard.
 * Useful on its own, and it is the only recovery route when a configured
 * command turns out to be wrong.
 */
export async function copyAbsolutePath(app: App, file: TAbstractFile): Promise<void> {
  const abs = absolutePath(app, file);
  if (!abs) {
    new Notice('无法确定文件在磁盘上的绝对路径。');
    return;
  }
  try {
    await navigator.clipboard.writeText(abs);
    new Notice('已复制绝对路径');
  } catch {
    new Notice(`路径：${abs}`);
  }
}

/** Attach the "open with" entries to an Obsidian `Menu`. */
export function addOpenWithMenuItems(
  app: App,
  file: TFile,
  menu: { addItem(cb: (item: { setTitle(t: string): void; setIcon(i: string): void; onClick(cb: () => void): void }) => void): void },
  apps: OpenWithApp[],
): void {
  const enabled = apps.filter((a) => a.enabled);
  for (const a of enabled) {
    menu.addItem((item) => {
      item.setTitle(`用 ${a.name} 打开`);
      item.setIcon('external-link');
      item.onClick(() => void openWithApp(app, file, a));
    });
  }
  menu.addItem((item) => {
    item.setTitle('用系统默认应用打开');
    item.setIcon('arrow-up-right');
    item.onClick(() => void openWithSystemDefault(app, file));
  });
  menu.addItem((item) => {
    item.setTitle('在文件管理器中显示');
    item.setIcon('folder-open');
    item.onClick(() => revealInSystemExplorer(app, file));
  });
  menu.addItem((item) => {
    item.setTitle('复制绝对路径');
    item.setIcon('clipboard-copy');
    item.onClick(() => void copyAbsolutePath(app, file));
  });
}
