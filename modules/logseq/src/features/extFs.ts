/**
 * Access to files OUTSIDE the vault, over Node's fs.
 *
 * Why not `vault.adapter`: measured, it resolves every path against the vault
 * root, so an absolute path becomes `<vault>\E:\somewhere\...` and fails with
 * ENOENT (see `notes/mounts.md`). Node fs is the only way out.
 *
 * `fs` / `path` / `child_process` are loaded LAZILY through `require` rather
 * than a top-level import. Two reasons:
 *   1. A unit test can import this module and use the pure helpers without a
 *      module-resolution failure in a non-Node bundler target.
 *   2. esbuild keeps node builtins external, so the import must stay lazy to
 *      avoid touching them during plugin load.
 *
 * Windows junctions (`mklink /J`) are how a mount can also be exposed INSIDE
 * the vault — that path then behaves exactly like a vault file, which is the
 * only way to get full take-over/block-ref parity. Junction creation is
 * attempted but not required: `mountType` lets the user choose per mount.
 */

import type { ScanEntry } from './mountFilter';

/** Node module surface we use, kept structural so tests can fake it. */
export interface NodeFsLike {
  readdirSync(p: string, opts: { withFileTypes: true }): DirentLike[];
  statSync(p: string): StatLike;
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string, enc: 'utf8'): void;
  lstatSync(p: string): StatLike;
  realpathSync(p: string): string;
  /** Optional: only the fs-module methods the tree-file ops need. Tests that
   *  never exercise them can omit these (production Node fs always has them). */
  renameSync?(from: string, to: string): void;
  mkdirSync?(p: string, opts: { recursive: true }): void;
  unlinkSync?(p: string): void;
  rmSync?(p: string, opts: { recursive: true; force: true }): void;
  /** Binary-safe single-file copy (Node fs.copyFileSync)。文本接口会把
   *  二进制文件写坏，复制必须走这个。 */
  copyFileSync?(from: string, to: string): void;
}

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface StatLike {
  size?: number;
  mtimeMs?: number;
  isDirectory?(): boolean;
}

type Requirer = (id: string) => unknown;

/** Injection points for tests; production uses Node's real modules. */
const hooks: { fs?: NodeFsLike; path?: unknown; cp?: unknown; require?: Requirer } = {};

export function __setFsForTest(fs: NodeFsLike | null): void {
  hooks.fs = fs ?? undefined;
}

/** Default `require`. Obsidian desktop exposes it on window (nodeIntegration). */
function nodeRequire(id: string): unknown {
  if (hooks.require) return hooks.require(id);
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // esbuild in the plugin bundle leaves `require` intact for externals.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

function fsMod(): NodeFsLike {
  if (hooks.fs) return hooks.fs;
  return nodeRequire('fs') as NodeFsLike;
}

function pathMod(): { join(...p: string[]): string; basename(p: string, ext?: string): string; extname(p: string): string } {
  return (hooks.path ?? nodeRequire('path')) as never;
}

/** Lowercased extension without the dot ('' when there is none). */
export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Join a mount root with a relative path into a native path. */
export function joinAbs(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

/**
 * Validate a user-typed file/folder name for the tree-file ops.
 *
 * Returns '' when the name is usable, otherwise a user-facing reason. Only
 * characters that are illegal ON WINDOWS are rejected (the vault runs on
 * desktop): the name is also trimmed of trailing dots/spaces because Windows
 * silently strips those, which would make the created name differ from the
 * typed one. A name that is only dots is invalid for the same reason.
 */
export function validateEntryName(raw: string): string {
  const name = raw.trim();
  if (!name) return '名称不能为空。';
  if (name === '.' || name === '..') return '名称不能是 . 或 ..';
  if (/[\\/:*?"<>|]/.test(name)) return '名称不能包含 \\ / : * ? " < > |';
  if (name.length > 255) return '名称过长（最多 255 个字符）。';
  if (/[. ]$/.test(name)) return '名称不能以点或空格结尾（Windows 会静默去掉）。';
  return '';
}

export type FsOpResult = { ok: boolean; error?: string };

/** 复制操作的结果：带上最终落地的路径（撞名时会加序号）。 */
export type CopyOpResult = FsOpResult & { target?: string; count?: number };

/** 一次复制允许的文件数上限（同步 IO，大目录会占一会儿 UI 线程）。 */
const COPY_FILE_LIMIT = 20000;

/** Ensure a directory exists (recursive). */
export function ensureDirX(abs: string): FsOpResult {
  try {
    const fs = fsMod();
    if (!fs.mkdirSync) return { ok: false, error: '当前环境不支持创建目录。' };
    fs.mkdirSync(abs, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Create an empty file; fails when the target already exists. */
export function createEmptyFile(abs: string): FsOpResult {
  try {
    const fs = fsMod();
    if (!fs.writeFileSync) return { ok: false, error: '当前环境不支持写文件。' };
    if (fs.existsSync(abs)) return { ok: false, error: '同名文件已存在。' };
    fs.writeFileSync(abs, '', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * 同目录改名的目标路径（renameEntry 用它；调用方在改名成功后也要用它更新
 * 自己记的 abs）。分隔符取自路径本身（Windows 两种都认），无分隔符说明是
 * 裸名（不可能出现在挂载树，但守住边界）——此时返回裸名本身。
 */
export function renameTarget(abs: string, newName: string): string {
  const idx = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
  if (idx < 0) return newName;
  return abs.slice(0, idx + 1) + newName;
}

/**
 * Rename a file or folder within its parent (same directory, name change only).
 * Refuses to clobber an existing target — Windows renameSync would overwrite a
 * FILE silently, and that is never what a rename means.
 */
export function renameEntry(abs: string, newName: string): FsOpResult {
  const bad = validateEntryName(newName);
  if (bad) return { ok: false, error: bad };
  const target = renameTarget(abs, newName);
  try {
    const fs = fsMod();
    if (!fs.renameSync) return { ok: false, error: '当前环境不支持重命名。' };
    if (fs.existsSync(target)) return { ok: false, error: '同名文件或文件夹已存在。' };
    fs.renameSync(abs, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * 目录里一个不撞名的副本名：`a.md` → `a 2.md` → `a 3.md`…
 * （Windows 资源管理器 / Obsidian 的惯例；纯函数，好测。）
 */
export function uniqueCopyName(dirAbs: string, name: string): string {
  const fs = fsMod();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (!fs.existsSync(joinAbs(dirAbs, name))) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} ${i}${ext}`;
    if (!fs.existsSync(joinAbs(dirAbs, candidate))) return candidate;
  }
  return `${stem} ${Date.now()}${ext}`;
}

/**
 * 复制一个文件/文件夹到 destDir（文件夹递归，二进制安全）。
 *
 * 撞名自动加序号（uniqueCopyName）；拒绝把目录复制进自己的子树（那会无限
 * 递归）。复制过程中同步 IO——大目录会占一会儿 UI 线程，故有文件数上限。
 */
export function copyEntry(abs: string, destDir: string): CopyOpResult {
  try {
    const fs = fsMod();
    if (!fs.existsSync(abs)) return { ok: false, error: '源不存在。' };
    if (!fs.existsSync(destDir)) return { ok: false, error: '目标文件夹不存在。' };
    const isDir = fs.statSync(abs).isDirectory?.() === true;
    const srcNorm = abs.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const destNorm = destDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (isDir && destNorm.startsWith(srcNorm + '/')) {
      return { ok: false, error: '不能把文件夹复制到它自己里面。' };
    }
    const name = abs.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'copy';
    const finalName = uniqueCopyName(destDir, name);
    const target = joinAbs(destDir, finalName);
    const ref = { n: 0 };
    copyTree(abs, target, isDir, ref);
    return { ok: true, target, count: ref.n };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function copyTree(src: string, dest: string, isDir: boolean, ref: { n: number }): void {
  const fs = fsMod();
  if (!isDir) {
    if (!fs.copyFileSync) throw new Error('当前环境不支持复制文件。');
    fs.copyFileSync(src, dest);
    ref.n += 1;
    if (ref.n > COPY_FILE_LIMIT) throw new Error(`一次最多复制 ${COPY_FILE_LIMIT} 个文件。`);
    return;
  }
  if (!fs.mkdirSync) throw new Error('当前环境不支持创建目录。');
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    copyTree(joinAbs(src, ent.name), joinAbs(dest, ent.name), ent.isDirectory(), ref);
  }
}

/**
 * Delete a file or folder, preferring the OS trash when available.
 *
 * Uses Node's `trash`-like electron.shell.trashItem — Electron exposes it on
 * the loaded `electron` module (measured: `require('electron')` in the plugin
 * returns the full API, `shell.trashItem` included). When it fails (Linux
 * without a portal, for instance), the caller decides whether to offer a
 * permanent delete fallback; this helper never deletes without being told to.
 */
export function trashEntry(abs: string): Promise<FsOpResult> {
  let shell: { trashItem?(p: string): Promise<void> } | undefined;
  try {
    shell = nodeRequire('electron') as { trashItem?(p: string): Promise<void> } | undefined;
  } catch {
    shell = undefined;
  }
  if (!shell?.trashItem) return Promise.resolve({ ok: false, error: '此环境没有系统回收站。' });
  return shell
    .trashItem(abs)
    .then(() => ({ ok: true }))
    .catch((e: unknown): FsOpResult => ({ ok: false, error: errorMessage(e) }));
}

/**
 * PERMANENT delete — bypasses the trash. Only ever call this from a confirm
 * dialog that says so, and only after `trashEntry` has failed (no recycle bin
 * on this system), so the destructive path is always the second choice.
 */
export function deletePermanent(abs: string, isDir: boolean): FsOpResult {
  try {
    const fs = fsMod();
    if (isDir) {
      if (!fs.rmSync) return { ok: false, error: '当前环境不支持删除目录。' };
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      if (!fs.unlinkSync) return { ok: false, error: '当前环境不支持删除文件。' };
      fs.unlinkSync(abs);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg;
}

/**
 * Scan a directory tree outside the vault, applying the filter WHILE walking.
 *
 * - `shouldEnterDir(rel)` decides whether to descend (prunes whole subtrees).
 * - `keepFile(rel, name)` decides whether a file becomes an entry.
 *
 * Returns `{ entries, truncated }` — truncated means a limit was hit and the
 * tree is incomplete, which the caller must surface rather than hide.
 *
 * **No limit by default**: the virtual document tree must show a mounted
 * folder whole, so it is never silently cut short. The old 4000-entry / 12-level
 * caps existed to stop `mount /` from hanging the panel; that job is done now
 * by lazy loading (each folder is read when it is expanded), which scales to
 * any size. `limit`/`depth` stay available for callers that really do want a
 * bounded scan — only those can ever see `truncated`. Symlinks are not followed
 * unless asked, so a cyclic link cannot walk the tree forever.
 */
export function scanExternal(
  root: string,
  opts: {
    shouldEnterDir: (rel: string) => boolean;
    keepFile: (rel: string, name: string) => boolean;
    limit?: number;
    depth?: number;
    followSymlinks?: boolean;
  },
): { entries: ScanEntry[]; truncated: boolean } {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const follow = opts.followSymlinks ?? false;
  const entries: ScanEntry[] = [];
  let truncated = false;

  const visit = (dirAbs: string, dirRel: string, depth: number): void => {
    if (truncated) return;
    if (depth > maxDepth) return;
    let items: DirentLike[];
    try {
      items = fsMod().readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, or it vanished mid-scan) — skip it
      // rather than failing the whole mount.
      return;
    }
    for (const it of items) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const rel = dirRel ? `${dirRel}/${it.name}` : it.name;
      const abs = joinAbs(root, rel);
      let isDir = it.isDirectory();
      if (!isDir && it.isSymbolicLink()) {
        // A link is followed only when asked, and only after proving it points
        // at a directory — otherwise a file link would be listed as a folder.
        if (follow) {
          try {
            isDir = fsMod().statSync(abs).isDirectory?.() === true;
          } catch {
            continue; // broken link
          }
        } else {
          continue; // do not show links at all by default
        }
      }
      if (isDir) {
        if (!opts.shouldEnterDir(rel)) continue;
        entries.push({ rel, name: it.name, isDir: true, abs });
        visit(abs, rel, depth + 1);
      } else if (it.isFile()) {
        if (!opts.keepFile(rel, it.name)) continue;
        let size: number | undefined;
        let mtime: number | undefined;
        try {
          const st = fsMod().statSync(abs);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* stat is best-effort */
        }
        entries.push({ rel, name: it.name, isDir: false, abs, size, mtime });
      }
    }
  };

  try {
    if (!fsMod().existsSync(root)) return { entries, truncated: false };
    if (fsMod().statSync(root).isDirectory?.() !== true) return { entries, truncated: false };
  } catch {
    return { entries, truncated: false };
  }
  visit(root, '', 0);
  return { entries, truncated };
}

/** Read a UTF-8 text file from outside the vault. Throws on failure. */
export function readExternalText(abs: string): string {
  return fsMod().readFileSync(abs, 'utf8');
}

/** Overwrite a text file outside the vault. Throws on failure. */
export function writeExternalText(abs: string, data: string): void {
  fsMod().writeFileSync(abs, data, 'utf8');
}

/** True when the path exists and is a directory. */
export function isDirectory(abs: string): boolean {
  try {
    return fsMod().existsSync(abs) && fsMod().statSync(abs).isDirectory?.() === true;
  } catch {
    return false;
  }
}

/** True when the path exists at all. */
export function exists(abs: string): boolean {
  try {
    return fsMod().existsSync(abs);
  } catch {
    return false;
  }
}

/**
 * How a mount is exposed INSIDE the vault, as a real path.
 *
 * Windows offers three link kinds and only two of them are usable here
 * (measured on this machine):
 *
 * | kind | for | result |
 * |---|---|---|
 * | `mklink /J` junction | directories | works, no privileges needed |
 * | `mklink /H` hard link | files | works, no privileges needed |
 * | `mklink /D` symlink | either | **fails**: "insufficient privilege" |
 *
 * So a file cannot be junctioned, but it CAN be hard-linked — and Obsidian
 * indexes a hard-linked file exactly like a real one (measured: indexed=true,
 * opens in the block editor). The difference that matters: a hard link is a
 * second directory entry for the SAME bytes, so editing the mounted copy edits
 * the original in place. That is the wanted "mount" semantic, but the UI has to
 * say so, because deleting the link in the vault does not touch the original
 * while writing through it does.
 */
export type LinkKind = 'junction' | 'hardlink';

/** Pick the link kind that can represent `targetPath`. */
export function linkKindFor(targetPath: string): LinkKind {
  return isDirectory(targetPath) ? 'junction' : 'hardlink';
}

/** True when something already occupies `linkPath`. */
export function linkPathTaken(linkPath: string): boolean {
  return exists(linkPath);
}

/**
 * Ensure a directory exists. `mklink` does NOT create intermediate folders —
 * measured: linking into a missing `Mounts/` fails with "系统找不到指定的路径"
 * (the system cannot find the path specified), while the same command succeeds
 * once the folder is there. So every link has to make its own home first.
 *
 * `recursive` mirrors `mkdir -p`: existing is success, not an error.
 */
export function ensureDir(abs: string): { ok: boolean; error?: string } {
  if (isDirectory(abs)) return { ok: true };
  const fs = fsMod() as NodeFsLike & { mkdirSync?: (p: string, o?: unknown) => void };
  if (typeof fs.mkdirSync !== 'function') return { ok: true }; // injected fake
  try {
    fs.mkdirSync(abs, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * Expose `targetPath` inside the vault at `linkPath`.
 *
 * Chooses the link kind automatically: junction for a directory, hard link for a
 * file. Refuses rather than clobbering when the destination is occupied — a
 * silent overwrite here would risk a real note.
 */
export function createLink(targetPath: string, linkPath: string): { ok: boolean; error?: string; kind?: LinkKind } {
  if (!exists(targetPath)) return { ok: false, error: '源路径不存在' };
  if (exists(linkPath)) return { ok: false, error: '目标位置已被占用' };
  // The parent must exist before mklink will run at all.
  const sep = linkPath.includes('\\') ? '\\' : '/';
  const parent = linkPath.slice(0, linkPath.lastIndexOf(sep)) || linkPath;
  const mk = ensureDir(parent);
  if (!mk.ok) return { ok: false, error: `无法创建目录 ${parent}：${mk.error}` };
  const kind = linkKindFor(targetPath);
  const r = runMklink(kind, linkPath, targetPath);
  return r.ok ? { ok: true, kind } : r;
}

/**
 * Remove a link created by `createLink`.
 *
 * Directories: `rmdir` on a junction drops the reparse point only, never the
 * target's contents. Files: `del` drops the directory entry; because a hard
 * link shares its bytes with the original, the external file survives.
 */
export function removeLink(linkPath: string): { ok: boolean; error?: string } {
  if (!exists(linkPath)) return { ok: true };
  const cp = hooks.cp ?? nodeRequire('child_process');
  const exec = (cp as { execFileSync: (f: string, a: string[], o: object) => unknown }).execFileSync.bind(cp);
  const isDir = isDirectory(linkPath);
  try {
    exec('cmd.exe', ['/c', isDir ? 'rmdir' : 'del', linkPath], { stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

function runMklink(kind: LinkKind, linkPath: string, targetPath: string): { ok: boolean; error?: string } {
  const cp = hooks.cp ?? nodeRequire('child_process');
  try {
    (cp as { execFileSync: (f: string, a: string[], o: object) => unknown }).execFileSync(
      'cmd.exe',
      ['/c', 'mklink', kind === 'junction' ? '/J' : '/H', linkPath, targetPath],
      { stdio: 'pipe' },
    );
    return { ok: true };
  } catch (e) {
    const msg = (e as { stderr?: Buffer | string; message?: string });
    const stderr = msg?.stderr ? String(msg.stderr) : '';
    return { ok: false, error: (stderr || msg?.message || String(e)).slice(0, 240) };
  }
}

/**
 * The single VISIBLE folder inside the vault that holds every link mount.
 *
 * It must not be dot-prefixed. Measured: links under `.logseq-mounts/` are
 * completely unindexed by Obsidian — `vault.adapter` still reads them, so the
 * link looks fine on disk, but there is no index entry, no metadata cache and
 * no view, i.e. it behaves as if it did not exist. Under a normal folder name
 * the very same link is indexed and opens in the block editor.
 */
export const MOUNT_FOLDER = 'Mounts';

/** Absolute path of the folder that holds the links for one mount. */
export function linkRootFor(vaultBase: string, mountId: string): string {
  const p = pathMod();
  return p.join(vaultBase, MOUNT_FOLDER, mountId);
}

/**
 * Where a single entry should be linked.
 *
 * A folder mount gets its own folder (`Mounts/<id>` → the target). A single
 * FILE is linked directly under `Mounts/`, named after the mount, because
 * hard-linking a file into a per-mount folder would work too but hides the
 * links from each other when several files are mounted one by one.
 */
export function linkTargetFor(vaultBase: string, _mountId: string, linkName: string): string {
  const p = pathMod();
  return p.join(vaultBase, MOUNT_FOLDER, linkName);
}

/** Vault-relative path for a link, used to open it through Obsidian. */
export function linkVaultPath(linkName: string, rel = ''): string {
  return rel ? `${MOUNT_FOLDER}/${linkName}/${rel}` : `${MOUNT_FOLDER}/${linkName}`;
}

/** Make a name safe to use as a path segment. */
export function safeSegment(name: string): string {
  return name.replace(/[<>"|?*:\\/]+/g, '_').replace(/\s+/g, ' ').trim() || 'mount';
}

/**
 * The volume of a Windows path: `D:\x\y` and `D:/x/y` both yield `D:`.
 *
 * Needed because an NTFS hard link — the only way to give a FILE a real path
 * inside the vault — cannot cross volumes (measured: "系统无法将文件复制到不同
 * 的磁盘驱动器"). A directory junction has no such limit, so folders always
 * work and files sometimes cannot.
 */
export function volumeOf(abs: string): string {
  const m = /^([A-Za-z]:)[\\/]?/.exec(abs.trim());
  return m ? m[1] : '';
}

/** True when two paths sit on the same volume (unknown volumes count as same). */
export function sameVolume(a: string, b: string): boolean {
  const va = volumeOf(a).toLowerCase();
  const vb = volumeOf(b).toLowerCase();
  // An unrecognised path (a UNC share, a relative one) must not be reported as
  // cross-volume: the caller would skip a link that would actually have worked.
  if (!va || !vb) return true;
  return va === vb;
}