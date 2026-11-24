/**
 * MOBILE_BUILD=full 专用：Node/Electron 内建的最小安全替身。
 *
 * 移动端整包把所有模块都打进 main.js，其中一些模块在**顶层** import 了
 * `electron` / `fs` / `path` 等（桌面专用模块被 bootModule 跳过，但顶层
 * import 在插件加载时就会执行）。没有这个替身，`require("electron")`
 * 会在移动端直接抛错，整个插件加载失败。
 *
 * 这里只保证「导入不炸 + 被调用时给出无害默认值」，不提供真实能力；
 * 依赖这些能力的模块都应标 desktopOnly，由宿主在移动端跳过。
 */

const noop = (..._args: unknown[]): void => undefined;
const empty = (): string => '';
const fakeChild = () => ({
  unref: noop,
  on: noop,
  once: noop,
  off: noop,
  kill: noop,
  stdout: null,
  stderr: null,
  stdin: null,
  pid: 0,
});

export class Buffer {
  constructor(readonly bytes: Uint8Array = new Uint8Array()) {}
  static from(input: string | Uint8Array | ArrayLike<number> = ''): Buffer {
    const bytes =
      typeof input === 'string'
        ? new TextEncoder().encode(input)
        : input instanceof Uint8Array
          ? input
          : new Uint8Array(Array.from(input));
    return new Buffer(bytes);
  }
  toString(): string {
    return new TextDecoder().decode(this.bytes);
  }
}
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export const platform = 'mobile';
export const EOL = '\n';
export const sep = '/';
export const hostname = (): string => 'mobile';
export const type = (): string => 'mobile';
export const freemem = (): number => 0;
export const totalmem = (): number => 0;
export const cpus = (): unknown[] => [];
export const release = (): string => 'mobile';
export const arch = (): string => 'mobile';
export const tmpdir = (): string => '/tmp';
export const existsSync = (): boolean => false;
export const readFileSync = (): string => '';
export const writeFileSync = noop;
export const mkdirSync = noop;
export const rmSync = noop;
export const readdirSync = (): string[] => [];
export const mkdtempSync = (prefix = '/tmp/'): string => `${prefix}mobile`;
export const execFileSync = (): Buffer => Buffer.from('');
export const spawn = fakeChild;
export const execFile = fakeChild;
export const exec = fakeChild;
export const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
export const isDeepStrictEqual = (a: unknown, b: unknown): boolean => a === b;
export class DatabaseSync {
  prepare(): { run: () => void; all: () => unknown[]; get: () => unknown } {
    return { run: noop, all: () => [], get: () => undefined };
  }
  exec(): void {}
  close(): void {}
}
export const join = (...parts: string[]): string => parts.filter(Boolean).join('/');
export const normalize = (p: string): string => p.replace(/\/{2,}/g, '/');
export const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';
export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
export const extname = (p: string): string => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
};
export const parse = (p: string): { root: string; dir: string; base: string; ext: string; name: string } => ({
  root: '/', dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p).replace(/\.[^.]+$/, ''),
});
export const format = (p: { dir?: string; base?: string }): string => (p.dir ? `${p.dir}/${p.base ?? ''}` : (p.base ?? ''));
export const resolve = (...parts: string[]): string => `/${join(...parts).replace(/^\/+/, '')}`;
export const relative = (_from: string, to: string): string => to;
export const fileURLToPath = (url: string): string => url.replace(/^file:\/\//, '');
export const pathToFileURL = (p: string): { href: string } => ({ href: `file://${p}` });
export const createHash = () => ({ update: noop, digest: empty });
export const clipboard = {
  readText: async (): Promise<string> => '',
  writeText: async (..._args: unknown[]): Promise<void> => undefined,
  available: async (): Promise<boolean> => false,
};
export const webUtils = { getPathForFile: (file: { name?: string }): string => file?.name ?? '' };
export const shell = {
  openPath: async (): Promise<string> => '',
  openExternal: async (): Promise<void> => undefined,
  showItemInFolder: noop,
  trashItem: async (): Promise<void> => undefined,
};
export const ipcMain = { on: noop, once: noop, off: noop, handle: noop, removeHandler: noop };
export class EventEmitter {
  on(): this { return this; }
  once(): this { return this; }
  off(): this { return this; }
  emit(): boolean { return false; }
}
export class Readable extends EventEmitter {}
export class Writable extends EventEmitter {}
export class Duplex extends EventEmitter {}
export class PassThrough extends Duplex {}
export class Transform extends Duplex {}
export class StringDecoder {
  write(_buf: Uint8Array): string { return ''; }
  end(): string { return ''; }
}
export const on = noop;
export const once = async (): Promise<unknown[]> => [];
export const pipeline = noop;
export const finished = noop;
export const inspect = (v: unknown): string => String(v);
export const promisify = (fn: unknown): unknown => fn;
export const types = { isPromise: (v: unknown): boolean => !!v && typeof (v as { then?: unknown }).then === 'function' };
export const inflateSync = (v: Uint8Array = new Uint8Array()): Uint8Array => v;
export const inflateRawSync = (v: Uint8Array = new Uint8Array()): Uint8Array => v;
export const gunzipSync = (v: Uint8Array = new Uint8Array()): Uint8Array => v;
export const deflateSync = (v: Uint8Array = new Uint8Array()): Uint8Array => v;
export const statSync = (): { isFile: () => boolean; isDirectory: () => boolean; size: number; mtimeMs: number } => ({ isFile: () => false, isDirectory: () => false, size: 0, mtimeMs: 0 });
export const lstatSync = statSync;
export const openSync = (): number => -1;
export const closeSync = noop;
export const appendFileSync = noop;
export const copyFileSync = noop;
export const renameSync = noop;
export const unlinkSync = noop;
export const symlinkSync = noop;
export const realpathSync = (p: string): string => p;
export type ChildProcess = ReturnType<typeof fakeChild>;
export type SpawnOptions = Record<string, unknown>;
export const lstat = async (): Promise<{ isFile: () => boolean }> => ({ isFile: () => false });
export const open = async (): Promise<{ close: () => Promise<void> }> => ({ close: async () => undefined });
export const realpath = async (p: string): Promise<string> => p;
export const readlink = async (): Promise<string> => '';
export const link = async (): Promise<void> => undefined;
export const symlink = async (): Promise<void> => undefined;
export const watch = (): { close: () => void } => ({ close: noop });
export const promises = {
  lstat,
  open,
  realpath,
  readlink,
  link,
  symlink,
  watch,
  stat: async (): Promise<{ isFile: () => boolean }> => ({ isFile: () => false }),
  readFile: async (): Promise<string> => '',
  writeFile: async (): Promise<void> => undefined,
  mkdir: async (): Promise<void> => undefined,
  rm: async (): Promise<void> => undefined,
  readdir: async (): Promise<string[]> => [],
  access: async (): Promise<void> => undefined,
};

// fs/promises、timers/promises 的命名导入（移动端不会真正调用）
export const readFile = promises.readFile;
export const writeFile = promises.writeFile;
export const mkdir = promises.mkdir;
export const rm = promises.rm;
export const readdir = promises.readdir;
export const access = promises.access;
export const stat = promises.stat;
export const clearTimeout = (id: unknown): void => globalThis.clearTimeout(id as number);
export const clearInterval = (id: unknown): void => globalThis.clearInterval(id as number);
export const setTimeout = (fn: () => void): { unref: () => void } => {
  globalThis.setTimeout(fn, 0);
  return { unref: noop };
};
export const setInterval = (fn: () => void): { unref: () => void } => {
  globalThis.setInterval(fn, 1000);
  return { unref: noop };
};

const api: Record<string, unknown> = {
  platform, EOL, sep, hostname, tmpdir, existsSync, readFileSync, writeFileSync,
  mkdirSync, rmSync, readdirSync, mkdtempSync, execFileSync, spawn, join, resolve,
  relative, fileURLToPath, pathToFileURL, createHash, clipboard, webUtils, shell,
  ipcMain, EventEmitter, Readable, promises,
};
export default api;
