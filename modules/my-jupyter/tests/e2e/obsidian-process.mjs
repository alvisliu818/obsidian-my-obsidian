/**
 * Test-vault-only Obsidian process control. The user keeps their MAIN vault
 * open while tests run — never kill all Obsidian.exe processes; match only
 * the instances the test harness spawned (they carry our CDP debug port and
 * a dedicated user-data-dir).
 *
 * Obsidian is single-instance per user-data-dir: launching with a dedicated
 * --user-data-dir (whose vault registry only knows the test vault) yields a
 * fully separate instance that cannot interact with the user's main one.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const TEST_VAULT = 'E:\\HOME\\Local\\logseq-e2e-vault';
export const TEST_VAULT_URI = 'obsidian://open?path=' + encodeURI(TEST_VAULT);
/** Sibling of the vault (never INSIDE it — the profile must not be indexed). */
export const TEST_PROFILE = 'E:\\HOME\\Local\\logseq-e2e-obsidian-profile';

/** All our test instances launch with `--remote-debugging-port=9xxx`. */
const PORT_MATCH = 'remote-debugging-port=9';

/**
 * Ensure the dedicated profile exists and knows exactly one vault: the test
 * vault, marked open — so a launch with this profile lands directly in it.
 */
export function prepareTestProfile() {
  if (!existsSync(TEST_VAULT)) throw new Error('test vault missing: ' + TEST_VAULT);
  mkdirSync(TEST_PROFILE, { recursive: true });
  // Reset the workspace: without this, every probe run restores ALL leaves
  // from previous runs (they accumulate across sessions and break the
  // leaf-by-file lookups). Obsidian keeps per-vault workspace state in the
  // VAULT's .obsidian/ — clear it there (the profile copy is not the source).
  for (const dir of [TEST_PROFILE, join(TEST_VAULT, '.obsidian')]) {
    for (const f of ['workspace.json', 'workspace.json.bak']) {
      try { rmSync(join(dir, f)); } catch {}
    }
  }
  writeFileSync(
    join(TEST_PROFILE, 'obsidian.json'),
    JSON.stringify({ vaults: { e2e0000000000000: { path: TEST_VAULT, ts: Date.now(), open: true } } }),
  );
}

/** PIDs of Obsidian.exe processes launched by the test harness. */
function testInstancePids() {
  const ps =
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
    "Where-Object { $_.Name -eq 'Obsidian.exe' -and $_.CommandLine -match '" +
    PORT_MATCH +
    "' } | ForEach-Object { $_.ProcessId }\"";
  try {
    return execSync(ps, { stdio: 'pipe', timeout: 30_000 })
      .toString()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l));
  } catch {
    return [];
  }
}

/** Kill ONLY the test-vault Obsidian instances (tree-kill per PID), then wait
 * for full exit: a still-dying instance holds the profile's Electron
 * single-instance lock, and the NEXT spawn silently exits against it. */
export function killTestVaultObsidian() {
  for (const pid of testInstancePids()) {
    try {
      execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && testInstancePids().length > 0) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    } catch {
      /* no Atomics.wait — proceed unslept */
    }
  }
}

/** Spawn args for a test-vault instance: dedicated profile + CDP + vault. */

/** Spawn args for a test-vault instance: dedicated profile + CDP + vault. */
export function testSpawnArgs(port) {
  prepareTestProfile();
  return ['--user-data-dir=' + TEST_PROFILE, '--remote-debugging-port=' + port, TEST_VAULT_URI];
}

// Probes import TEST_PROFILE and spawn themselves — make sure the profile
// registry exists by the time they do.
prepareTestProfile();
