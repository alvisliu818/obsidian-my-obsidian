/**
 * Pure helpers for the backup system (no obsidian imports — unit-tested under
 * vitest in plain Node). The obsidian-aware manager lives in backup.ts.
 */

/** Vault-relative backup dir. */
export const BACKUP_DIR = '.logseq-editor/backups';
/** Backups kept per file (most recent N, older pruned). */
export const BACKUPS_PER_FILE = 10;

/** Sanitize a vault path into a flat backup filename prefix: `a/b.md` → `a--b.md`. */
export function backupPrefix(path: string): string {
  return path.replace(/[\/\\]/g, '--');
}

/** Backup filename for a path at a given ms timestamp: `a--b.md-153045.md`. */
export function backupFileName(path: string, ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const t = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${backupPrefix(path)}-${t}.md`;
}

/** Extract the original vault path back out of a backup filename; '' when unknown. */
export function originalPathOf(fileName: string): string {
  const m = /^(.*)-\d{6}\.md$/.exec(fileName);
  return m ? m[1].replace(/--/g, '/') : '';
}

/**
 * Keep only the newest `keep` backups per original file.
 * Input entries: [fileName, mtimeMs]. Returns the names to DELETE (oldest first).
 * Foreign files (not matching the backup naming scheme) are never touched.
 */
export function prunePlan(
  entries: Array<{ name: string; mtime: number }>,
  keep = BACKUPS_PER_FILE,
): string[] {
  const byFile = new Map<string, Array<{ name: string; mtime: number }>>();
  for (const e of entries) {
    const orig = originalPathOf(e.name);
    if (!orig) continue; // foreign file — never touch it
    const list = byFile.get(orig) ?? [];
    list.push(e);
    byFile.set(orig, list);
  }
  const doomed: string[] = [];
  for (const list of byFile.values()) {
    list.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const e of list.slice(0, Math.max(0, list.length - keep))) doomed.push(e.name);
  }
  return doomed;
}
