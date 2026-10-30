import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isExtensionFree,
	registerFreeExtensions,
	takeOverExtensions,
	type ExtensionRegistrar,
} from "../extensionRegistry";

/**
 * Mini-mock of Obsidian's ViewRegistry. The detail that matters is the
 * all-or-nothing throw in `registerExtensions`: ONE already-claimed
 * extension aborts the whole batch and registers nothing. That behaviour is
 * what killed the plugin's onload — the office module claimed `.csv` while
 * booting, the host's code-file list contains `.csv`, and the unguarded call
 * threw out of `onload` (no styles.css, no settings tab, no commands).
 */
function fakeRegistrar(initial: Record<string, string> = {}) {
	const typeByExtension: Record<string, string> = { ...initial };
	const calls: Array<{ extensions: string[]; viewType: string }> = [];
	const unregistered: string[][] = [];
	const unloadHooks: Array<() => void> = [];
	const viewRegistry = {
		isExtensionRegistered(extension: string): boolean {
			return Object.prototype.hasOwnProperty.call(typeByExtension, extension);
		},
		getTypeByExtension(extension: string): string | undefined {
			return typeByExtension[extension];
		},
		registerExtensions(extensions: string[], viewType: string): void {
			for (const extension of extensions) {
				if (Object.prototype.hasOwnProperty.call(typeByExtension, extension)) {
					throw new Error(`Attempting to register an existing file extension "${extension}"`);
				}
			}
			for (const extension of extensions) typeByExtension[extension] = viewType;
			calls.push({ extensions: [...extensions], viewType });
		},
		unregisterExtensions(extensions: string[]): void {
			unregistered.push([...extensions]);
			for (const extension of extensions) delete typeByExtension[extension];
		},
	};
	const registrar: ExtensionRegistrar = {
		app: { viewRegistry },
		// Mirrors Plugin.registerExtensions: registry call plus (here omitted)
		// unload cleanup.
		registerExtensions(extensions: string[], viewType: string): void {
			viewRegistry.registerExtensions(extensions, viewType);
		},
		register(cb: () => void): void {
			unloadHooks.push(cb);
		},
	};
	return { registrar, typeByExtension, calls, unregistered, unloadHooks };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isExtensionFree", () => {
	it("reports free and taken extensions", () => {
		const { registrar } = fakeRegistrar({ csv: "logseq-office" });
		expect(isExtensionFree(registrar, "csv")).toBe(false);
		expect(isExtensionFree(registrar, "ts")).toBe(true);
	});

	it("treats a missing probe API as free", () => {
		const registrar: ExtensionRegistrar = { app: {}, registerExtensions: () => {}, register: () => {} };
		expect(isExtensionFree(registrar, "css")).toBe(true);
	});
});

describe("registerFreeExtensions", () => {
	it("claims every free extension and reports them", () => {
		const { registrar, typeByExtension, calls } = fakeRegistrar();
		const result = registerFreeExtensions(registrar, ["ts", "py"], "code-view", "code files");
		expect(result).toEqual({ registered: ["ts", "py"], skipped: [] });
		expect(calls).toEqual([{ extensions: ["ts", "py"], viewType: "code-view" }]);
		expect(typeByExtension).toEqual({ ts: "code-view", py: "code-view" });
	});

	it("skips already-claimed extensions instead of throwing (the regression)", () => {
		// The exact shape of the outage: the office module claimed .csv during
		// module boot, then the host's code-file list — which also contains
		// .csv — hit registerExtensions. Obsidian threw, onload died, and the
		// vault lost every style.
		const { registrar, typeByExtension, calls } = fakeRegistrar({ csv: "logseq-office" });
		const result = registerFreeExtensions(
			registrar,
			["adoc", "csv", "py", "ts"],
			"code-view",
			"code files",
		);
		expect(result.registered).toEqual(["adoc", "py", "ts"]);
		expect(result.skipped).toEqual(["csv"]);
		expect(calls).toHaveLength(1);
		expect(calls[0].extensions).toEqual(["adoc", "py", "ts"]);
		// The previous owner keeps the extension.
		expect(typeByExtension.csv).toBe("logseq-office");
		expect(typeByExtension.ts).toBe("code-view");
	});

	it("makes no call at all when everything is taken", () => {
		const { registrar, calls } = fakeRegistrar({ csv: "logseq-office" });
		const result = registerFreeExtensions(registrar, ["csv"], "code-view", "code files");
		expect(result).toEqual({ registered: [], skipped: ["csv"] });
		expect(calls).toHaveLength(0);
	});

	it("logs skipped extensions with their current owner", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const { registrar } = fakeRegistrar({ csv: "logseq-office", css: "some-other-plugin" });
		registerFreeExtensions(registrar, ["csv", "css", "ts"], "code-view", "code files");
		expect(info).toHaveBeenCalledTimes(1);
		const line = String(info.mock.calls[0][0]);
		expect(line).toContain("code files");
		expect(line).toContain("csv (→ logseq-office)");
		expect(line).toContain("css (→ some-other-plugin)");
	});

	it("swallows a registry that refuses anyway", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const registrar: ExtensionRegistrar = {
			app: {},
			registerExtensions: () => {
				throw new Error('Attempting to register an existing file extension "ts"');
			},
			register: () => {},
		};
		expect(() => registerFreeExtensions(registrar, ["ts"], "code-view", "code files")).not.toThrow();
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("normalises case, trims, dedupes and drops empty entries", () => {
		const { registrar, typeByExtension } = fakeRegistrar();
		const result = registerFreeExtensions(
			registrar,
			[" TS ", "ts", "", "Py", "  "],
			"code-view",
			"code files",
		);
		expect(result.registered).toEqual(["ts", "py"]);
		expect(typeByExtension).toEqual({ ts: "code-view", py: "code-view" });
	});

	it("registers core-claimed extensions as skipped (svg belongs to Obsidian)", () => {
		const { registrar, calls } = fakeRegistrar({ svg: "image" });
		const result = registerFreeExtensions(registrar, ["svg", "vue"], "code-view", "code files");
		expect(result.registered).toEqual(["vue"]);
		expect(result.skipped).toEqual(["svg"]);
		expect(calls[0].extensions).toEqual(["vue"]);
	});
});

describe("takeOverExtensions", () => {
	it("steals claimed extensions from their current owner", () => {
		// The video-player shape: core owns mp4, mkv is free. Both must end up
		// mapped to our view type; only mp4 is unregistered first.
		const { registrar, typeByExtension, unregistered, calls } = fakeRegistrar({ mp4: "video" });
		const result = takeOverExtensions(registrar, ["mp4", "mkv"], "logseq-video", "video player");
		expect(result.registered).toEqual(["mp4", "mkv"]);
		expect(unregistered).toEqual([["mp4"]]);
		expect(calls).toEqual([{ extensions: ["mp4", "mkv"], viewType: "logseq-video" }]);
		expect(typeByExtension.mp4).toBe("logseq-video");
		expect(typeByExtension.mkv).toBe("logseq-video");
	});

	it("logs the takeover with the previous owner's name", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const { registrar } = fakeRegistrar({ mp4: "video", webm: "video" });
		takeOverExtensions(registrar, ["mp4", "webm", "mkv"], "logseq-video", "video player");
		const line = String(info.mock.calls[0][0]);
		expect(line).toContain("video player");
		expect(line).toContain("mp4 (was video)");
		expect(line).toContain("webm (was video)");
	});

	it("restores the previous owners when the unload hook runs", () => {
		const { registrar, typeByExtension, unloadHooks } = fakeRegistrar({ mp4: "video" });
		takeOverExtensions(registrar, ["mp4", "mkv"], "logseq-video", "video player");
		expect(typeByExtension.mp4).toBe("logseq-video");
		expect(unloadHooks).toHaveLength(1);
		unloadHooks[0]();
		// mp4 goes back to core's view type; mkv (ours, no previous owner) is
		// simply gone again.
		expect(typeByExtension.mp4).toBe("video");
		expect(typeByExtension.mkv).toBeUndefined();
	});

	it("still claims everything when nothing was taken", () => {
		const { registrar, typeByExtension, unregistered } = fakeRegistrar();
		takeOverExtensions(registrar, ["mkv", "avi"], "logseq-video", "video player");
		expect(unregistered).toEqual([]);
		expect(typeByExtension).toEqual({ mkv: "logseq-video", avi: "logseq-video" });
	});
});
