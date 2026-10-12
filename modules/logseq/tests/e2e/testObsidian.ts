/**
 * Test-vault-only Obsidian process control (TS mirror of obsidian-process.mjs
 * for the playwright spec files). The user keeps their MAIN vault open while
 * tests run — never kill all Obsidian.exe processes; match only the instances
 * the test harness spawned (they carry our CDP debug port and a dedicated
 * user-data-dir, so they cannot interact with the main-vault instance).
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = 'E:\\HOME\\Code\\obsidian\\obsidian-logseq';
export const TEST_VAULT = 'E:\\HOME\\Local\\logseq-e2e-vault';
export const EDGE_VAULT = join(REPO, 'tests', 'fixtures', 'edge-vault');
export const TEST_PROFILE = 'E:\\HOME\\Local\\logseq-e2e-obsidian-profile';

/** All our test instances launch with `--remote-debugging-port=92xx`. */
const PORT_MATCH = 'remote-debugging-port=92';

/** Ensure the dedicated profile knows both test vaults (never the main one). */
function prepareTestProfile(): void {
  mkdirSync(TEST_PROFILE, { recursive: true });
  for (const f of ['workspace.json', 'workspace.json.bak']) {
    try { rmSync(join(TEST_PROFILE, f)); } catch {}
  }
  writeFileSync(
    join(TEST_PROFILE, 'obsidian.json'),
    JSON.stringify({
      vaults: {
        e2e0000000000000: { path: TEST_VAULT, ts: Date.now(), open: true },
        e2e1000000000000: { path: EDGE_VAULT, ts: Date.now() - 1, open: false },
      },
    }),
  );
}

/** PIDs of Obsidian.exe processes launched by the test harness. */
function testInstancePids(): string[] {
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

/** Blocking sleep (sync — the launch helpers are synchronous). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* fall back: rare platforms without Atomics.wait — proceed unslept */
  }
}

/**
 * Kill ONLY the Obsidian instances the test harness spawned (they carry our
 * CDP debug port), then wait until the PIDs are really gone — the next spawn
 * would otherwise hit the profile's single-instance lock and silently exit.
 */
export function killTestVaultObsidian(): void {
  for (const pid of testInstancePids()) {
    try {
      execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && testInstancePids().length > 0) sleepSync(500);
}

/**
 * Spawn args for a test instance: dedicated profile + CDP port + (optionally)
 * the vault URI to open. With no URI the profile's `open: true` vault (the
 * test vault) opens.
 */
export function testSpawnArgs(port: string, vaultUri?: string): string[] {
  prepareTestProfile();
  const args = ['--user-data-dir=' + TEST_PROFILE, '--remote-debugging-port=' + port];
  if (vaultUri) args.push(vaultUri);
  return args;
}
