import type { App, TFile } from "obsidian";

/**
 * 同笔记多录音的显式绑定（移植自 obsidian-audio-timestamp-player，0BSD）。
 *
 * 声明侧（与嵌入同一行的 Obsidian 注释）：
 *   ![[part1.mp3]] %%audio-id: part1%%
 * 引用侧（Markdown 链接，锚点携带时间与可选别名）：
 *   [00:13](#audio-time=00:13&audio=part1)
 *
 * 别名不区分大小写；同行声明只分配给该行第一个嵌入；未带别名的引用在
 * 笔记有多个同类媒体时视为歧义（拒绝播放并提示），唯一时自动选中。
 */

export type MediaType = "audio" | "video";

/** 各类媒体的嵌入扩展名（基底 hasMediaEmbed 正则的超集） */
const EXTENSIONS: Record<MediaType, string> = {
    audio: "mp3|wav|m4a|ogg|flac|3gp|aac|opus|webm",
    video: "mp4|webm|ogv|mov|m4v|avi|mkv|mpeg",
};

export interface MediaReference {
    id: string | null;
    sourceLink: string;
    type: MediaType;
}

export interface MediaBinding extends MediaReference {
    file: TFile;
}

export type MediaSelectionResult =
    | { binding: MediaBinding; error: null }
    | { binding: null; error: "none" | "ambiguous" | "duplicate" | "unknown" };

/** 扫描笔记内容，按行提取媒体嵌入及同行 `%%<type>-id: alias%%` 声明 */
export function extractMediaReferences(content: string, type: MediaType): MediaReference[] {
    const references: MediaReference[] = [];
    const embedPattern = new RegExp(
        `!\\[\\[([^\\]|#]+\\.(?:${EXTENSIONS[type]}))(?:[^\\]]*)\\]\\]`,
        "gi",
    );
    const idPattern = new RegExp(
        `%%\\s*${type}-id\\s*:\\s*([A-Za-z0-9][A-Za-z0-9_-]{0,31})\\s*%%`,
        "i",
    );

    for (const line of content.split(/\r?\n/)) {
        const matches = Array.from(line.matchAll(embedPattern));
        if (matches.length === 0) continue;

        const mediaId = idPattern.exec(line)?.[1]?.toLowerCase() ?? null;
        for (const [index, match] of matches.entries()) {
            const sourceLink = match[1];
            if (!sourceLink) continue;
            references.push({
                id: index === 0 ? mediaId : null,
                sourceLink,
                type,
            });
        }
    }
    return references;
}

/** 把嵌入链接解析为 vault 文件（走 Obsidian 链接解析规则） */
export async function resolveMediaBindings(
    app: App,
    note: TFile,
    content: string,
    type: MediaType,
): Promise<MediaBinding[]> {
    const bindings: MediaBinding[] = [];
    for (const reference of extractMediaReferences(content, type)) {
        const file = app.metadataCache.getFirstLinkpathDest(reference.sourceLink, note.path);
        if (file) bindings.push({ ...reference, file });
    }
    return bindings;
}

/**
 * 归属决策：
 * - 带别名：重复声明 → duplicate（拒绝回退）；按小写精确查找；找不到 → unknown
 * - 不带别名：唯一 → 自动选中；多个 → ambiguous
 */
export function selectMediaBinding(
    bindings: MediaBinding[],
    mediaId: string | null,
): MediaSelectionResult {
    if (bindings.length === 0) return { binding: null, error: "none" };

    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();
    for (const binding of bindings) {
        if (!binding.id) continue;
        if (seenIds.has(binding.id)) duplicateIds.add(binding.id);
        seenIds.add(binding.id);
    }

    if (mediaId) {
        const normalizedId = mediaId.toLowerCase();
        if (duplicateIds.has(normalizedId)) return { binding: null, error: "duplicate" };
        const binding = bindings.find((candidate) => candidate.id === normalizedId) ?? null;
        return binding ? { binding, error: null } : { binding: null, error: "unknown" };
    }

    const onlyBinding = bindings[0];
    return bindings.length === 1 && onlyBinding
        ? { binding: onlyBinding, error: null }
        : { binding: null, error: "ambiguous" };
}

export interface ParsedTimestamp {
    seconds: number;
    label: string;
    mediaType: MediaType;
    mediaId: string | null;
}

/** 链接锚点中的时间段：`HH:mm:ss(.SSS)`，时/分限 1-3 位、秒限 2 位，毫秒可选 */
const LINK_TS_RE = /#(audio|video)-time=(\d{1,3}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(?=$|&)/i;
const LINK_TS_FULL_RE = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/;
const VALID_MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * 解析链接目标（href / data-href）中的时间戳。
 * 支持 URL 编码与 `&amp;` 还原；`&audio=` / `&video=` 段携带媒体别名，
 * 与锚点类型不一致的别名段被忽略（`#video-time=00:13&audio=x` → mediaId=null）。
 */
export function parseTimestampLink(target: string): ParsedTimestamp | null {
    let decodedTarget: string;
    try {
        decodedTarget = decodeURIComponent(target);
    } catch {
        decodedTarget = target;
    }

    const normalizedTarget = decodedTarget.replaceAll("&amp;", "&");
    const match = LINK_TS_RE.exec(normalizedTarget);
    if (!match) return null;

    const mediaType = match[1].toLowerCase() as MediaType;
    const second = Number(match[3]);
    const third = match[4] === undefined ? null : Number(match[4]);
    if (second > 59 || (third !== null && third > 59)) return null;

    const timeStr = match[0].slice(`#${match[1]}-time=`.length);
    const full = timeStr.match(LINK_TS_FULL_RE);
    if (!full) return null;
    const [, h, mm, ss, ms] = full;
    const seconds = (Number(h) || 0) * 3600
        + (Number(mm) || 0) * 60
        + (Number(ss) || 0)
        + (ms ? parseFloat(`0.${ms}`) : 0);

    const fragment = normalizedTarget.slice(match.index);
    const idPattern = new RegExp(`(?:^|&)${mediaType}=([^&#\\s]*)`, "i");
    const rawMediaId = idPattern.exec(fragment)?.[1];
    if (rawMediaId !== undefined && !VALID_MEDIA_ID_RE.test(rawMediaId)) return null;

    return { seconds, label: timeStr, mediaType, mediaId: rawMediaId?.toLowerCase() ?? null };
}

/** 按「笔记路径 + mtime」缓存的绑定索引，vault 变更时失效 */
export class MediaBindingIndex {
    private readonly cache = new Map<string, { mtime: number; bindings: MediaBinding[] }>();

    constructor(private readonly app: App) {}

    async getBindings(note: TFile, type: MediaType): Promise<MediaBinding[]> {
        const key = `${type}:${note.path}`;
        const cached = this.cache.get(key);
        if (cached && cached.mtime === note.stat.mtime) return cached.bindings;

        const content = await this.app.vault.cachedRead(note);
        const bindings = await resolveMediaBindings(this.app, note, content, type);
        this.cache.set(key, { mtime: note.stat.mtime, bindings });
        return bindings;
    }

    invalidate(path?: string): void {
        if (!path) {
            this.cache.clear();
            return;
        }
        for (const mediaType of ["audio", "video"] as const) {
            this.cache.delete(`${mediaType}:${path}`);
        }
    }
}
