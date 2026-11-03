/**
 * 媒体容器关键帧（同步样本）时间表解析。
 *
 * 浏览器不暴露视频流的关键帧索引，只能解析媒体文件容器：
 *  - MP4 / QuickTime：trak 内 stbl 的 stss（同步样本表）→ 关键帧样本号
 *  - MKV / WebM（Matroska）：Cluster 中 SimpleBlock / BlockGroup 的 keyframe 标志
 *
 * 返回升序的关键帧时间（秒）。无法解析或无独立关键帧（如无 B 帧的流）时返回空数组。
 */

/** 4 字节 Box type 或元素 ID 的比较常量 */
const MOOV = 0x6d6f6f76;
const TRAK = 0x7472616b;
const MDIA = 0x6d646961;
const MDHD = 0x6d646864;
const HDLR = 0x68646c72;
const MINF = 0x6d696e66;
const STBL = 0x7374626c;
const STTS = 0x73747473;
const STSS = 0x73747373;
const FIV = 0x76696465; // 'vide' handler

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const TIMECODE_SCALE = 0x2ad7b1;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const REFERENCE_BLOCK = 0xfb;

export function parseKeyframes(data: ArrayBuffer | Uint8Array): number[] {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (u8.length < 16) return [];
    if (readUint(u8, 0, 4) === EBML) return parseMatroska(u8);
    if (readUint(u8, 4, 4) === 0x66747970) return parseMp4(u8); // 'ftyp'
    return [];
}

/* ===== 通用二进制读取 ===== */

function readUint(u8: Uint8Array, pos: number, bytes: number): number {
    let v = 0;
    for (let i = 0; i < bytes; i++) v = v * 256 + (u8[pos + i] ?? 0);
    return v;
}

function readInt16(u8: Uint8Array, pos: number): number {
    const v = (u8[pos] << 8) | u8[pos + 1];
    return v << 16 >> 16; // 符号扩展
}

/** 读 EBML VINT（无符号整数，剥离长度标记位），返回数值与占用字节数 */
function readVint(u8: Uint8Array, pos: number): { value: number; size: number } | null {
    if (pos >= u8.length) return null;
    const first = u8[pos];
    let len = 1;
    for (let mask = 0x80; len <= 8 && (first & mask) === 0; mask >>= 1) len++;
    if (len > 8 || pos + len > u8.length) return null;
    let value = first & (0xff >>> len);
    for (let i = 1; i < len; i++) value = value * 256 + u8[pos + i];
    return { value, size: len };
}

/** 读 EBML 元素 ID（长度规则同 VINT，但值直接取原始字节） */
function readId(u8: Uint8Array, pos: number): { value: number; size: number } | null {
    const v = readVint(u8, pos);
    if (!v) return null;
    let id = 0;
    for (let i = 0; i < v.size; i++) id = id * 256 + u8[pos + i];
    return { value: id, size: v.size };
}

/**
 * 按已声明的字段长度读取 EBML uint，并清掉首字节的高位标记位。
 * 部分封装器（如 libavformat）把整数值按普通大端字节写入而不置标记位，
 * 直接用 readVint 依标记位推长度会读错（例如 0x01 被当成 8 字节 VINT）。
 */
function readUintField(u8: Uint8Array, start: number, size: number): number {
    if (size <= 0 || start >= u8.length) return 0;
    const n = Math.min(size, u8.length - start);
    let v = (u8[start] ?? 0) & 0x7f;
    for (let i = 1; i < n; i++) v = v * 256 + (u8[start + i] ?? 0);
    return v;
}

interface Elem { id: number; start: number; end: number; }

/** 遍历 [start, end) 区间内的 EBML 子元素（size 视为未知时截断到 end） */
function children(u8: Uint8Array, start: number, end: number): Elem[] {
    const out: Elem[] = [];
    let pos = start;
    while (pos + 2 <= end) {
        const id = readId(u8, pos);
        if (!id) break;
        const sv = readVint(u8, pos + id.size);
        if (!sv) break;
        const ds = pos + id.size + sv.size;
        const de = Math.max(ds, Math.min(end, ds + sv.value));
        out.push({ id: id.value, start: ds, end: de });
        pos = de;
    }
    return out;
}

/* ===== MP4 解析 ===== */

interface Box { type: number; start: number; end: number; }

function boxes(u8: Uint8Array, start: number, end: number): Box[] {
    const out: Box[] = [];
    let pos = start;
    while (pos + 8 <= end) {
        let size = readUint(u8, pos, 4);
        const type = readUint(u8, pos + 4, 4);
        let dataStart = pos + 8;
        if (size === 1) {
            if (pos + 16 > end) break;
            size = readUint(u8, pos + 8, 8);
            dataStart = pos + 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < 8 || pos + size > end) break;
        out.push({ type, start: dataStart, end: pos + size });
        pos += size;
    }
    return out;
}

function findBox(u8: Uint8Array, parent: Box, type: number): Box | null {
    return boxes(u8, parent.start, parent.end).find(b => b.type === type) ?? null;
}

function mdhdTimescale(u8: Uint8Array, box: Box): number {
    const ver = u8[box.start] ?? 0;
    const off = ver === 1 ? 20 : 12;
    return readUint(u8, box.start + off, 4);
}

function parseMp4(u8: Uint8Array): number[] {
    const moov = boxes(u8, 0, u8.length).find(b => b.type === MOOV);
    if (!moov) return [];

    // 优先选 hdlr 声明为 video 的 trak，否则回退第一个 trak
    const tracks = boxes(u8, moov.start, moov.end).filter(b => b.type === TRAK);
    let trak: Box | null = tracks[0] ?? null;
    for (const t of tracks) {
        const mdia = findBox(u8, t, MDIA);
        const hdlr = mdia ? findBox(u8, mdia, HDLR) : null;
        if (hdlr && readUint(u8, hdlr.start + 8, 4) === FIV) { trak = t; break; }
    }
    if (!trak) return [];

    const mdia = findBox(u8, trak, MDIA);
    const minf = mdia ? findBox(u8, mdia, MINF) : null;
    const stbl = minf ? findBox(u8, minf, STBL) : null;
    if (!stbl) return [];
    // timescale 在 mdhd 内（mdia 的直接子 box），不能直接读 mdia
    const mdhd = mdia ? findBox(u8, mdia, MDHD) : null;
    const timescale = mdhd ? mdhdTimescale(u8, mdhd) : 0;

    const stts = findBox(u8, stbl, STTS);
    const stss = findBox(u8, stbl, STSS);
    if (!stts || timescale <= 0) return [];
    if (!stss) return []; // 无同步样本表 → 所有样本均为同步样本，无独立关键帧概念

    // stss：收集关键帧样本号（1-based）
    let pos = stss.start + 4;
    const entryCount = readUint(u8, pos, 4);
    pos += 4;
    const sampleNos: number[] = [];
    for (let i = 0; i < entryCount; i++) {
        const n = readUint(u8, pos, 4);
        pos += 4;
        if (n >= 1) sampleNos.push(n);
    }
    if (sampleNos.length === 0) return [];
    sampleNos.sort((a, b) => a - b);

    // stts：读取各 run 的（样本数, 时长）
    pos = stts.start + 4;
    const sttsCount = readUint(u8, pos, 4);
    pos += 4;
    const out: number[] = [];

    if (sttsCount === 1) {
        // 固定帧率：样本等长，样本 n 起始时间 = (n-1) * delta / timescale，
        // 直接由样本号换算，无需展开 O(样本数) 数组
        const count = readUint(u8, pos, 4);
        const delta = readUint(u8, pos + 4, 4);
        for (const n of sampleNos) {
            if (n <= count) out.push(((n - 1) * delta) / timescale);
        }
    } else {
        // 可变帧率：按 run 累加，命中目标样本号即记录，全部命中后提前结束
        let sampleIdx = 0;
        let acc = 0;
        let ptr = 0;
        for (let i = 0; i < sttsCount && ptr < sampleNos.length; i++) {
            const count = readUint(u8, pos, 4);
            const delta = readUint(u8, pos + 4, 4);
            pos += 8;
            for (let j = 0; j < count && ptr < sampleNos.length; j++) {
                while (ptr < sampleNos.length && sampleNos[ptr] === sampleIdx + 1) {
                    out.push(acc / timescale);
                    ptr++;
                }
                if (ptr >= sampleNos.length) break;
                acc += delta;
                sampleIdx++;
            }
        }
    }
    out.sort((a, b) => a - b);
    return out;
}

/* ===== Matroska (MKV / WebM) 解析 ===== */

function parseMatroska(u8: Uint8Array): number[] {
    const kfs: number[] = [];
    for (const el of children(u8, 0, u8.length)) {
        if (el.id === SEGMENT) {
            parseSegment(u8, el.start, el.end, kfs);
            break;
        }
    }
    return kfs;
}

function parseSegment(u8: Uint8Array, start: number, end: number, kfs: number[]) {
    let timecodeScale = 1_000_000; // ns/刻度，默认 1ms
    let videoTrack = -1;
    for (const el of children(u8, start, end)) {
        if (el.id === TIMECODE_SCALE) {
            timecodeScale = readUintField(u8, el.start, el.end - el.start);
        } else if (el.id === TRACKS) {
            videoTrack = scanVideoTrack(u8, el.start, el.end);
        } else if (el.id === CLUSTER && videoTrack >= 0) {
            scanCluster(u8, el.start, el.end, timecodeScale, videoTrack, kfs);
        }
    }
}

function scanVideoTrack(u8: Uint8Array, start: number, end: number): number {
    for (const entry of children(u8, start, end)) {
        if (entry.id !== TRACK_ENTRY) continue;
        let trackNo = -1;
        let type = 0;
        for (const c of children(u8, entry.start, entry.end)) {
            if (c.id === TRACK_NUMBER) {
                trackNo = readUintField(u8, c.start, c.end - c.start);
            } else if (c.id === TRACK_TYPE) {
                type = u8[c.start] ?? 0;
            }
        }
        if (trackNo >= 0 && type === 1) return trackNo; // 1 = video
    }
    return -1;
}

function scanCluster(u8: Uint8Array, start: number, end: number, scale: number, videoTrack: number, kfs: number[]) {
    let clusterTimecode = 0;
    for (const el of children(u8, start, end)) {
        if (el.id === TIMECODE) {
            clusterTimecode = readUintField(u8, el.start, el.end - el.start);
        } else if (el.id === SIMPLE_BLOCK) {
            parseBlock(u8, el.start, el.end, scale, clusterTimecode, videoTrack, kfs, true);
        } else if (el.id === BLOCK_GROUP) {
            let blockStart = -1;
            let hasRef = false;
            for (const c of children(u8, el.start, el.end)) {
                if (c.id === BLOCK) blockStart = c.start;
                else if (c.id === REFERENCE_BLOCK) hasRef = true;
            }
            // 无 ReferenceBlock 的 Block 视为关键帧
            if (blockStart >= 0 && !hasRef) parseBlock(u8, blockStart, el.end, scale, clusterTimecode, videoTrack, kfs, false);
        }
    }
}

function parseBlock(u8: Uint8Array, start: number, end: number, scale: number, clusterTimecode: number, videoTrack: number, kfs: number[], isSimple: boolean) {
    const tv = readVint(u8, start);
    if (!tv || tv.value !== videoTrack) return;
    let pos = start + tv.size;
    if (pos + 2 > end) return;
    const rel = readInt16(u8, pos);
    if (isSimple) {
        pos += 2;
        if (pos >= end || (u8[pos] & 0x80) === 0) return; // 非关键帧
    }
    // Cluster Timecode 以 TimecodeScale 为单位，SimpleBlock 时间戳固定为毫秒
    const sec = clusterTimecode * scale / 1e9 + rel / 1000;
    if (sec >= 0) kfs.push(sec);
}
