/**
 * Relaxes the mnaoumov libraries' "initialize exactly once" rule so several of
 * their plugins can coexist inside this one host. See `main.ts` for the why.
 *
 * Two things about this file are load-bearing:
 *
 * 1. It is NOT part of the host's tsc program (excluded in tsconfig). Importing
 *    `@mnaoumov/obsidian-lib` at all pulls in its `declare global`, which widens
 *    Obsidian's own `App` interface and makes unrelated modules fail
 *    type-check. `main.ts` reaches it through a require bridge, so the types
 *    stay out of the program while esbuild still bundles the code.
 *
 * 2. It MUST use `import`, not `require`. The package is dual-published, and
 *    `require` resolves to the CJS build — a SEPARATE module instance with its
 *    own singleton. Patching that copy leaves the ESM copy the modules actually
 *    import completely untouched, which is precisely how the first attempt at
 *    this fix silently did nothing while the bundle looked correct.
 */
import { ObsidianLibrary } from "@mnaoumov/obsidian-lib/library";
import { Library } from "@mnaoumov/typescript-lib/library";

interface ReentrantLibrary {
	isInitialized: boolean;
	params: Record<string, unknown>;
	init(params: Record<string, unknown>): void;
}

export function allowReentrantLibraryInit(): void {
	const singletons = [ObsidianLibrary, Library] as unknown as ReentrantLibrary[];
	for (const lib of singletons) {
		if (typeof lib.init !== "function") continue;
		const original = lib.init.bind(lib);
		lib.init = (params: Record<string, unknown>): void => {
			if (!lib.isInitialized) {
				original(params);
				return;
			}
			// Already initialized by a sibling module: adopt its own cosmetic
			// config (a CSS class scope and debug namespaces) instead of
			// refusing to load.
			lib.params = { ...params };
		};
	}
}
