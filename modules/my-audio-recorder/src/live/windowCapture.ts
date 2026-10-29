/**
 * Window screenshots for live markers, taken through Electron's
 * desktopCapturer. The capturer is a main-process module reached through the
 * remote module under whichever name the host's Electron version exposes —
 * the same probing `recording/systemAudioSupport` does for its audio grant.
 * A screenshot is the source's thumbnail, rendered at the size asked for, so
 * no media stream is opened for one still frame.
 * @module live/windowCapture
 */

/** One capturable window, as the picker lists it. */
export interface WindowInfo {
	/** Stable-for-this-instance source id. */
	id: string;
	/** Display name (usually the window title). */
	name: string;
}

/** The thumbnail-bearing source shape getSources answers with. */
interface CapturerSource {
	id: string;
	name: string;
	thumbnail: { toPNG: () => ArrayBuffer } | null;
}

/** The part of Electron's desktopCapturer this module reaches for. */
interface DesktopCapturer {
	getSources: (options: {
		types: string[];
		thumbnailSize?: { width: number; height: number };
	}) => Promise<CapturerSource[]>;
}

/** The Electron remote surface, tried under several names by Electron version. */
interface ElectronRemote {
	getBuiltin?: (name: string) => unknown;
	desktopCapturer?: unknown;
	require?: (id: string) => { desktopCapturer?: unknown };
}

/**
 * Electron's desktopCapturer, or null where it cannot be reached.
 * @returns The capturer, or null on mobile or a host that refuses the lookup
 */
function desktopCapturer(): DesktopCapturer | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') {
		return null;
	}
	let electron: { remote?: ElectronRemote; desktopCapturer?: unknown };
	try {
		electron = req('electron') as { remote?: ElectronRemote };
	} catch {
		return null;
	}
	const remote = electron?.remote;
	const candidates = [
		(): unknown => remote?.getBuiltin?.('desktopCapturer'),
		(): unknown => remote?.desktopCapturer,
		(): unknown => remote?.require?.('electron').desktopCapturer,
		(): unknown => electron?.desktopCapturer,
	];
	for (const read of candidates) {
		try {
			const found = read() as DesktopCapturer | undefined;
			if (typeof found?.getSources === 'function') {
				return found;
			}
		} catch {
			// This route is closed on this host; the next one may not be.
		}
	}
	return null;
}

/**
 * Lists the windows a screenshot could be taken of.
 * @returns The windows, empty when the capturer is unavailable
 */
export async function listWindows(): Promise<WindowInfo[]> {
	const capturer = desktopCapturer();
	if (!capturer) {
		return [];
	}
	try {
		const sources = await capturer.getSources({ types: ['window'] });
		return sources
			.filter((source) => source.name.trim() !== '')
			.map((source) => ({ id: source.id, name: source.name }));
	} catch {
		return [];
	}
}

/**
 * Screenshots the window whose display name matches, re-listing sources at
 * capture time so the id is always fresh.
 * @param name - The window title picked earlier (exact match first)
 * @param width - Target capture width
 * @param height - Target capture height
 * @returns PNG bytes, or null when no window matches or capture is refused
 */
export async function captureWindowByName(
	name: string,
	width: number,
	height: number,
): Promise<ArrayBuffer | null> {
	const capturer = desktopCapturer();
	if (!capturer) {
		return null;
	}
	try {
		const sources = await capturer.getSources({
			types: ['window'],
			thumbnailSize: { width, height },
		});
		const source =
			sources.find((candidate) => candidate.name === name) ??
			sources.find((candidate) => candidate.name.includes(name));
		return source?.thumbnail?.toPNG() ?? null;
	} catch {
		return null;
	}
}

/**
 * Screenshots one window at the given size.
 * @param windowId - The source id picked earlier (matched fresh, so a renamed
 *   window still captures)
 * @param width - Target capture width
 * @param height - Target capture height
 * @returns PNG bytes, or null when the window is gone or capture is refused
 */
export async function captureWindowPng(
	windowId: string,
	width: number,
	height: number,
): Promise<ArrayBuffer | null> {
	const capturer = desktopCapturer();
	if (!capturer) {
		return null;
	}
	try {
		const sources = await capturer.getSources({
			types: ['window'],
			thumbnailSize: { width, height },
		});
		const source = sources.find((candidate) => candidate.id === windowId);
		return source?.thumbnail?.toPNG() ?? null;
	} catch {
		return null;
	}
}
