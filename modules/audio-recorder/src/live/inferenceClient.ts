/**
 * The HTTP half of live transcription: one inference request per captured
 * chunk, built as a hand-rolled multipart body because Obsidian's requestUrl
 * (which bypasses the app:// origin's CORS) takes a flat body rather than a
 * FormData. Response parsing stays here too, so the panel only ever sees text.
 * @module live/inferenceClient
 */

import { requestUrl } from 'obsidian';

/** One transcribed chunk as the panel displays it. */
export interface LiveChunkResult {
	/** The chunk's full recognized text. */
	text: string;
	/** Whether the server answered that nothing was recognized. */
	empty: boolean;
}

/** A text field of the multipart body. */
export interface MultipartField {
	name: string;
	value: string;
}

/** The binary part of the multipart body (the WAV file). */
export interface MultipartFile {
	name: string;
	filename: string;
	mime: string;
	data: ArrayBuffer;
}

const CRLF = '\r\n';

/**
 * Builds one multipart/form-data body by hand.
 * @param fields - Text fields (inference parameters)
 * @param file - The binary field
 * @returns The encoded body and the Content-Type header value
 */
export function buildMultipartBody(
	fields: readonly MultipartField[],
	file: MultipartFile,
): { body: ArrayBuffer; contentType: string } {
	const boundary = `----aar-live-${Math.random().toString(16).slice(2)}`;
	const parts: Uint8Array[] = [];
	let bytes = 0;
	const push = (part: Uint8Array) => {
		parts.push(part);
		bytes += part.byteLength;
	};
	const pushText = (text: string) =>
		push(new TextEncoder().encode(text));
	for (const field of fields) {
		pushText(`--${boundary}${CRLF}`);
		pushText(
			`Content-Disposition: form-data; name="${field.name}"${CRLF}${CRLF}`,
		);
		pushText(`${field.value}${CRLF}`);
	}
	pushText(`--${boundary}${CRLF}`);
	pushText(
		`Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}`,
	);
	pushText(`Content-Type: ${file.mime}${CRLF}${CRLF}`);
	push(new Uint8Array(file.data));
	pushText(`${CRLF}--${boundary}--${CRLF}`);
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.byteLength;
	}
	return {
		body: body.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

/** Shape the whisper.cpp server answers a verbose_json request with. */
interface WhisperServerResponse {
	text?: unknown;
}

/**
 * Sends one chunk to the server's inference endpoint.
 * @param baseUrl - e.g. `http://127.0.0.1:18742`
 * @param wav - The chunk encoded as a 16 kHz mono WAV
 * @param language - ISO code or `auto`
 * @returns The recognized text, or an empty result for silence
 * @throws When the server answers with an error status or an unusable body
 */
export async function transcribeChunk(
	baseUrl: string,
	wav: ArrayBuffer,
	language: string,
): Promise<LiveChunkResult> {
	const { body, contentType } = buildMultipartBody(
		[
			{ name: 'response_format', value: 'verbose_json' },
			{ name: 'language', value: language || 'auto' },
		],
		{ name: 'file', filename: 'chunk.wav', mime: 'audio/wav', data: wav },
	);
	const response = await requestUrl({
		url: `${baseUrl}/inference`,
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body,
		throw: false,
	});
	if (response.status >= 400) {
		throw new Error(
			`推理请求失败（HTTP ${response.status}）：${response.text.slice(0, 200)}`,
		);
	}
	const parsed = response.json as WhisperServerResponse;
	const text =
		typeof parsed?.text === 'string' ? parsed.text.replace(/\s*\n\s*/g, ' ').trim() : '';
	return { text, empty: text === '' };
}
