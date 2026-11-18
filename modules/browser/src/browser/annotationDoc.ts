/**
 * 网页标注的 Markdown 序列化/解析（纯函数，无 obsidian 依赖——单测直接覆盖）。
 * 行格式：
 *   - [引用文字](url#syann=<id>) <!--syann:<base64 元数据>-->
 *   嵌套 4 空格子列表项 = 批注正文。
 */

export interface AnnItem {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  /** 批注文字（笔记里锚点条目的嵌套子项） */
  note: string;
  created: number;
  /** 高亮颜色（yellow/green/blue/pink/purple） */
  color?: string;
  /** 标签 */
  tags?: string[];
  /** 标注类型：缺省 = 文字标注；rect = 框选截图标注 */
  kind?: "text" | "rect";
  /** 框选矩形的**文档坐标**（页内 overlay 持久定位用） */
  rect?: { x: number; y: number; w: number; h: number };
  /** 框选截图的 vault 相对路径（PNG） */
  shot?: string;
  /** 已取消高亮（重开页面不再包裹；标注数据保留） */
  hlOff?: boolean;
  /** 已取消批注小字 */
  inlineOff?: boolean;
}

/** 每条标注落在行内的元数据（base64 前的 JSON 形状） */
export interface AnnMeta {
  id: string;
  url: string;
  quote: string;
  prefix: string;
  suffix: string;
  created: number;
  color: string;
  tags: string[];
  kind?: "text" | "rect";
  rect?: { x: number; y: number; w: number; h: number };
  shot?: string;
  hlOff?: boolean;
  inlineOff?: boolean;
}

export function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

export function b64encodeUtf8(s: string): string {
  try {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  } catch {
    return "";
  }
}

function b64decodeUtf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

export function stamp(d = new Date()): string {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function stampTime(d = new Date()): string {
  return stamp(d) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
export { stampTime as formatTimestamp };

/** markdown 链接文本转义：[] 会让解析器提前断链 */
export function escapeLinkText(t: string): string {
  return String(t).replace(/([[\]])/g, "\\$&");
}

export function unescapeLinkText(t: string): string {
  return String(t).replace(/\\([[\]])/g, "$1");
}

/** 文件名清洗（Windows 非法字符 + 控制长度） */
export function safeTitle(t: string): string {
  let s = String(t || "").replace(/[\\/:*?"<>|#^]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) s = "未命名页面";
  return s.slice(0, 60);
}

/**
 * 解析一行标注锚点：
 *   - [文字](url#syann=id) <!--syann:B64-->     （选区标注）
 *   - [文字](url) - 时间 <!--syann:B64-->        （页面级标注）
 * 返回 null = 不是标注行（frontmatter、来源行、普通内容）。
 */
export function parseAnnAnchor(line: string): { linkText: string; url: string; id: string; hasFragment: boolean; meta: AnnMeta | null } | null {
  if (!/^- \[/.test(line)) return null;
  let j = 3;
  if (line[2] !== "[") return null;
  let buf = "";
  while (j < line.length) {
    const c = line[j];
    if (c === "\\" && j + 1 < line.length) {
      buf += line[j + 1];
      j += 2;
      continue;
    }
    if (c === "]") break;
    buf += c;
    j++;
  }
  if (line.slice(j, j + 2) !== "](") return null;
  const linkText = buf;
  j += 2;
  const close = line.indexOf(")", j);
  if (close < 0) return null;
  const target = line.slice(j, close);
  const rest = line.slice(close + 1);
  const idMatch = /#syann=([\w-]+)/.exec(target);
  const b64Match = /<!--syann:([A-Za-z0-9+/=]+)-->/.exec(rest);
  if (!idMatch && !b64Match) return null;
  let meta: AnnMeta | null = null;
  if (b64Match) {
    try {
      const raw = JSON.parse(b64decodeUtf8(b64Match[1])) as Partial<AnnMeta>;
      if (raw && typeof raw === "object" && raw.id) {
        meta = {
          id: String(raw.id),
          url: String(raw.url ?? target.replace(/#syann=[\w-]+$/, "")),
          quote: String(raw.quote ?? ""),
          prefix: String(raw.prefix ?? ""),
          suffix: String(raw.suffix ?? ""),
          created: Number(raw.created) || 0,
          color: String(raw.color || "yellow"),
          tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
          kind: raw.kind === "rect" ? "rect" : undefined,
          rect:
            raw.rect && typeof raw.rect === "object"
              ? {
                  x: Number(raw.rect.x) || 0,
                  y: Number(raw.rect.y) || 0,
                  w: Number(raw.rect.w) || 0,
                  h: Number(raw.rect.h) || 0,
                }
              : undefined,
          shot: String(raw.shot ?? "") || undefined,
          hlOff: raw.hlOff === true,
          inlineOff: raw.inlineOff === true,
        };
      }
    } catch {
      /* 坏 JSON 按无元数据处理 */
    }
  }
  const id = (idMatch && idMatch[1]) || (meta && meta.id) || "";
  if (!id) return null;
  return {
    linkText,
    url: target.replace(/#syann=[\w-]+$/, ""),
    id,
    hasFragment: !!idMatch,
    meta,
  };
}

/** 重建一行锚点（applyMeta 改颜色/标签后原位重写，不动行内其它内容）。
 *  注意 parseAnnAnchor 返回的 linkText 是**解转义**的，重建时必须重新转义——
 *  否则含 [] 的引用在重建行里裸奔，下一轮解析会在第一个裸 ] 处断链（实测）。 */
export function rebuildAnchorLine(line: string, meta: AnnMeta): string {
  const parsed = parseAnnAnchor(line);
  if (!parsed) return line;
  const b64 = b64encodeUtf8(JSON.stringify(meta));
  const hasFragment = parsed.hasFragment;
  return (
    "- [" +
    escapeLinkText(parsed.linkText) +
    "](" +
    parsed.url +
    (hasFragment ? "#syann=" + meta.id : "") +
    ") <!--syann:" +
    b64 +
    "-->"
  );
}

/** 从笔记全文解析全部标注锚点（含嵌套批注）——单测直接覆盖的纯函数 */
export function parseAnnotationDoc(text: string): AnnItem[] {
  const lines = String(text || "").split("\n");
  const items: AnnItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseAnnAnchor(lines[i]);
    if (!parsed) continue;
    const meta = parsed.meta;
    const noteLines: string[] = [];
    let shotEmbed = "";
    let j = i + 1;
    while (j < lines.length && /^[ \t]/.test(lines[j]) && lines[j].trim()) {
      const nested = lines[j].replace(/^ {4}/, "").replace(/^- /, "").trimStart();
      // 框选截图嵌入行（Obsidian wikilink embed ![[路径]]）：元数据已带 shot
      // 路径，这里只记录、不混进批注正文
      if (/^!\[\[/.test(nested)) shotEmbed = nested.replace(/^!\[\[/, "").replace(/\]\]$/, "").trim();
      else noteLines.push(nested);
      j++;
    }
    items.push({
      id: parsed.id,
      // 有元数据时完全信任它（页面级标注 quote 本来就该是空串，
      // 不能回落到链接文本——链接文本是页面标题）
      quote: meta ? meta.quote : unescapeLinkText(parsed.linkText),
      prefix: (meta && meta.prefix) || "",
      suffix: (meta && meta.suffix) || "",
      note: noteLines.join("\n").trim(),
      created: (meta && meta.created) || 0,
      color: (meta && meta.color) || "yellow",
      tags: (meta && meta.tags) || [],
      kind: (meta && meta.kind) || undefined,
      rect: meta && meta.rect ? { ...meta.rect } : undefined,
      shot: (meta && meta.shot) || shotEmbed || undefined,
      hlOff: meta ? meta.hlOff === true : undefined,
      inlineOff: meta ? meta.inlineOff === true : undefined,
    });
    i = j - 1;
  }
  return items;
}
