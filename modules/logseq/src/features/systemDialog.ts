/**
 * Native (OS) pickers for choosing what to mount: a folder OR a single file.
 *
 * The mount editor used to be text-only, because neither `app.showFolderPicker`
 * nor `app.showOpenDialog` exists in this build (measured). The system dialog
 * IS reachable another way, though — measured in `obsidian.asar`, Obsidian
 * installs the Electron module on the window itself:
 *
 *   window.electron = require('electron')
 *   if (!electron.remote) electron.remote = require('@electron/remote')
 *
 * and then calls `electron.remote.dialog.showOpenDialogSync({ properties:
 * ['openDirectory'] })` for its own folder prompts. So this module reaches for
 * the very object Obsidian uses, and the picker is a real Windows Explorer
 * window — not an in-app tree.
 *
 * Two guarantees the callers rely on:
 *   1. Never throws, never blocks the UI thread (async dialog only).
 *   2. Returns '' for "nothing chosen" — cancel, unsupported platform, a dead
 *      dialog — so the caller keeps whatever path was already typed.
 *
 * The PowerShell fallback exists because `@electron/remote` belongs to the host
 * app, not to this plugin: if a future Obsidian drops it the button would go
 * dead. It opens the same kind of dialog through System.Windows.Forms (STA,
 * UTF-8 output) and is only tried when the Electron path produced nothing.
 *
 * No `obsidian` import: everything decidable without IO is a pure exported
 * helper, and the rest goes through injectable hooks, so the whole module is
 * unit-testable outside Obsidian.
 */

import { dirOf } from './extFs';

/** What the dialog should return. */
export type PickKind = 'folder' | 'file';

export interface PickOptions {
  kind: PickKind;
  /** Dialog caption. */
  title?: string;
  /** Directory the dialog opens in. '' = whatever the OS picks. */
  startDir?: string;
  /** Only for `kind: 'file'`; empty = every file. */
  filters?: { name: string; extensions: string[] }[];
}

/** The one Electron dialog shape used here (async, options object). */
export interface DialogLike {
  showOpenDialog(...args: unknown[]): Promise<DialogResult> | DialogResult;
}

export interface DialogResult {
  canceled?: boolean;
  filePaths?: string[];
}

/** child_process.execFile surface — injected so tests never spawn a process. */
export interface ExecFileLike {
  execFile(
    file: string,
    args: string[],
    opts: { timeout: number; windowsHide: boolean; encoding: string },
    cb: (err: unknown, stdout: unknown) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Injection points (tests) and lazy requires (production)
// ---------------------------------------------------------------------------

const hooks: {
  dialog?: DialogLike | null;
  exec?: ExecFileLike | null;
  platform?: string;
  require?: (id: string) => unknown;
  global?: Record<string, unknown>;
} = {};

/** Force the Electron dialog (or `null` = pretend it is missing). */
export function __setDialogForTest(d: DialogLike | null | undefined): void {
  hooks.dialog = d;
}

/** Force `child_process` (the PowerShell fallback). */
export function __setExecForTest(e: ExecFileLike | null | undefined): void {
  hooks.exec = e;
}

/** Force the platform the fallback checks (`process.platform`). */
export function __setPlatformForTest(p: string | undefined): void {
  hooks.platform = p;
}

/** Force the global object the Electron module is looked up on. */
export function __setGlobalForTest(g: Record<string, unknown> | undefined): void {
  hooks.global = g;
}

/** Force the module loader used for `require('electron')`. */
export function __setRequireForTest(r: ((id: string) => unknown) | undefined): void {
  hooks.require = r;
}

/** Reset every hook — call in `afterEach` so no test leaks into another. */
export function __resetSystemDialogForTest(): void {
  delete hooks.dialog;
  delete hooks.exec;
  delete hooks.platform;
  delete hooks.require;
  delete hooks.global;
}

type Requirer = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  if (hooks.require) return hooks.require(id);
  const g = (hooks.global ?? globalThis) as unknown as { require?: Requirer };
  if (typeof g.require === 'function') return g.require(id);
  try {
    // esbuild keeps a bare `require` for externals; `eval` keeps bundlers and
    // ESM test runners from resolving it at build time.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return (0, eval)('require')(id);
  } catch {
    return undefined;
  }
}

function tryRequire(id: string): unknown {
  try {
    return nodeRequire(id);
  } catch {
    return undefined;
  }
}

function globalObj(): Record<string, unknown> {
  if (hooks.global) return hooks.global;
  const w = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  return (w ?? globalThis) as unknown as Record<string, unknown>;
}

/**
 * The dialog to use, or null when this environment cannot show one.
 *
 * `window.electron` first: that is the object Obsidian itself built (remote
 * already patched in). Requiring `electron` / `@electron/remote` directly is
 * the fallback for hosts that skip that step.
 */
export function resolveDialog(): DialogLike | null {
  if (hooks.dialog !== undefined) return hooks.dialog;
  const g = globalObj();
  const candidates: unknown[] = [
    (g as { electron?: unknown }).electron,
    tryRequire('electron'),
    tryRequire('@electron/remote'),
  ];
  for (const mod of candidates) {
    const m = mod as { remote?: { dialog?: DialogLike }; dialog?: DialogLike } | undefined;
    const dlg = m?.remote?.dialog ?? m?.dialog;
    if (dlg && typeof dlg.showOpenDialog === 'function') return dlg;
  }
  return null;
}

/** True when the 浏览 buttons are worth rendering at all. */
export function hasSystemPicker(): boolean {
  if (resolveDialog()) return true;
  // The fallback dialogs are WinForms, so it is Windows-only.
  return platform() === 'win32';
}

function platform(): string {
  if (hooks.platform) return hooks.platform;
  const p = (globalThis as unknown as { process?: { platform?: string } }).process?.platform;
  return p ?? '';
}

function resolveExec(): ExecFileLike | null {
  if (hooks.exec !== undefined) return hooks.exec;
  const cp = tryRequire('child_process') as ExecFileLike | undefined;
  return cp && typeof cp.execFile === 'function' ? cp : null;
}

// ---------------------------------------------------------------------------
// Pure helpers (no IO — unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Where the next dialog should open.
 *
 * A path already in the field wins over the remembered one — the user is
 * clearly working on that spot. A directory opens AT itself, a file at its
 * parent (you cannot open a folder dialog "inside" a file).
 */
export function startDirFor(current: string, currentIsDir: boolean, remembered: string): string {
  const c = current.trim().replace(/[\\/]+$/, '');
  if (c) return currentIsDir ? c : dirOf(c);
  return remembered.trim();
}

/**
 * What to remember after a successful pick, so the next dialog starts there.
 *
 * Folder → the folder itself (that is where the dialog was standing when it
 * was confirmed). File → its parent. A bare name with no separator remembers
 * nothing rather than '' (which would reset the user's saved location).
 */
export function rememberedDirFor(picked: string, kind: PickKind): string {
  const p = picked.trim().replace(/[\\/]+$/, '');
  if (!p) return '';
  return kind === 'folder' ? p : dirOf(p);
}

// ---------------------------------------------------------------------------
// The pick itself
// ---------------------------------------------------------------------------

const PS_TIMEOUT_MS = 600_000; // the user may take a while; 10 min is generous

/**
 * Open the system picker. Resolves to the chosen absolute path, or '' when
 * nothing was chosen / no dialog could be opened.
 */
export async function pickExternalPath(opts: PickOptions): Promise<string> {
  const dlg = resolveDialog();
  if (dlg) {
    const viaElectron = await callElectron(dlg, opts);
    // `ok: false` = the dialog itself failed (not a cancel) → try the fallback.
    if (viaElectron.ok) return viaElectron.path;
  }
  return pickWithPowerShell(opts);
}

async function callElectron(dlg: DialogLike, opts: PickOptions): Promise<{ ok: boolean; path: string }> {
  const options: Record<string, unknown> = {
    title: opts.title ?? (opts.kind === 'folder' ? '选择要挂载的文件夹' : '选择要挂载的文件'),
    properties: opts.kind === 'folder'
      ? ['openDirectory', 'dontAddToRecent']
      : ['openFile', 'dontAddToRecent'],
    ...(opts.startDir ? { defaultPath: opts.startDir } : {}),
    ...(opts.kind === 'file' && opts.filters?.length ? { filters: opts.filters } : {}),
  };
  try {
    let res = await dlg.showOpenDialog(options);
    // Some builds of the remote dialog insist on a parent window first.
    if (!res && typeof dlg.showOpenDialog === 'function') {
      const win = (globalObj() as { electron?: { remote?: { getCurrentWindow?: () => unknown } } })
        .electron?.remote?.getCurrentWindow?.();
      if (win) res = await dlg.showOpenDialog(win, options);
    }
    if (!res || res.canceled || !res.filePaths?.length) return { ok: true, path: '' };
    return { ok: true, path: String(res.filePaths[0]).trim() };
  } catch {
    return { ok: false, path: '' };
  }
}

/**
 * Windows-only fallback: show a WinForms dialog through PowerShell.
 *
 * STA is mandatory (`ShowDialog` throws on an MTA thread) and UTF-8 output is
 * set explicitly, because PowerShell 5.1 otherwise writes the console codepage
 * and a Chinese path comes back as mojibake.
 */
async function pickWithPowerShell(opts: PickOptions): Promise<string> {
  if (platform() !== 'win32') return '';
  const exec = resolveExec();
  if (!exec) return '';
  const script = buildPsScript(opts);
  return new Promise<string>((resolve) => {
    try {
      exec.execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: PS_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
        (_err, stdout) => {
          const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
          const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
          resolve(line ?? '');
        },
      );
    } catch {
      resolve('');
    }
  });
}

/** The PowerShell script for one pick. Exported so it can be asserted on. */
export function buildPsScript(opts: PickOptions): string {
  const q = (s: string): string => `'${(s ?? '').replace(/'/g, "''")}'`;
  const lines: string[] = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  ];
  if (opts.kind === 'folder') {
    lines.push('$d = New-Object System.Windows.Forms.FolderBrowserDialog');
    lines.push(`$d.Description = ${q(opts.title ?? '选择要挂载的文件夹')}`);
    if (opts.startDir) lines.push(`$d.SelectedPath = ${q(opts.startDir)}`);
    lines.push('$d.ShowNewFolderButton = $true');
    lines.push(
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
    );
  } else {
    lines.push('$d = New-Object System.Windows.Forms.OpenFileDialog');
    lines.push(`$d.Title = ${q(opts.title ?? '选择要挂载的文件')}`);
    if (opts.startDir) lines.push(`$d.InitialDirectory = ${q(opts.startDir)}`);
    lines.push(`$d.Filter = ${q('所有文件 (*.*)|*.*')}`);
    lines.push('$d.CheckFileExists = $true');
    lines.push(
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
    );
  }
  return lines.join('; ');
}
