/**
 * Lifecycle for the whisper.cpp HTTP server (`whisper-server.exe`) that the
 * live-transcribe panel talks to. The plugin launches it with the model the
 * local engine already uses, waits for the HTTP layer to answer, and kills it
 * when the session stops, so GPU memory is not held while nobody records.
 * Desktop only: spawning needs Node, reached the lazy way the local whisper
 * engine reaches it.
 * @module live/whisperServer
 */

import { requestUrl } from 'obsidian';
import { errorMessage } from '../errors';
import { requireLiveNodeModules } from './nodeAccess';

/** Options the panel hands the manager when a session starts. */
export interface WhisperServerOptions {
	/** Path to whisper-server.exe (derived from the local engine's folder). */
	serverPath: string;
	/** Path to the ggml model the local engine is configured with. */
	modelPath: string;
	/** Port to listen on. */
	port: number;
	/** CPU threads for the encoder fallback (GPU is used when available). */
	threads?: number;
}

/** A running server instance. */
export interface WhisperServerHandle {
	port: number;
	/** Terminates the process. Safe to call more than once. */
	stop(): void;
}

/** How long a launch may take before the wait gives up. */
const START_TIMEOUT_MS = 60_000;
/** Interval between readiness probes. */
const PROBE_INTERVAL_MS = 500;
/** Stderr lines kept for the error message of a failed launch. */
const STDERR_TAIL_LINES = 6;

/**
 * Starts the server and resolves once its HTTP layer answers.
 * @param options - Paths, port and thread count for the launch
 * @param onLog - Progress lines for the panel's status readout
 * @returns A handle that stops the process
 * @throws When Node is unavailable, the binary is missing, or the server
 *   did not become reachable within the start timeout
 */
export async function startWhisperServer(
	options: WhisperServerOptions,
	onLog?: (message: string) => void,
): Promise<WhisperServerHandle> {
	const node = requireLiveNodeModules();
	if (!node) {
		throw new Error('实时转写仅支持桌面端（需要 Node 子进程）。');
	}
	if (!node.fs.existsSync(options.serverPath)) {
		throw new Error(
			`未找到 whisper-server：${options.serverPath}（应与 whisper-cli 同目录）`,
		);
	}
	if (!node.fs.existsSync(options.modelPath)) {
		throw new Error(`未找到模型文件：${options.modelPath}`);
	}
	const args = [
		'-m',
		options.modelPath,
		'--host',
		'127.0.0.1',
		'--port',
		String(options.port),
		'-t',
		String(options.threads ?? 6),
	];
	onLog?.('正在启动 whisper-server（首次加载模型约 10 秒）…');
	const stderrLines: string[] = [];
	const child = node.childProcess.spawn(options.serverPath, args, {
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stderr?.on('data', (chunk: unknown) => {
		const text = typeof chunk === 'string' ? chunk : String(chunk);
		for (const line of text.split(/\r?\n/)) {
			if (line.trim() !== '') {
				stderrLines.push(line.trim());
				if (stderrLines.length > 30) {
					stderrLines.shift();
				}
			}
		}
	});
	let exited = false;
	let exitCode: number | null = null;
	child.on('exit', (code) => {
		exited = true;
		exitCode = code;
	});
	const base = `http://127.0.0.1:${options.port}`;
	const startedAt = Date.now();
	while (Date.now() - startedAt < START_TIMEOUT_MS) {
		if (exited) {
			throw new Error(
				`whisper-server 启动失败（退出码 ${exitCode}）：${stderrLines.slice(-STDERR_TAIL_LINES).join(' | ') || '无输出'}`,
			);
		}
		try {
			// Any HTTP answer — including the 404 of a missing index page —
			// proves the listener is up; only connection failures mean "not yet".
			await requestUrl({ url: base, method: 'GET', throw: false });
			onLog?.('whisper-server 已就绪。');
			return {
				port: options.port,
				stop: () => {
					if (!exited) {
						child.kill();
					}
				},
			};
		} catch (error) {
			if (exited) {
				throw new Error(
					`whisper-server 启动失败：${stderrLines.slice(-STDERR_TAIL_LINES).join(' | ') || errorMessage(error)}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
		}
	}
	child.kill();
	throw new Error('whisper-server 启动超时（60 秒内未响应）。');
}

/**
 * Picks a TCP port that is free right now, starting from the given one so
 * repeated sessions land on the same address when possible.
 * @param preferred - First port to try
 * @returns A port a listener can bind without colliding (best effort)
 */
export async function pickFreePort(preferred: number): Promise<number> {
	const node = requireLiveNodeModules();
	if (!node) {
		return preferred;
	}
	for (let candidate = preferred; candidate < preferred + 20; candidate++) {
		const free = await new Promise<boolean>((resolve) => {
			const server = node.net.createServer();
			let settled = false;
			const done = (value: boolean) => {
				if (!settled) {
					settled = true;
					resolve(value);
				}
			};
			server.on('error', () => done(false));
			server.listen(candidate, '127.0.0.1', () => {
				server.close(() => done(true));
			});
		});
		if (free) {
			return candidate;
		}
	}
	return preferred;
}
