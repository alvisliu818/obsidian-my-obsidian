/**
 * mediabunny 懒加载器（聚合主仓内存优化，2026-11-05）。
 *
 * mediabunny + flac/mp3 编码器 ~1.2MB，主 bundle 静态携带 = 源码 ×2 常驻。
 * 拆为独立懒包（lazy/audio-codecs.js），首次触碰才 require。
 *
 * 用法：消费方把 `import { X } from 'mediabunny'` 换成
 * `import { X } from '../lazyMediabunny'`（同名转发包装，调用点零改动）。
 * 类/常量经 Proxy 首触加载；纯类型（type-only）仍从 'mediabunny' 导入。
 *
 * encodingWorker.ts 不走本加载器——它本身是构建期内联的独立 worker bundle
 * （Blob URL 按需启动），其 mediabunny 副本随 worker 源文本常驻主包，属
 * worker 机制本身的既有形态。
 */

type NS = typeof import('mediabunny');

let mod: NS | null = null;
let pluginDir: string | null = null;

/** 模块 onload 调用：记录插件目录（绝对路径，FileSystemAdapter.getFullPath）。 */
export function initLazyMediabunny(dir: string): void {
	pluginDir = dir;
}

function getLib(): NS {
	if (mod) return mod;
	if (!pluginDir) throw new Error('[audio-recorder] lazy mediabunny used before initLazyMediabunny()');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const required = require(`${pluginDir}/lazy/audio-codecs.js`) as { default?: NS } | NS;
	mod = ((required as { default?: NS }).default ?? required) as NS;
	return mod;
}

export function isMediabunnyLoaded(): boolean {
	return mod !== null;
}

/**
 * 值符号的懒代理。类可 construct（new WavOutputFormat()），常量/命名空间可
 * 属性访问（ALL_FORMATS.includes(...)）；首触碰触发懒包 require。
 */
function lazyValue<T>(name: string): T {
	return new Proxy(function mediabunnyLazySlot() {}, {
		get(_t, prop) {
			const lib = getLib() as unknown as Record<string, unknown>;
			const target = lib[name] as unknown as Record<string | symbol, unknown>;
			const v = target[prop as string];
			return typeof v === 'function' ? v.bind(target) : v;
		},
		set(_t, prop, value) {
			const lib = getLib() as unknown as Record<string, unknown>;
			(lib[name] as unknown as Record<string | symbol, unknown>)[prop as string] = value;
			return true;
		},
		construct(_t, args) {
			const lib = getLib() as unknown as Record<string, unknown>;
			const Ctor = lib[name] as new (...a: unknown[]) => object;
			return new Ctor(...(args as unknown[]));
		},
		apply(_t, _thisArg, args) {
			const fn = (getLib() as unknown as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
			return fn(...args);
		},
		has(_t, prop) {
			return prop in ((getLib() as unknown as Record<string, unknown>)[name] as object);
		},
	}) as T;
}

export const ALL_FORMATS = lazyValue<NS['ALL_FORMATS']>('ALL_FORMATS');
export const AdtsOutputFormat = lazyValue<NS['AdtsOutputFormat']>('AdtsOutputFormat');
export const AudioBufferSource = lazyValue<NS['AudioBufferSource']>('AudioBufferSource');
export const AudioSampleSink = lazyValue<NS['AudioSampleSink']>('AudioSampleSink');
export const AudioSampleSource = lazyValue<NS['AudioSampleSource']>('AudioSampleSource');
export const BlobSource = lazyValue<NS['BlobSource']>('BlobSource');
export const BufferSource = lazyValue<NS['BufferSource']>('BufferSource');
export const BufferTarget = lazyValue<NS['BufferTarget']>('BufferTarget');
export const Conversion = lazyValue<NS['Conversion']>('Conversion');
export const FlacOutputFormat = lazyValue<NS['FlacOutputFormat']>('FlacOutputFormat');
export const Input = lazyValue<NS['Input']>('Input');
export const Mp3OutputFormat = lazyValue<NS['Mp3OutputFormat']>('Mp3OutputFormat');
export const Mp4OutputFormat = lazyValue<NS['Mp4OutputFormat']>('Mp4OutputFormat');
export const OggOutputFormat = lazyValue<NS['OggOutputFormat']>('OggOutputFormat');
export const Output = lazyValue<NS['Output']>('Output');
export const Quality = lazyValue<NS['Quality']>('Quality');
export const AudioSample = lazyValue<NS['AudioSample']>('AudioSample');
export const UrlSource = lazyValue<NS['UrlSource']>('UrlSource');
export const WavOutputFormat = lazyValue<NS['WavOutputFormat']>('WavOutputFormat');
export const WebMOutputFormat = lazyValue<NS['WebMOutputFormat']>('WebMOutputFormat');
export const canEncodeAudio = lazyValue<NS['canEncodeAudio']>('canEncodeAudio');

// —— 类符号的实例类型合并（消费方 `: X` 类型位 = 实例类型）——
export type InputType = InstanceType<NS['Input']>;
export type UrlSourceType = InstanceType<NS['UrlSource']>;
export type BlobSourceType = InstanceType<NS['BlobSource']>;
export type BufferSourceType = InstanceType<NS['BufferSource']>;
export type BufferTargetType = InstanceType<NS['BufferTarget']>;
export type OutputType = InstanceType<NS['Output']>;
export type QualityType = InstanceType<NS['Quality']>;
export type AudioBufferSourceType = InstanceType<NS['AudioBufferSource']>;
export type AudioSampleSinkType = InstanceType<NS['AudioSampleSink']>;
export type AudioSampleSourceType = InstanceType<NS['AudioSampleSource']>;
export type WavOutputFormatType = InstanceType<NS['WavOutputFormat']>;
export type WebMOutputFormatType = InstanceType<NS['WebMOutputFormat']>;
export type Mp3OutputFormatType = InstanceType<NS['Mp3OutputFormat']>;
export type Mp4OutputFormatType = InstanceType<NS['Mp4OutputFormat']>;
export type OggOutputFormatType = InstanceType<NS['OggOutputFormat']>;
export type FlacOutputFormatType = InstanceType<NS['FlacOutputFormat']>;
export type AdtsOutputFormatType = InstanceType<NS['AdtsOutputFormat']>;
export type AudioSample = InstanceType<NS['AudioSample']>;
