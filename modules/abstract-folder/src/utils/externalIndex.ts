/**
 * 库外文件的抽象文件夹索引：frontmatter 解析 + 链接解析 + 挂载扫描。
 *
 * 库外文件不走 vault API（metadataCache 里根本没有它们），所以父/子关系只能
 * 自己拿：Node fs 扫挂载目录 → 读文本 → 解析 frontmatter → 解析链接目标。
 *
 * 分层：
 *   - 纯函数（parseFrontmatterBlock / extractLinkTexts / cleanLinkText /
 *     buildExternalLinkIndex / resolveExternalLink）：不 import obsidian、
 *     不碰 fs，本项目规则「被测代码不得 import obsidian」由这里保证，单测
 *     直接跑（npm run test:abstract-folder）。
 *   - fs 部分（listExternalMarkdownFiles / readExternalFrontmatter）：软依赖
 *     logseq 模块的 extFs / mountFilter（save-control 已建立的先例——静态
 *     import 纯函数，extFs 对 Node 模块是懒加载的，插件加载时安全）。
 */

import { scanExternal, readExternalText, readExternalTextHead } from '../../../logseq/src/features/extFs';
import { compileFilter, entryMatches, dirPruned } from '../../../logseq/src/features/mountFilter';

/** 一个参与抽象文件夹图的库外文件。键（FileGraph 里的 key）= abs。 */
export interface ExternalFileEntry {
  /** 磁盘绝对路径（graph 中的节点键，保留原始大小写）。 */
  abs: string;
  /** 文件名（含扩展名）。 */
  name: string;
  /** 相对挂载根的路径（/ 分隔）。 */
  rel: string;
  /** 来源挂载 id。 */
  mountId: string;
  mtime?: number;
  size?: number;
  /** frontmatter.icon（存在且为字符串时）。 */
  icon?: string;
  /** 解析出的 frontmatter（无 frontmatter 时为 {}）。 */
  frontmatter: Record<string, unknown>;
}

/** 扫描产物：还没读内容的库外 md 文件（读内容分块进行，别在 UI 线程一口气读完）。 */
export interface ExternalScanFile {
  abs: string;
  name: string;
  rel: string;
  mountId: string;
  mtime?: number;
  size?: number;
}

/** 参与扫描的挂载的最小形状（logseq 的 ExternalMount 的软依赖子集）。 */
export interface ExternalMountLite {
  id: string;
  path: string;
  include: string;
  exclude: string;
}

// ---------------------------------------------------------------------------
// 纯函数：frontmatter 解析
// ---------------------------------------------------------------------------

/**
 * 解析文件开头的 frontmatter 块，返回顶层键值。
 *
 * 只支持属性面板会写出的形状（这是抽象文件夹唯一需要的）：
 *   - `key: value`（值可带引号）
 *   - `key:` + 缩进的 `- value` 列表
 *   - `key: [a, b]` 流式列表
 * 嵌套映射、多行块标量（`|`/`>`）不解析（给空串/空列表占位）——属性面板
 * 写不出这种 parent/children/icon/title，不值得为此引入 YAML 依赖。
 * 没有合法的 `---` 开头/闭合时返回 null（调用方按无 frontmatter 处理）。
 */
export function parseFrontmatterBlock(text: string): Record<string, unknown> | null {
  const open = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*(\r?\n|$)/m.exec(rest);
  if (!close) return null;

  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of rest.slice(0, close.index).split(/\r?\n/)) {
    if (!line.trim()) continue;

    // 缩进行：只有当前键正等着收列表项时才有意义
    if (/^[ \t]/.test(line)) {
      const item = /^[-*][ \t]+(.*)$/.exec(line.trim());
      if (item && currentKey && currentList) currentList.push(cleanScalar(item[1]));
      continue;
    }

    // 顶层的裸列表项（没有键在等）——不是我们要的形状，丢弃
    if (/^[-*][ \t]/.test(line)) {
      currentKey = null;
      currentList = null;
      continue;
    }

    const kv = /^([^\s:][^:]*):[ \t]*(.*)$/.exec(line);
    if (!kv) {
      currentKey = null;
      currentList = null;
      continue;
    }
    currentKey = kv[1].trim();
    currentList = null;
    const raw = kv[2].trim();
    if (raw === '') {
      // 可能后面跟缩进列表；没有就留空列表（与空值等价）
      currentList = [];
      data[currentKey] = currentList;
    } else if (raw.startsWith('|') || raw.startsWith('>')) {
      data[currentKey] = ''; // 块标量内容不解析
      currentKey = null;
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      data[currentKey] = splitFlowList(raw.slice(1, -1)).map(cleanScalar);
    } else {
      data[currentKey] = cleanScalar(raw);
    }
  }
  return data;
}

/** 流式列表 `[a, b]` 的顶层逗号切分（引号/嵌套括号内的逗号不算）。 */
function splitFlowList(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted: string | null = null;
  let cur = '';
  for (const ch of body) {
    if (quoted) {
      cur += ch;
      if (ch === quoted) quoted = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoted = ch;
      cur += ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
      cur += ch;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() || out.length) out.push(cur);
  return out;
}

/** 去掉值两侧的成对引号。 */
function cleanScalar(s: string): string {
  let v = s.trim();
  if (v.length >= 2) {
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
  }
  return v.trim();
}

// ---------------------------------------------------------------------------
// 纯函数：链接抽取与解析
// ---------------------------------------------------------------------------

/**
 * 规整一个链接文本：去括号/引号、去别名（`[[a|b]]` → `a`）、去小节
 * （`[[a#h]]` / `[[a#^id]]` → `a`）。与 indexer 里库内路径的 cleanLink 同义，
 * 多了 `#` 切分（Obsidian 的 wikilink 语义）。
 */
export function cleanLinkText(raw: string): string {
  return raw
    .replace(/^["']+|["']+$/g, '')
    .replace(/\[\[|\]\]/g, '')
    .split('|')[0]
    .split('#')[0]
    .trim();
}

/**
 * 从 frontmatter 值里抽出全部链接目标。`[[..]]` 逐个取出；裸字符串（如
 * `parent: hidden` 或 `parent: Some Note`）原样算一个目标。
 */
export function extractLinkTexts(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (!v.trim()) return;
      const re = /\[\[([^\]]+)\]\]/g;
      let found = false;
      let m: RegExpExecArray | null;
      while ((m = re.exec(v))) {
        out.push(cleanLinkText(m[1]));
        found = true;
      }
      if (!found) out.push(cleanLinkText(v));
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item);
    }
  };
  visit(value);
  return out.filter(Boolean);
}

/** 库外链接的解析索引：挂载内相对路径 + 文件名两条路。 */
export interface ExternalLinkIndex {
  /** 规范化相对路径（小写、/ 分隔；含 .md 与去 .md 两种键）→ abs。 */
  byRel: Map<string, string>;
  /** 去扩展名的文件名（小写）→ abs 列表（重名都保留，取第一个）。 */
  byName: Map<string, string[]>;
}

export function buildExternalLinkIndex(entries: { rel: string; abs: string }[]): ExternalLinkIndex {
  const byRel = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const e of entries) {
    const norm = e.rel.replace(/\\/g, '/').toLowerCase();
    const bare = norm.endsWith('.md') ? norm.slice(0, -3) : norm;
    if (!byRel.has(bare)) byRel.set(bare, e.abs);
    byRel.set(norm, e.abs);
    const base = bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare;
    const list = byName.get(base);
    if (list) {
      if (!list.includes(e.abs)) list.push(e.abs);
    } else {
      byName.set(base, [e.abs]);
    }
  }
  return { byRel, byName };
}

/**
 * 把一个链接文本解析到库外文件（abs）。
 *
 * 解析顺序（库外文件优先，同挂载语境里它最具体）：
 *   1. 当作挂载内相对路径（含/不含 .md）；
 *   2. 相对源文件所在目录的路径；
 *   3. 全部挂载里的文件名。
 * Windows 路径大小写不敏感，索引与查找都小写化。
 */
export function resolveExternalLink(link: string, sourceRel: string, index: ExternalLinkIndex): string | null {
  const norm = cleanLinkText(link).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
  if (!norm) return null;
  const bare = norm.endsWith('.md') ? norm.slice(0, -3) : norm;

  for (const cand of [bare, norm]) {
    const hit = index.byRel.get(cand);
    if (hit) return hit;
  }
  const dir = sourceRel.replace(/\\/g, '/');
  const dirPart = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  if (dirPart) {
    const hit = index.byRel.get(`${dirPart}/${bare}`) ?? index.byRel.get(`${dirPart}/${bare}.md`);
    if (hit) return hit;
  }
  const byName = index.byName.get(bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare);
  return byName && byName.length > 0 ? byName[0] : null;
}

/** 抽象文件夹只认 markdown 笔记（代码文件没有 frontmatter 关系可言）。 */
export function isMarkdownName(name: string): boolean {
  return /\.md$/i.test(name);
}

/** frontmatter 里的图标（icon: FaFolder 这种）。 */
export function iconFromFrontmatter(fm: Record<string, unknown>): string | undefined {
  const v = fm.icon;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// fs 部分：扫描挂载（软依赖 logseq 模块的 extFs / mountFilter）
// ---------------------------------------------------------------------------

/**
 * 扫描全部挂载里的库外 md 文件（只列文件名，不读内容）。
 *
 * 挂载的 include/exclude 正则照 mount 面板的同一条规则生效；目录按 exclude
 * 剪枝（include 只对文件生效，与面板一致——文件能过 include 而其目录名
 * 不过，这种文件仍要能扫到）。读不到的目录/坏挂载静默跳过，不拖垮整体。
 */
export function listExternalMarkdownFiles(
  mounts: ExternalMountLite[],
): { files: ExternalScanFile[]; truncated: boolean } {
  const files: ExternalScanFile[] = [];
  let truncated = false;
  for (const m of mounts) {
    const filter = compileFilter({ include: m.include, exclude: m.exclude });
    const scan = scanExternal(m.path, {
      shouldEnterDir: (rel) => !dirPruned(rel, filter),
      keepFile: (rel, name) => isMarkdownName(name) && entryMatches(rel, filter),
    });
    if (scan.truncated) truncated = true;
    for (const e of scan.entries) {
      if (e.isDir) continue;
      files.push({
        abs: e.abs,
        name: e.name,
        rel: e.rel,
        mountId: m.id,
        mtime: e.mtime,
        size: e.size,
      });
    }
  }
  return { files, truncated };
}

/**
 * 读一个库外 md 的 frontmatter；读不到/解析不了返回 {}。
 *
 * 这里只需要文件头部的 YAML 块，但旧实现 readFileSync 全文——外部挂载
 * 目录里混着大 md 时，启动期全量索引把 renderer 堆顶崩（readFileSync +
 * toString 累计分配 ~380MB，白屏主因之一）。超过 512KB 的文件只读头部
 * 256KB：frontmatter 在文件头，功能无损；截断可能切坏一个码点，对
 * YAML 扫描无影响。
 */
export function readExternalFrontmatter(abs: string, size?: number): Record<string, unknown> {
  try {
    const text =
      size != null && size > 512_000
        ? readExternalTextHead(abs, 262_144)
        : readExternalText(abs);
    return parseFrontmatterBlock(text) ?? {};
  } catch {
    return {};
  }
}
