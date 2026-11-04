/**
 * audio-recorder 懒包入口（聚合主仓内存优化）：mediabunny + flac/mp3 编码器。
 * 独立 esbuild 构建 → lazy/audio-codecs.js，运行时经 lazyMediabunny.ts 的
 * 代理值符号首次触碰加载。
 *
 * 编码器必须在加载时对**同一 mediabunny 实例**自注册（单例注册语义），
 * 故入口 side-effect 调用注册函数——三个包在同一 chunk 内共享一份
 * mediabunny 拷贝，注册必然命中。
 */
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import * as mediabunny from 'mediabunny';

registerFlacEncoder();
registerMp3Encoder();
export default mediabunny;
