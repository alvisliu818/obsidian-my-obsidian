/**
 * Lazy access to the Node builtins live transcription needs, resolved through
 * Obsidian's desktop `require` the same way the local whisper engine reaches
 * its own. Returns null where there is no Node (mobile), so callers can
 * refuse the feature instead of crashing on a missing builtin.
 * @module live/nodeAccess
 */

/** The subset of child_process live transcription touches. */
export interface ChildProcessLike {
	spawn: (
		cmd: string,
		args: string[],
		options: { windowsHide: boolean; stdio: string[] },
	) => {
		pid?: number;
		kill(): void;
		on(event: 'exit', listener: (code: number | null) => void): void;
		stderr: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
	};
}

/** The subset of Node's API surface live transcription touches. */
export interface LiveNodeModules {
	childProcess: ChildProcessLike;
	fs: { existsSync: (path: string) => boolean };
	path: { join: (...parts: string[]) => string; dirname: (path: string) => string };
	net: {
		createServer: () => {
			listen(port: number, host: string, cb: () => void): void;
			close(cb: () => void): void;
			on(event: 'error', cb: (error: unknown) => void): void;
		};
	};
}

/**
 * Resolves the builtins through the desktop require hook.
 * @returns The modules, or null where require is unavailable
 */
export function requireLiveNodeModules(): LiveNodeModules | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') {
		return null;
	}
	try {
		return {
			childProcess: req('child_process') as LiveNodeModules['childProcess'],
			fs: req('fs') as LiveNodeModules['fs'],
			path: req('path') as LiveNodeModules['path'],
			net: req('net') as LiveNodeModules['net'],
		};
	} catch {
		return null;
	}
}
