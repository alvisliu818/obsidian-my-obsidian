/**
 * 虚拟链接词库索引(fakelink/Virtual Linker 语义吸收,2026-11-19):
 * 从 metadataCache 收集「可被虚拟链接的词」——笔记 basename、frontmatter
 * aliases、各级标题(剥编号后一并收录)——产出 Trie + 词条组。
 *
 * 上游对照(linker/linkerCache.ts):
 *  - 词条全部来自 metadataCache(无手动读盘);刷新靠 resolved/changed 事件
 *    防抖重建(上游 ExternalUpdateManager 50ms + 分片,这里 1.2s 防抖一次
 *    全量——metadataCache 读取是内存操作,千级文件单趟毫秒级);
 *  - 排除:全局排除词(settings)、目录前缀(settings)、frontmatter
 *    `linker-exclude`(上游同名键 parity)、长度 <2 的词不入索引;
 *  - 标题匹配键剥编号(「1.」「三、」「（四)」),headerId 保留原文;
 *  - 大小写:基线全小写匹配(上游 per-note case 标签 v1 未移植)。
 *
 * 事件驱动:`resolved`(初始索引/全库解析完成)与 `changed`(单文件元数据
 * 变更)→ scheduleRebuild。快照不可变:扫描面(渲染后处理器/CM 装饰)读
 * `snapshot()`,重建完成后原子替换,读侧无锁。
 */

import type { App, TFile } from 'obsidian';
import { emptyTrie, isIndexableKeyword, type VirtualLinkTerm, type VirtualLinkScanOptions, type TrieNode } from './virtualLinkScan';

/** 索引需要的宿主面(避免与 main.ts 循环依赖)。 */
export interface VirtualLinkIndexHost {
  app: App;
  settings: {
    virtualLinksEnabled: boolean;
    virtualLinksIncludeAliases: boolean;
    virtualLinksIncludeHeaders: boolean;
    virtualLinksExcludedKeywords: string;
    virtualLinksExcludedDirectories: string;
    virtualLinksMatchBeginningOfWords: boolean;
    virtualLinksMatchEndOfWords: boolean;
    virtualLinksMatchAnyPartsOfWords: boolean;
  };
}

export interface VirtualLinkSnapshot {
  trie: TrieNode;
  /** key(小写)→ 词条组(同词多文件/多形态,note > alias > header 之外无序) */
  terms: Map<string, VirtualLinkTerm[]>;
  scanOptions: VirtualLinkScanOptions;
  /** 词条总数(调试/状态栏用) */
  size: number;
}

/** fakelink parity:frontmatter 开关键(排除单个文件参与虚拟链接)。 */
const FM_EXCLUDE_KEY = 'linker-exclude';

/** 标题编号剥离(上游 stripHeadingNumber 的常用子集:1./2、/3)/三、/（四)等)。 */
const HEADING_NUMBER_RE = /^\s*(?:\d{1,3}\s*[.、)]\s*|[一二三四五六七八九十百]+\s*[、.]\s*|[一二三四五六七八九十百]+(?=\s)|（\s*[一二三四五六七八九十百]+\s*）\s*|\(\s*[一二三四五六七八九十百]+\s*\)\s*)/;

export function stripHeadingNumber(heading: string): string {
  return heading.replace(HEADING_NUMBER_RE, '').trim();
}

function parseList(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(/[\n,;，；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeAliases(aliases: unknown): string[] {
  if (typeof aliases === 'string') return aliases.trim() ? [aliases.trim()] : [];
  if (Array.isArray(aliases)) return aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim());
  return [];
}

export class VirtualLinkIndex {
  private snapshot_: VirtualLinkSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rebuilding = false;
  private dirty = false;

  constructor(private readonly host: VirtualLinkIndexHost) {}

  /** 当前快照(可能为 null=尚未建好;扫描面拿到 null 就不装饰)。 */
  snapshot(): VirtualLinkSnapshot | null {
    return this.snapshot_;
  }

  /** 防抖重建(事件风暴合并;重建进行中再来只标脏,完成后补一轮)。 */
  scheduleRebuild(): void {
    if (!this.host.settings.virtualLinksEnabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.rebuild();
    }, 1200);
  }

  /** 重建词库(metadataCache 全量一趟,内存操作,无 IO)。 */
  async rebuild(): Promise<void> {
    if (this.rebuilding) {
      this.dirty = true;
      return;
    }
    this.rebuilding = true;
    try {
      const snapshot = this.buildNow();
      this.snapshot_ = snapshot;
      if (this.dirty) {
        this.dirty = false;
        // 建库期间又有变更:立即再补一轮(不防抖)。
        const again = this.buildNow();
        this.snapshot_ = again;
      }
    } finally {
      this.rebuilding = false;
    }
  }

  private buildNow(): VirtualLinkSnapshot {
    const settings = this.host.settings;
    const excludedKeywords = new Set(parseList(settings.virtualLinksExcludedKeywords).map((s) => s.toLowerCase()));
    const excludedDirs = parseList(settings.virtualLinksExcludedDirectories);
    const terms = new Map<string, VirtualLinkTerm[]>();
    const trie = emptyTrie();

    const add = (raw: string, path: string, kind: VirtualLinkTerm['kind'], header?: string): void => {
      const key = raw.toLowerCase().trim();
      if (!isIndexableKeyword(key)) return;
      if (excludedKeywords.has(key)) return;
      const list = terms.get(key) ?? [];
      const term: VirtualLinkTerm = { path, kind, header };
      if (list.some((t) => t.path === path && t.kind === kind && t.header === header)) return;
      list.push(term);
      terms.set(key, list);
      trieInsertOnce(trie, key);
    };

    const files = this.host.app.vault.getMarkdownFiles() as TFile[];
    for (const file of files) {
      if (excludedDirs.some((dir) => file.path.startsWith(dir) || file.path.startsWith(dir.replace(/\/+$/, '') + '/'))) continue;
      const cache = this.host.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      // fakelink parity:frontmatter `linker-exclude: true` 整文件不参与。
      const fm = cache.frontmatter as Record<string, unknown> | null;
      if (fm && fm[FM_EXCLUDE_KEY] === true) continue;

      add(file.basename, file.path, 'note');
      if (settings.virtualLinksIncludeAliases) {
        for (const alias of normalizeAliases(fm?.aliases)) add(alias, file.path, 'alias');
      }
      if (settings.virtualLinksIncludeHeaders) {
        for (const h of cache.headings ?? []) {
          const raw = h.heading.trim();
          if (!raw) continue;
          add(raw, file.path, 'header', raw);
          const stripped = stripHeadingNumber(raw);
          if (stripped && stripped !== raw) add(stripped, file.path, 'header', raw);
        }
      }
    }

    return {
      trie,
      terms,
      scanOptions: {
        matchBeginningOfWords: settings.virtualLinksMatchBeginningOfWords === true,
        matchEndOfWords: settings.virtualLinksMatchEndOfWords === true,
        matchAnyPartsOfWords: settings.virtualLinksMatchAnyPartsOfWords === true,
      },
      size: terms.size,
    };
  }
}

/** trieInsert 的去重包装:Trie 本身幂等,这里只是语义占位(未来带 canonical)。 */
function trieInsertOnce(trie: TrieNode, key: string): void {
  let node = trie;
  for (const ch of key) {
    let child = node.children.get(ch);
    if (!child) {
      child = { children: new Map(), hit: false };
      node.children.set(ch, child);
    }
    node = child;
  }
  node.hit = true;
}
