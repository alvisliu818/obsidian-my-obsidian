/**
 * @file
 *
 * Re-writes a file that Obsidian on the Android emulator wrote as EMPTY, so the suites test this plugin rather
 * than the emulator's storage.
 *
 * About one `vault.create` in a hundred on the emulator leaves a 0-byte file behind, with this plugin disabled
 * as much as enabled (measured 2026-10-17: 4 of 480 writes with the plugin disabled, 2 of 160 with it enabled).
 * The loss is real and it stays: `adapter.stat` still reads 0 bytes 1.4 s later, and asking the adapter to
 * reconcile the file changes nothing. Obsidian registers the file from that stat and indexes the empty
 * content, firing `changed` within milliseconds, and no later event makes it look again. So a note that should
 * link somewhere never appears in `getBacklinksForFile`, and a canvas never reaches the canvas index.
 *
 * A run creates about a hundred files, so about one wait per run times out on an index precondition, in a
 * different suite each time, before any of this plugin's code has run. Raising those waits cannot help: the
 * content never arrives. Before this guard the Android leg failed 5 of 8 instrumented runs, and every failure
 * matched exactly one note or canvas indexed at size 0.
 *
 * The guard wraps the adapter's `write` and `writeBinary`. When the file on disk is EMPTY although the data was
 * not, it writes the same data again. The adapter then sees the size change and reports a modification, and
 * Obsidian re-indexes the file. It acts only on that one shape: a size that merely differs could be a later
 * write to the same path that landed in between, and writing the old data over it would corrupt the file. It
 * runs before every file's suites but installs itself once per Obsidian instance, and each file reports any
 * re-write it made on stderr, so a run never hides that it needed one.
 *
 * Android only: the desktop projects never lose a write, and wrapping their adapter would change what they
 * measure for nothing.
 */

import { evalInObsidian } from 'obsidian-integration-testing';
import {
  afterAll,
  beforeAll
} from 'vitest';

interface WriteLossGuardState {
  rewrites: string[];
}

interface WriteLossGuardWindow {
  __androidWriteLossGuard?: WriteLossGuardState;
}

beforeAll(async () => {
  await evalInObsidian({
    callback({ app }): void {
      const guardWindow = window as WriteLossGuardWindow;
      if (guardWindow.__androidWriteLossGuard) {
        return;
      }

      const state: WriteLossGuardState = { rewrites: [] };
      guardWindow.__androidWriteLossGuard = state;

      const adapter = app.vault.adapter;
      const originalWrite = adapter.write.bind(adapter);
      const originalWriteBinary = adapter.writeBinary.bind(adapter);
      // One rewrite has always been enough; the second is there so a repeat loss is reported, not looped on.
      const MAX_REWRITES = 2;

      /**
       * Writes the data again while the file on disk is empty although the data is not.
       *
       * @param path - The path that was written.
       * @param byteLength - How many bytes were written.
       * @param rewrite - Writes the same data to the same path again.
       */
      async function rewriteIfLost(path: string, byteLength: number, rewrite: () => Promise<void>): Promise<void> {
        if (byteLength === 0) {
          return;
        }

        for (let attempt = 1; attempt <= MAX_REWRITES; attempt++) {
          const stat = await adapter.stat(path);
          if (stat?.size !== 0) {
            return;
          }

          state.rewrites.push(`${path} (${String(byteLength)} bytes, attempt ${String(attempt)})`);
          await rewrite();
        }
      }

      adapter.write = async (path, data, options): Promise<void> => {
        await originalWrite(path, data, options);
        await rewriteIfLost(path, new TextEncoder().encode(data).byteLength, () => originalWrite(path, data, options));
      };

      adapter.writeBinary = async (path, data, options): Promise<void> => {
        await originalWriteBinary(path, data, options);
        await rewriteIfLost(path, data.byteLength, () => originalWriteBinary(path, data, options));
      };
    }
  });
});

afterAll(async () => {
  const rewrites = await evalInObsidian({
    callback(): string[] {
      const state = (window as WriteLossGuardWindow).__androidWriteLossGuard;
      const taken = state?.rewrites ?? [];
      if (state) {
        state.rewrites = [];
      }

      return taken;
    }
  });

  if (rewrites.length > 0) {
    console.warn(`[android-write-loss-guard] Re-wrote ${String(rewrites.length)} file(s) the emulator wrote empty: ${rewrites.join('; ')}`);
  }
});
