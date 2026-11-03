/**
 * Write-safety layer — obsidian-aware manager (pure helpers live in
 * backupPure.ts, unit-tested without obsidian).
 *
 * CRITICAL IMPLEMENTATION NOTE: Obsidian's vault API (getAbstractFileByPath,
 * vault.create, TFolder.children …) does NOT index dot-prefixed folders like
 * `.logseq-editor/`. Every vault-API call against that path returns null, so
 * this manager deliberately uses the low-level `vault.adapter` for ALL backup
 * storage. Backup entries are described by a plain metadata object instead of
 * TFile, and vault-object reads always go through vault.read(TFile) which is
 * indexed correctly for normal files.
 */

import { Notice, TFile, normalizePath } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { logOp } from '../features/logger';
import {
  BACKUP_DIR,
  backupFileName,
  backupPrefix,
  originalPathOf,
  prunePlan,
} from './backupPure';

export { BACKUP_DIR, BACKUPS_PER_FILE, backupFileName, backupPrefix, originalPathOf, prunePlan } from './backupPure';

/** Lightweight backup entry (adapter-based; TFile is unavailable for dot-folders). */
export interface BackupEntry {
  /** Backup file name inside the backups dir. */
  name: string;
  /** Epoch ms of the backup. */
  mtime: number;
  /** Backup size in bytes. */
  size: number;
  /** Original vault path recovered from the encoded name. */
  originalPath: string;
  /** Full adapter path. */
  path: string;
}

export class BackupManager {
  constructor(private plugin: LogseqEditorPlugin) {}

  private get adapter() {
    return this.plugin.app.vault.adapter;
  }

  /** Ensure `.logseq-editor/backups/` exists. adapter.mkdir THROWS when the
   * folder already exists (it is not idempotent!), so probe with exists first. */
  async ensureDir(): Promise<boolean> {
    try {
      for (const dir of ['.logseq-editor', BACKUP_DIR]) {
        const p = normalizePath(dir);
        if (!(await this.adapter.exists(p))) {
          await this.adapter.mkdir(p);
        }
      }
      return true;
    } catch (e) {
      logOp(this.plugin, 'backup.dir', BACKUP_DIR, 'error', String(e));
      return false;
    }
  }

  /**
   * Copy the CURRENT content of `file` into a backup file (before a write).
   * Returns the backup path, or '' when the backup could not be made
   * (caller proceeds anyway — edits must not be blocked by a backup hiccup —
   * but the failure is always on record).
   */
  async backupBefore(file: TFile): Promise<string> {
    if (this.plugin.settings.backupsEnabled === false) return '';
    if (!(await this.ensureDir())) return '';
    try {
      const data = await this.plugin.app.vault.read(file);
      const base = backupFileName(file.path, Date.now());
      let name = base;
      let n = 1;
      // Same-second collision: probe the adapter (vault API can't see this dir).
      while (await this.adapter.exists(normalizePath(`${BACKUP_DIR}/${name}`))) {
        name = base.replace(/\.md$/, `-${n++}.md`);
      }
      const bp = normalizePath(`${BACKUP_DIR}/${name}`);
      await this.adapter.write(bp, data);
      logOp(this.plugin, 'backup.create', file.path, 'ok', `→ ${bp}`);
      void this.pruneFor(file.path);
      return bp;
    } catch (e) {
      logOp(this.plugin, 'backup.create', file.path, 'error', String(e));
      new Notice(`Backup failed (write continues): ${file.path}`, 4000);
      return '';
    }
  }

  /** Delete surplus backups for one original file (best effort). */
  private async pruneFor(path: string): Promise<void> {
    try {
      const prefix = backupPrefix(path);
      const entries = await this.listAllEntries();
      const mine = entries.filter((e) => e.name.startsWith(prefix));
      const doomed = prunePlan(mine.map((e) => ({ name: e.name, mtime: e.mtime })));
      for (const name of doomed) {
        await this.adapter.remove(normalizePath(`${BACKUP_DIR}/${name}`));
        logOp(this.plugin, 'backup.prune', path, 'ok', name);
      }
    } catch (e) {
      logOp(this.plugin, 'backup.prune', path, 'error', String(e));
    }
  }

  /** List ALL backups (adapter listing; the vault API can't see dot-folders). */
  async listAllEntries(): Promise<BackupEntry[]> {
    await this.ensureDir();
    const out: BackupEntry[] = [];
    try {
      const listing = await this.adapter.list(normalizePath(BACKUP_DIR));
      for (const f of listing.files) {
        const name = f.split('/').pop() ?? f;
        const orig = originalPathOf(name);
        if (!orig) continue; // foreign file — skip
        try {
          const stat = await this.adapter.stat(normalizePath(`${BACKUP_DIR}/${name}`));
          if (stat) out.push({ name, mtime: stat.mtime, size: stat.size, originalPath: orig, path: f });
        } catch {
          /* file vanished mid-listing */
        }
      }
    } catch {
      /* dir missing */
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** Backup entries for one original path, newest first. */
  async listBackups(path: string): Promise<BackupEntry[]> {
    const prefix = backupPrefix(path);
    return (await this.listAllEntries()).filter((e) => e.name.startsWith(prefix));
  }

  /** Read one backup's content by name. */
  async readBackup(name: string): Promise<string> {
    return this.adapter.read(normalizePath(`${BACKUP_DIR}/${name}`));
  }

  /** Restore: backs up the CURRENT content first, then overwrites with the backup. */
  async restore(entry: BackupEntry): Promise<boolean> {
    const target = this.plugin.app.vault.getAbstractFileByPath(entry.originalPath);
    if (!(target instanceof TFile)) {
      new Notice(`Original file no longer exists: ${entry.originalPath}`);
      return false;
    }
    await this.backupBefore(target); // even restores are recoverable
    const data = await this.readBackup(entry.name);
    const ok = await this.safeProcess(target, () => data, 'backup.restore');
    if (ok) new Notice(`Restored ${entry.originalPath} from ${entry.name}`);
    return ok;
  }

  /**
   * THE write path for whole-file transforms: back up → transform inside
   * vault.process (throws before write on transform error) → log result.
   * `op` names the operation in the log. Returns true on success.
   */
  async safeProcess(file: TFile, transform: (data: string) => string, op: string): Promise<boolean> {
    await this.backupBefore(file);
    try {
      await this.plugin.app.vault.process(file, (data) => transform(data));
      logOp(this.plugin, op, file.path, 'ok');
      return true;
    } catch (e) {
      logOp(this.plugin, op, file.path, 'error', String(e));
      new Notice(`${op} failed on ${file.path}: ${String(e)}`, 6000);
      return false;
    }
  }

  /**
   * Move-to-file append: back up the target, then append via vault.process.
   * Kept here so all md writes funnel through one guarded API.
   */
  async safeAppend(target: TFile, md: string, op: string): Promise<boolean> {
    await this.backupBefore(target);
    try {
      await this.plugin.app.vault.process(
        target,
        (data) => (data.trimEnd() ? data.trimEnd() + '\n' : '') + md + '\n',
      );
      logOp(this.plugin, op, target.path, 'ok');
      return true;
    } catch (e) {
      logOp(this.plugin, op, target.path, 'error', String(e));
      new Notice(`${op} failed on ${target.path}: ${String(e)}`, 6000);
      return false;
    }
  }

  /**
   * Once-per-session pre-write snapshot: the first time a file is about to be
   * modified through the block editor in this plugin session, back up the
   * on-disk original. Covers e.g. a serialization bug rewriting a whole file:
   * the pre-session state is always restorable, without an IO storm on every
   * debounced keystroke save.
   */
  async ensureSessionBackup(file: TFile): Promise<void> {
    if (this.sessionBackups.has(file.path)) return;
    this.sessionBackups.add(file.path);
    await this.backupBefore(file);
  }

  private sessionBackups = new Set<string>();
}
