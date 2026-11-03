/**
 * Native picker plumbing: where a dialog starts, what gets remembered, and how
 * the two backends (Electron remote dialog, PowerShell fallback) are chosen.
 *
 * Everything is injected — no dialog is ever shown and no process is spawned,
 * which is what lets this run under vitest on any platform.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetSystemDialogForTest,
  __setDialogForTest,
  __setExecForTest,
  __setGlobalForTest,
  __setPlatformForTest,
  __setRequireForTest,
  buildPsScript,
  hasSystemPicker,
  pickExternalPath,
  rememberedDirFor,
  resolveDialog,
  startDirFor,
  type DialogLike,
  type ExecFileLike,
} from '../src/features/systemDialog';

afterEach(() => {
  __resetSystemDialogForTest();
});

/** A dialog that answers with a fixed result (or throws). */
function fakeDialog(behavior: { filePaths?: string[]; canceled?: boolean; throw?: boolean }): DialogLike {
  return {
    showOpenDialog(...args: unknown[]) {
      if (behavior.throw) throw new Error('remote is gone');
      void args;
      return Promise.resolve({ canceled: behavior.canceled ?? false, filePaths: behavior.filePaths ?? [] });
    },
  };
}

/** A child_process that records its argv and answers with `stdout`. */
function fakeExec(stdout: string): { exec: ExecFileLike; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFileLike = {
    execFile(file, args, _opts, cb) {
      calls.push([file, ...args]);
      cb(null, stdout);
    },
  };
  return { exec, calls };
}

describe('startDirFor', () => {
  it('a directory in the field opens at itself, a file at its parent', () => {
    expect(startDirFor('D:\\notes\\inbox', true, 'E:\\elsewhere')).toBe('D:\\notes\\inbox');
    expect(startDirFor('D:\\notes\\inbox\\a.md', false, 'E:\\elsewhere')).toBe('D:\\notes\\inbox');
  });

  it('an empty field falls back to the remembered directory', () => {
    expect(startDirFor('', false, 'E:\\elsewhere')).toBe('E:\\elsewhere');
    expect(startDirFor('   ', false, '')).toBe('');
  });

  it('trailing separators never survive (Windows paths and typed slashes alike)', () => {
    expect(startDirFor('D:\\notes\\inbox\\', true, '')).toBe('D:\\notes\\inbox');
    expect(startDirFor('D:/notes/inbox/', true, '')).toBe('D:/notes/inbox');
  });
});

describe('rememberedDirFor', () => {
  it('folder → itself, file → its parent', () => {
    expect(rememberedDirFor('D:\\notes\\inbox', 'folder')).toBe('D:\\notes\\inbox');
    expect(rememberedDirFor('D:\\notes\\inbox\\', 'folder')).toBe('D:\\notes\\inbox');
    expect(rememberedDirFor('D:\\notes\\inbox\\a.md', 'file')).toBe('D:\\notes\\inbox');
  });

  it('a bare name remembers nothing rather than resetting the saved location', () => {
    expect(rememberedDirFor('inbox', 'file')).toBe('');
    expect(rememberedDirFor('', 'folder')).toBe('');
  });
});

describe('resolveDialog', () => {
  it('finds Obsidian’s own window.electron first (remote already patched in)', () => {
    const dlg = fakeDialog({ filePaths: ['D:\\x'] });
    __setGlobalForTest({ electron: { remote: { dialog: dlg } } });
    expect(resolveDialog()).toBe(dlg);
    expect(hasSystemPicker()).toBe(true);
  });

  it('falls back to require("@electron/remote") when the window has nothing', () => {
    const dlg = fakeDialog({ filePaths: ['D:\\x'] });
    __setGlobalForTest({});
    __setRequireForTest((id) => (id === '@electron/remote' ? { dialog: dlg } : undefined));
    expect(resolveDialog()).toBe(dlg);
  });

  it('reports no picker when neither the window nor the loader has one', () => {
    __setGlobalForTest({});
    __setRequireForTest(() => undefined);
    __setPlatformForTest('linux');
    expect(resolveDialog()).toBeNull();
    expect(hasSystemPicker()).toBe(false);
  });
});

describe('pickExternalPath', () => {
  it('returns the chosen path', async () => {
    __setDialogForTest(fakeDialog({ filePaths: ['D:\\notes\\inbox'] }));
    await expect(pickExternalPath({ kind: 'folder', startDir: 'D:\\notes' })).resolves.toBe(
      'D:\\notes\\inbox',
    );
  });

  it('cancel is "" — and does NOT fall through to the PowerShell fallback', async () => {
    const { exec, calls } = fakeExec('D:\\from-ps');
    __setDialogForTest(fakeDialog({ canceled: true }));
    __setExecForTest(exec);
    await expect(pickExternalPath({ kind: 'folder' })).resolves.toBe('');
    expect(calls.length).toBe(0);
  });

  it('an empty result is "" as well', async () => {
    __setDialogForTest(fakeDialog({ filePaths: [] }));
    await expect(pickExternalPath({ kind: 'file' })).resolves.toBe('');
  });

  it('a dead Electron dialog falls back to PowerShell on Windows', async () => {
    const { exec, calls } = fakeExec('D:\\notes\\你好.md\n');
    __setDialogForTest(fakeDialog({ throw: true }));
    __setExecForTest(exec);
    __setPlatformForTest('win32');
    await expect(pickExternalPath({ kind: 'file', title: "it's a test" })).resolves.toBe(
      'D:\\notes\\你好.md',
    );
    expect(calls[0]?.[0]).toBe('powershell.exe');
    // STA is what makes ShowDialog legal; the script carries the escaped title.
    expect(calls[0]).toContain('-STA');
    expect(String(calls[0]?.at(-1))).toContain("it''s a test");
  });

  it('nothing at all → "" (the caller keeps the typed path)', async () => {
    __setDialogForTest(null);
    __setExecForTest(null);
    __setPlatformForTest('win32');
    await expect(pickExternalPath({ kind: 'folder' })).resolves.toBe('');
  });
});

describe('buildPsScript', () => {
  it('opens a folder browser for folders and a file dialog for files', () => {
    expect(buildPsScript({ kind: 'folder' })).toContain('FolderBrowserDialog');
    expect(buildPsScript({ kind: 'file' })).toContain('OpenFileDialog');
  });

  it('starts in startDir and writes UTF-8 (a Chinese path must not come back mojibake)', () => {
    const s = buildPsScript({ kind: 'folder', startDir: 'D:\\笔记' });
    expect(s).toContain("$d.SelectedPath = 'D:\\笔记'");
    expect(s).toContain('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8');
  });
});
