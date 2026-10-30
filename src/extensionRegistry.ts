/**
 * Defensive wrappers around Obsidian's file-extension → view registry.
 *
 * `ViewRegistry.registerExtensions` is all-or-nothing: if a SINGLE extension
 * in the batch is already claimed — by Obsidian core, by another plugin, or
 * by an earlier registration from this very plugin — the whole call throws.
 * The office module claims `.csv` while its module boots, and the host's
 * code-file list (TEXT_MOUNT_EXTENSIONS minus md/markdown/canvas) contains
 * `.csv` too, so a naive "just register the list" aborts `onload` half-way
 * through: styles.css is never applied, the settings tab and every command
 * registered after the call site never exist, and the vault looks like its
 * entire theme broke. The cause is one console line away from invisible and
 * total when it happens.
 *
 * So every extension registration in this aggregate goes through
 * `registerFreeExtensions`: already-claimed extensions are dropped (first
 * claimant wins — Obsidian core keeps images/pdf/md, our office module keeps
 * `.csv`), the dropped ones are logged together with whoever owns them, and
 * a registry that refuses anyway is logged and swallowed instead of taking
 * the plugin down with it.
 *
 * Callers pass the Plugin (not just the App) so `Plugin.registerExtensions`
 * installs its unregister-on-unload hook. Without that hook a hot reload
 * would find yesterday's claims still sitting in the registry and silently
 * skip them, leaving the view type wired to a dead plugin instance.
 *
 * `app` is deliberately typed `unknown` instead of importing `App` from
 * obsidian: the modules resolve their own copy of the typings (obsidian vs
 * obsidian-typings — two different `App` declarations), and a shared `App`
 * type here would make every caller fail to type-check in one of the two
 * programs. Only the registry probe needs the shape, and that is reached
 * through a local cast.
 */

/** The slice of Obsidian's (internal) view registry this module touches. */
interface ExtensionRegistryProbe {
	isExtensionRegistered?(extension: string): boolean;
	getTypeByExtension?(extension: string): string | undefined;
	registerExtensions?(extensions: string[], viewType: string): void;
	unregisterExtensions?(extensions: string[]): void;
}

/** The slice of `Plugin` needed here; keeps modules free of host types. */
export interface ExtensionRegistrar {
	/** The plugin's `app`; typed `unknown` so any typings copy satisfies it. */
	readonly app: unknown;
	registerExtensions(extensions: string[], viewType: string): void;
	/** Component.register — unload hooks (takeOverExtensions restores owners there). */
	register(cb: () => unknown): void;
}

function probeOf(registrar: ExtensionRegistrar): ExtensionRegistryProbe | null {
	const app = registrar.app as { viewRegistry?: ExtensionRegistryProbe } | null | undefined;
	return app?.viewRegistry ?? null;
}

/** Who currently owns `extension`, for the skip log; null when unknown. */
function ownerOf(registrar: ExtensionRegistrar, extension: string): string | null {
	const probe = probeOf(registrar);
	if (typeof probe?.getTypeByExtension !== "function") return null;
	try {
		return probe.getTypeByExtension(extension) ?? null;
	} catch {
		return null;
	}
}

/** True when no view has claimed `extension` yet. */
export function isExtensionFree(registrar: ExtensionRegistrar, extension: string): boolean {
	const probe = probeOf(registrar);
	if (typeof probe?.isExtensionRegistered !== "function") return true;
	try {
		return !probe.isExtensionRegistered(extension);
	} catch {
		return true; // probe failed → let registerExtensions have the final say
	}
}

/** What one `registerFreeExtensions` call actually did. */
export interface FreeRegistration {
	/** Extensions this call claimed. */
	readonly registered: string[];
	/** Extensions already owned by someone else, left untouched. */
	readonly skipped: string[];
}

/**
 * Claim `extensions` for `viewType`, dropping any that are already taken.
 * Never throws: losing one view is recoverable, a dead `onload` is not.
 *
 * @param registrar - plugin doing the claiming (receives the unload hook)
 * @param extensions - extensions without the leading dot; matched case-insensitively
 * @param viewType - view type the extensions map to
 * @param label - human-readable name of the registration, for the log line
 */
export function registerFreeExtensions(
	registrar: ExtensionRegistrar,
	extensions: readonly string[],
	viewType: string,
	label: string,
): FreeRegistration {
	const wanted = Array.from(
		new Set(extensions.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)),
	);
	const skipped = wanted.filter((e) => !isExtensionFree(registrar, e));
	const registered = wanted.filter((e) => !skipped.includes(e));

	if (skipped.length > 0) {
		const detail = skipped
			.map((e) => {
				const owner = ownerOf(registrar, e);
				return owner ? `${e} (→ ${owner})` : e;
			})
			.join(", ");
		console.info(`[my-obsidian] ${label}: extension(s) already registered, skipped: ${detail}`);
	}

	if (registered.length > 0) {
		try {
			registrar.registerExtensions(registered, viewType);
		} catch (error) {
			// The batch was filtered, so landing here means Obsidian changed
			// under us (or the probe lied). Log and move on — the plugin has
			// to stay alive even if this one view never opens.
			console.error(`[my-obsidian] ${label}: registerExtensions(${viewType}) failed`, error);
		}
	}

	return { registered, skipped };
}

/**
 * Force-claim `extensions` for `viewType`, STEALING any that are already
 * taken — including by Obsidian core.
 *
 * `registerFreeExtensions` is first-claimant-wins, which is right when a
 * takeover is opt-in (images: core previews them fine). It is wrong when the
 * module is the intended default: core claims mp4/webm/ogv/m4v/mov at boot,
 * so a "take over video" flag built on registerFreeExtensions only ever
 * reached the formats core forgot. This function unregisters the current
 * owner(s) first, keeps a backup, and restores them when the plugin unloads
 * (same mechanism media-extended's injectMediaView uses for the same reason).
 *
 * Registration still goes through the Plugin (`registrar.registerExtensions`)
 * so Obsidian's own unregister-on-unload hook stays installed on top of ours.
 *
 * @param registrar - plugin doing the claiming (receives the restore hook)
 * @param extensions - extensions without the leading dot; matched case-insensitively
 * @param viewType - view type the extensions map to
 * @param label - human-readable name of the registration, for the log line
 */
export function takeOverExtensions(
	registrar: ExtensionRegistrar,
	extensions: readonly string[],
	viewType: string,
	label: string,
): FreeRegistration {
	const wanted = Array.from(
		new Set(extensions.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)),
	);
	const probe = probeOf(registrar);
	const claimed = wanted.filter((e) => !isExtensionFree(registrar, e));

	// Back up who owns what BEFORE unregistering, so unload can put it back.
	// Grouped by view type: one registerExtensions call per previous owner.
	const backup = new Map<string, string[]>();
	for (const e of claimed) {
		const owner = ownerOf(registrar, e) ?? "";
		backup.set(owner, [...(backup.get(owner) ?? []), e]);
	}
	// The log line is computed now too: after unregisterExtensions the probe
	// can no longer name the previous owner.
	const detail = claimed
		.map((e) => {
			const prev = [...backup.entries()].find(([, exts]) => exts.includes(e))?.[0];
			return prev ? `${e} (was ${prev})` : e;
		})
		.join(", ");

	if (claimed.length > 0) {
		try {
			probe?.unregisterExtensions?.(claimed);
			console.info(`[my-obsidian] ${label}: took over extension(s): ${detail}`);
		} catch (error) {
			// Unregister failed (Obsidian changed under us): the register below
			// will then throw for the still-claimed ones and be swallowed too,
			// so behavior degrades to "no takeover" instead of a dead onload.
			console.error(`[my-obsidian] ${label}: unregisterExtensions failed`, error);
		}
	}

	try {
		registrar.registerExtensions(wanted, viewType);
	} catch (error) {
		console.error(`[my-obsidian] ${label}: registerExtensions(${viewType}) failed`, error);
	}

	// Restore previous owners on unload: drop ours, re-register theirs. The
	// probe's unregister is used directly (not the Plugin hook — that already
	// removed OUR claims as part of plugin teardown).
	registrar.register(() => {
		const restore = probeOf(registrar);
		try {
			restore?.unregisterExtensions?.(wanted);
		} catch {
			/* our claims may already be gone; restoring below is best-effort */
		}
		for (const [owner, exts] of backup) {
			if (!owner) continue;
			try {
				restore?.registerExtensions?.(exts, owner);
			} catch {
				/* best-effort */
			}
		}
	});

	return { registered: wanted, skipped: [] };
}
