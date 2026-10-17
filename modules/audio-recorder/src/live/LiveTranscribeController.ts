/**
 * The live-transcribe session: microphone in, a pause-aware segmenter in the
 * middle, and the whisper.cpp server out — one transcript line per spoken
 * burst, cut where the speaker pauses. Owns the whole lifecycle: it starts
 * the server (auto-launched with the local engine's model), opens the capture
 * graph at 16 kHz, and tears both sides down when the session stops. Marker
 * clicks append tagged suffixes (and optionally a window screenshot) to the
 * last line. Requests leave through a FIFO, so lines always appear in speech
 * order even when the server is slower than the speaker.
 * @module live/LiveTranscribeController
 */

import { Notice, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { errorMessage } from '../errors';
import { encodeFloatsAsInt16Wav } from '../audio/WavEncoder';
import {
	formatLiveLine,
	formatMarkerTag,
	longestCommonPrefix,
	PauseSegmenter,
	rmsOf,
} from './liveAudio';
import { transcribeChunk } from './inferenceClient';
import {
	pickFreePort,
	startWhisperServer,
	type WhisperServerHandle,
} from './whisperServer';
import { captureWindowByName } from './windowCapture';
import { requireLiveNodeModules } from './nodeAccess';

/** The session's coarse state, mirrored by the panel's status line. */
export type LiveSessionState =
	| 'idle'
	| 'starting'
	| 'listening'
	| 'stopping';

/** What the panel (or a test) observes while a session runs. */
export interface LiveTranscribeSink {
	onLog(message: string): void;
	/**
	 * A line was appended, or an existing one changed (a marker tagged it).
	 * @param line - The full line text
	 * @param index - The line's position in the transcript
	 */
	onLine(line: string, index: number): void;
	/**
	 * The streaming preview moved: text recognized from the uncommitted tail
	 * by a rolling re-decode, split where two consecutive decodes agree.
	 * @param stable - The agreed prefix (solid text)
	 * @param unstable - The still-moving tail (muted text)
	 */
	onPreview(stable: string, unstable: string): void;
	onState(state: LiveSessionState): void;
}

/** The marker buttons the panel offers, in display order. */
export const LIVE_MARKER_KINDS = ['重点', '问题', '待办'] as const;

/** Tunables that do not deserve settings rows yet. */
const LIVE_DEFAULT_PORT = 18742;
const CAPTURE_RATE = 16_000;
/** Threads the server may use on its CPU fallback path. */
const SERVER_THREADS = 6;
/** Screenshot size for a marker click. */
const SCREENSHOT_WIDTH = 1920;
const SCREENSHOT_HEIGHT = 1080;
/** How often the streaming preview re-decodes the uncommitted tail. */
const PREVIEW_INTERVAL_MS = 800;
/** The preview never decodes the newest 0.3 s, so no half word is shown. */
const PREVIEW_GUARD_FRAMES = Math.round(0.3 * CAPTURE_RATE);
/** Smallest uncommitted span worth a preview decode. */
const PREVIEW_MIN_SPAN_FRAMES = Math.round(0.4 * CAPTURE_RATE);
/** New audio required since the last preview before decoding again. */
const PREVIEW_MIN_NEW_FRAMES = Math.round(0.35 * CAPTURE_RATE);
/** Longest window the preview decodes (the commit path owns longer spans). */
const PREVIEW_MAX_WINDOW_FRAMES = Math.round(12 * CAPTURE_RATE);
/** Preview span quieter than this is silence: skip the GPU, clear the text. */
const PREVIEW_SILENCE_RMS = 0.0035;

/** Dependencies the plugin hands the controller once. */
export interface LiveTranscribeControllerDeps {
	app: App;
	getSettings: () => AudioRecorderSettings;
}

/**
 * Runs one live session at a time; a start while one is running is refused.
 * All async paths check {@link disposed} so a plugin unload mid-session
 * cannot resurrect the server or the capture graph.
 */
export class LiveTranscribeController {
	private sink: LiveTranscribeSink | null = null;
	private server: WhisperServerHandle | null = null;
	private serverBaseUrl: string | null = null;
	private stream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private segmenter: PauseSegmenter | null = null;
	private state: LiveSessionState = 'idle';
	private disposed = false;
	private inFlight = false;
	private pending: Array<{ samples: Float32Array; startFrame: number }> = [];
	private lines: string[] = [];
	// ---- 流式预览（滚动窗口重解码）----
	private previewBlocks: Float32Array[] = [];
	private previewStartFrame = 0;
	private captureFrames = 0;
	private previewEpoch = 0;
	private previewInFlight = false;
	private lastPreviewText = '';
	private lastPreviewEndFrame = 0;
	private previewTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: LiveTranscribeControllerDeps) {}

	/** Wires (or unwires) the UI that observes the session. */
	setSink(sink: LiveTranscribeSink | null): void {
		this.sink = sink;
		if (sink) {
			sink.onState(this.state);
		}
	}

	/** The transcript lines of the current or last session. */
	getTranscript(): string[] {
		return [...this.lines];
	}

	private setState(state: LiveSessionState): void {
		this.state = state;
		this.sink?.onState(state);
	}

	private log(message: string): void {
		this.sink?.onLog(message);
	}

	/**
	 * Derives the server executable from the local engine's configured CLI:
	 * the two binaries ship in the same folder, so one setting drives both.
	 */
	private resolveServerPath(binaryPath: string): string | null {
		const node = requireLiveNodeModules();
		if (!node) {
			return null;
		}
		return node.path.join(node.path.dirname(binaryPath), 'whisper-server.exe');
	}

	/**
	 * Starts a session: server first (so its readiness log lands before the
	 * first line), then the capture graph. Refuses a second concurrent run.
	 */
	async start(): Promise<void> {
		if (this.state !== 'idle' && this.state !== 'stopping') {
			return;
		}
		if (this.disposed) {
			return;
		}
		const settings = this.deps.getSettings();
		if (
			settings.localWhisperBinaryPath === '' ||
			settings.localWhisperModelPath === ''
		) {
			new Notice('请先在设置里配置本地 whisper.cpp 的二进制与模型路径。');
			return;
		}
		if (!requireLiveNodeModules()) {
			new Notice('实时转写仅支持桌面端。');
			return;
		}
		this.lines = [];
		this.pending = [];
		this.inFlight = false;
		this.segmenter = new PauseSegmenter({ sampleRate: CAPTURE_RATE });
		this.previewBlocks = [];
		this.previewStartFrame = 0;
		this.captureFrames = 0;
		this.previewEpoch++;
		this.previewInFlight = false;
		this.lastPreviewText = '';
		this.lastPreviewEndFrame = 0;
		this.setState('starting');
		try {
			const serverPath = this.resolveServerPath(settings.localWhisperBinaryPath);
			if (!serverPath) {
				throw new Error('实时转写仅支持桌面端。');
			}
			const port = await pickFreePort(LIVE_DEFAULT_PORT);
			this.server = await startWhisperServer(
				{
					serverPath,
					modelPath: settings.localWhisperModelPath,
					port,
					threads: SERVER_THREADS,
				},
				(message) => this.log(message),
			);
			this.serverBaseUrl = `http://127.0.0.1:${this.server.port}`;
			await this.openCapture();
			this.previewTimer = setInterval(() => {
				void this.previewTick();
			}, PREVIEW_INTERVAL_MS);
			this.setState('listening');
			this.log('正在聆听——按停顿分句，说完一句稍停即出字。');
		} catch (error) {
			this.setState('idle');
			this.log(errorMessage(error));
			new Notice(`实时转写启动失败：${errorMessage(error)}`);
			await this.teardown();
		}
	}

	/**
	 * Opens the capture graph: a 16 kHz AudioContext resamples the device's
	 * native rate, and a script processor hands each block to the segmenter.
	 * The graph routes through a zero gain so nothing is audible.
	 */
	private async openCapture(): Promise<void> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			},
		});
		const context = new AudioContext({ sampleRate: CAPTURE_RATE });
		this.audioContext = context;
		const source = context.createMediaStreamSource(this.stream);
		const processor = context.createScriptProcessor(4096, 1, 1);
		processor.onaudioprocess = (event) => {
			if (this.state !== 'listening') {
				return;
			}
			const input = event.inputBuffer.getChannelData(0);
			const segmenter = this.segmenter;
			if (!segmenter) {
				return;
			}
			this.captureFrames += input.length;
			this.pushPreviewBlock(new Float32Array(input));
			const segment = segmenter.feed(new Float32Array(input));
			if (segment) {
				this.pending.push(segment);
				// The segment is committed audio: the preview that covered it is
				// obsolete, and the next preview starts from the capture edge.
				this.previewEpoch++;
				this.lastPreviewText = '';
				this.lastPreviewEndFrame = this.captureFrames;
				this.sink?.onPreview('', '');
				void this.pump();
			}
		};
		const mute = context.createGain();
		mute.gain.value = 0;
		source.connect(processor);
		processor.connect(mute);
		mute.connect(context.destination);
	}

	/**
	 * Sends queued segments one at a time, in speech order. Called from the
	 * capture callback and again after each response, so the queue drains
	 * whenever the server keeps up.
	 */
	private async pump(): Promise<void> {
		const base = this.serverBaseUrl;
		if (!base || this.inFlight || this.disposed) {
			return;
		}
		const next = this.pending.shift();
		if (!next) {
			return;
		}
		this.inFlight = true;
		try {
			const wav = await encodeFloatsAsInt16Wav([next.samples], CAPTURE_RATE);
			const language = this.deps.getSettings().transcriptionLanguage;
			const result = await transcribeChunk(base, wav, language);
			if (this.state === 'listening' && !result.empty) {
				const line = formatLiveLine(next.startFrame / CAPTURE_RATE, result.text);
				this.lines.push(line);
				this.sink?.onLine(line, this.lines.length - 1);
			}
		} catch (error) {
			this.log(`转写失败：${errorMessage(error)}`);
		} finally {
			this.inFlight = false;
			if (this.pending.length > 0 && !this.disposed) {
				void this.pump();
			}
		}
	}

	/**
	 * Keeps the preview ring to the newest window's worth of audio. The ring
	 * is a plain block list with a start frame, so a decode can slice any
	 * span that is still inside it.
	 * @param block - One capture block to append
	 */
	private pushPreviewBlock(block: Float32Array): void {
		this.previewBlocks.push(block);
		while (
			this.captureFrames - this.previewStartFrame > PREVIEW_MAX_WINDOW_FRAMES &&
			this.previewBlocks.length > 1
		) {
			this.previewStartFrame += this.previewBlocks[0]?.length ?? 0;
			this.previewBlocks.shift();
		}
	}

	/**
	 * One streaming-preview tick: re-decode the uncommitted tail (minus the
	 * guard) and split the answer against the previous decode at the longest
	 * common prefix — everything agreed on renders solid, the tail renders
	 * muted. Skipped while the commit queue is busy, when too little is new,
	 * or when the span is silence; a stale answer from before a commit is
	 * dropped via the epoch.
	 */
	private async previewTick(): Promise<void> {
		if (
			this.state !== 'listening' ||
			this.disposed ||
			this.previewInFlight ||
			this.pending.length > 0 ||
			!this.serverBaseUrl
		) {
			return;
		}
		if (this.captureFrames - this.lastPreviewEndFrame < PREVIEW_MIN_NEW_FRAMES) {
			// Nothing new worth the GPU since the last preview decode.
			return;
		}
		const spanStart = Math.max(
			this.previewStartFrame,
			this.lastPreviewEndFrame,
		);
		const spanEnd = this.captureFrames - PREVIEW_GUARD_FRAMES;
		if (spanEnd - spanStart < PREVIEW_MIN_SPAN_FRAMES) {
			return;
		}
		if (spanEnd - this.previewStartFrame > PREVIEW_MAX_WINDOW_FRAMES) {
			// Should not happen (the ring trims), but a silent guard beats a
			// decode that grows without bound.
			this.previewStartFrame = spanEnd - PREVIEW_MAX_WINDOW_FRAMES;
		}
		const samples = this.slicePreview(spanStart, spanEnd);
		if (!samples || rmsOf(samples) < PREVIEW_SILENCE_RMS) {
			// Nobody spoke since the last tick: retire the moving text.
			if (this.lastPreviewText !== '') {
				this.lastPreviewText = '';
				this.lastPreviewEndFrame = spanEnd;
				this.sink?.onPreview('', '');
			}
			return;
		}
		const epoch = this.previewEpoch;
		this.previewInFlight = true;
		try {
			const wav = await encodeFloatsAsInt16Wav([samples], CAPTURE_RATE);
			const result = await transcribeChunk(
				this.serverBaseUrl,
				wav,
				this.deps.getSettings().transcriptionLanguage,
				{ temperature: '0' },
			);
			if (epoch !== this.previewEpoch || this.disposed) {
				// A commit happened while this decode ran: its answer is stale.
				return;
			}
			this.lastPreviewEndFrame = spanEnd;
			if (result.empty) {
				this.lastPreviewText = '';
				this.sink?.onPreview('', '');
				return;
			}
			const stable = longestCommonPrefix(this.lastPreviewText, result.text);
			this.lastPreviewText = result.text;
			this.sink?.onPreview(stable, result.text.slice(stable.length));
		} catch (error) {
			// The preview is best-effort: a failed tick just skips, the commit
			// path at the pause is the one that owns correctness.
			this.log(`预览跳过：${errorMessage(error)}`);
		} finally {
			this.previewInFlight = false;
		}
	}

	/**
	 * Concatenates one span of the preview ring into a single buffer.
	 * @param startFrame - First frame of the span (absolute capture time)
	 * @param endFrame - Frame after the last one of the span
	 * @returns The span's samples, or null when the ring no longer holds it
	 */
	private slicePreview(
		startFrame: number,
		endFrame: number,
	): Float32Array | null {
		const start = Math.max(startFrame, this.previewStartFrame);
		const end = Math.min(endFrame, this.captureFrames);
		if (end <= start) {
			return null;
		}
		const out = new Float32Array(end - start);
		let offset = 0;
		let cursor = this.previewStartFrame;
		for (const block of this.previewBlocks) {
			const blockEnd = cursor + block.length;
			if (blockEnd > start && cursor < end) {
				const from = Math.max(0, start - cursor);
				const to = Math.min(block.length, end - cursor);
				out.set(block.subarray(from, to), offset);
				offset += to - from;
			}
			cursor = blockEnd;
		}
		return offset === out.length ? out : out.subarray(0, offset);
	}

	/**
	 * Appends a marker tag (and, when configured, a window screenshot link)
	 * to the last transcript line — or opens a line of its own when nothing
	 * has been recognized yet.
	 * @param kind - The marker's name (重点 / 问题 / 待办)
	 */
	async addMarker(kind: string): Promise<void> {
		if (this.state !== 'listening') {
			return;
		}
		let suffix = formatMarkerTag(kind, new Date());
		const settings = this.deps.getSettings();
		if (settings.liveMarkerScreenshotEnabled && settings.liveMarkerWindowName !== '') {
			try {
				const png = await captureWindowByName(
					settings.liveMarkerWindowName,
					SCREENSHOT_WIDTH,
					SCREENSHOT_HEIGHT,
				);
				const path = png ? await this.savePngToVault(png, kind) : null;
				if (path) {
					suffix += ` ![[${path}]]`;
				} else {
					this.log('截屏失败：找不到所选窗口或截取被拒。');
				}
			} catch (error) {
				this.log(`截屏失败：${errorMessage(error)}`);
			}
		}
		if (this.lines.length === 0) {
			this.lines.push(suffix);
		} else {
			const last = this.lines.length - 1;
			this.lines[last] = (this.lines[last] ?? '') + suffix;
		}
		const lastLine = this.lines[this.lines.length - 1] ?? '';
		this.sink?.onLine(lastLine, this.lines.length - 1);
	}

	/**
	 * Writes a PNG into the vault's attachments location, named by time and
	 * marker so a folder of shots stays readable.
	 * @param png - PNG bytes from the capturer
	 * @param kind - The marker the shot belongs to
	 * @returns The vault path the file was written to
	 */
	private async savePngToVault(png: ArrayBuffer, kind: string): Promise<string> {
		const now = new Date();
		const stamp = [
			now.getFullYear(),
			String(now.getMonth() + 1).padStart(2, '0'),
			String(now.getDate()).padStart(2, '0'),
		].join('') +
			'-' +
			now.toTimeString().slice(0, 8).replace(/:/g, '');
		const preferred = `实时转写-${stamp}-${kind}.png`;
		const path = await this.deps.app.fileManager.getAvailablePathForAttachment(
			preferred,
		);
		await this.deps.app.vault.createBinary(normalizePath(path), png);
		return path;
	}

	/**
	 * Stops the session: flushes the segmenter's tail into the queue, waits
	 * for the queue to drain, closes the capture graph, and kills the server
	 * so GPU memory frees.
	 */
	async stop(): Promise<void> {
		if (this.state !== 'listening' && this.state !== 'starting') {
			return;
		}
		this.setState('stopping');
		const tail = this.segmenter?.flush() ?? null;
		if (tail) {
			this.pending.push(tail);
		}
		// The queue drains before teardown, so a session never ends with a
		// recognized sentence left unsaid.
		const drainStartedAt = Date.now();
		while ((this.pending.length > 0 || this.inFlight) && !this.disposed) {
			if (this.pending.length > 0 && !this.inFlight) {
				void this.pump();
			}
			if (Date.now() - drainStartedAt > 60_000) {
				this.log('等待队列排空超时，剩余分段被丢弃。');
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		this.pending = [];
		await this.teardown();
		this.setState('idle');
		this.log('已停止。');
	}

	/** Closes the capture graph and kills the server, leaving state alone. */
	private async teardown(): Promise<void> {
		if (this.previewTimer) {
			clearInterval(this.previewTimer);
			this.previewTimer = null;
		}
		this.previewEpoch++;
		this.previewBlocks = [];
		this.lastPreviewText = '';
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		if (this.audioContext) {
			try {
				await this.audioContext.close();
			} catch {
				// An already-closed context is fine to ignore.
			}
			this.audioContext = null;
		}
		this.segmenter?.reset();
		this.server?.stop();
		this.server = null;
		this.serverBaseUrl = null;
	}

	/** Stops everything and makes the controller refuse further sessions. */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.sink = null;
		await this.teardown();
		this.setState('idle');
	}
}
