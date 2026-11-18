/**
 * 虚拟链接扫描核心(fakelink/Virtual Linker 语义吸收,2026-11-19):
 * 把「光标前文本」按 Trie 逐字下降扫描,产出与词库词条命中的非重叠区间。
 *
 * 语义对照(上游 fakelink linker/linkerCache.ts 的 PrefixTree 状态机):
 *  - 词界 = 非 `\p{L}\p{N}`(数字算词字符——「科目二冲刺带背3」是一个词);
 *  - 双下标扫描同时尝试原字符与小写字符(大小写不敏基线);
 *  - 非空隔文字(Han/平假名/片假名/谚文,`UNSPACED_SCRIPT_RE`)强制回根——
 *    「牙痛」在「我牙痛了」中间也要命中;这类匹配恒为子串,忽略全部开关;
 *  - 接受矩阵(fakelink shouldAcceptWordMatch):整词(词界起+词界尾)恒收;
 *    前缀需 matchBeginningOfWords;后缀需 matchEndOfWords;中段仅
 *    matchAnyPartsOfWords;
 *  - 同位多候选最长优先(「欧拉方程是变量」里「欧拉方程」先于「欧拉」),
 *    全局重叠消解按 长度降序 → 起点升序 贪心保留(近似上游的
 *    filterOverlapping:长/精确者存活);
 *  - 扫描起点视为词界(resetSearch 同款),纯函数无 IO,单测直测。
 *
 * 与上游的有意分歧(均为 v1 收敛):
 *  - 无模糊/词干匹配(fakelink enableStemming/fuzzy 是加分项,后续按需);
 *  - 无 per-note 大小写门槛(requiresCaseMatch,「NASA」类词与普通词同规);
 *  - 同位多文件目标由调用方按 note > alias > header 优先级取一(上游的
 *    [1|2|3] 徽标多目标 UI 未移植)。
 */

/** 词条目标(索引侧产出;同 key 可对应多个文件/形态)。 */
export interface VirtualLinkTerm {
  path: string;
  kind: 'note' | 'alias' | 'header';
  /** kind=header 时的标题原文(跳转锚) */
  header?: string;
}

export interface VirtualLinkScanOptions {
  matchBeginningOfWords: boolean;
  matchEndOfWords: boolean;
  matchAnyPartsOfWords: boolean;
}

/** 上游同款:非空隔文字(CJK 系)恒子串匹配。 */
export const UNSPACED_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 上游同款:词界 = 非字母非数字(数字算词内)。 */
const NON_WORD_RE = /[^\p{L}\p{N}]/u;

/** 最短词条长度(上游 addFileWithName:名字 < 2 不入索引)。 */
export const MIN_KEYWORD_LENGTH = 2;

export interface TrieNode {
  children: Map<string, TrieNode>;
  /** 有词条终止于此(命中节点) */
  hit: boolean;
}

export function emptyTrie(): TrieNode {
  return { children: new Map(), hit: false };
}

/** 小写 key 逐字插入;重复插入幂等。 */
export function trieInsert(root: TrieNode, key: string): void {
  let node = root;
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

export interface VirtualLinkMatch {
  from: number;
  to: number;
  /** 命中的词条 key(小写;调用方查词条组取目标) */
  key: string;
}

interface Visited {
  node: TrieNode;
  /** 本候选匹配的起点(code-unit 偏移) */
  start: number;
  startsAtBoundary: boolean;
}

/**
 * 扫描一段文本,产出非重叠命中区间(升序)。Trie 逐字下降 + 词界回根 +
 * CJK 子串,接受矩阵同上游;重叠按 长度降序→起点升序 贪心消解。
 *
 * 坐标语义:live 里的节点 = 已消耗到 chars[i-1] 的 Trie 位置——
 *  - 收集在迭代 i 顶部做:命中区间终点 = chars[i].start(上一字符的尾),
 *    词尾判定看当前字符 chars[i];
 *  - 起点:根→子边的首次下降即匹配首字符(childStart = 当前字符位),
 *    非根下降继承起点;
 *  - 播种:词界字符为「下一字符起」播种(start = ch.end,本轮不下降);
 *    非空隔字符与 flag 播种为「当前字符起」(本轮即下降);
 *  - 扫描起点视为词界(初始 live = 根,start=0);
 *  - 循环后补一轮文末收集(to = text.length,词尾 = 文末)。
 */
export function scanVirtualLinks(text: string, root: TrieNode, opts: VirtualLinkScanOptions): VirtualLinkMatch[] {
  const candidates: VirtualLinkMatch[] = [];
  if (!text || root.children.size === 0) return candidates;

  // 按 codepoint 拆(代理对安全),记每个字符的 code-unit 区间。
  const chars: Array<{ ch: string; start: number; end: number }> = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    chars.push({ ch, start: i, end: i + ch.length });
    i += ch.length;
  }

  const pushCandidate = (v: Visited, to: number, endsAtBoundary: boolean): void => {
    const matched = text.slice(v.start, to);
    if (UNSPACED_SCRIPT_RE.test(matched)) {
      candidates.push({ from: v.start, to, key: matched.toLowerCase() });
      return;
    }
    const whole = v.startsAtBoundary && endsAtBoundary;
    if (whole) candidates.push({ from: v.start, to, key: matched.toLowerCase() });
    else if (v.startsAtBoundary) {
      if (opts.matchBeginningOfWords) candidates.push({ from: v.start, to, key: matched.toLowerCase() });
    } else if (endsAtBoundary) {
      if (opts.matchEndOfWords) candidates.push({ from: v.start, to, key: matched.toLowerCase() });
    } else if (opts.matchAnyPartsOfWords) {
      candidates.push({ from: v.start, to, key: matched.toLowerCase() });
    }
  };

  let live: Visited[] = [{ node: root, start: 0, startsAtBoundary: true }];
  for (let i = 0; i < chars.length; i++) {
    const { ch, start, end } = chars[i];
    const lower = ch.toLowerCase();
    const isBoundary = NON_WORD_RE.test(ch);

    // 1) 收集上一字符处终止的命中(live = 消耗到 chars[i-1] 的位置)。
    if (i > 0) {
      const endsAtBoundary = isBoundary;
      for (const v of live) {
        if (v.node.hit) pushCandidate(v, start, endsAtBoundary);
      }
    }

    // 2) 前进:回根播种 + 逐字下降(原字符/小写双试,上游 pushChar 同款)。
    const next: Visited[] = [];
    const queued = new Set<TrieNode>();
    const descendInputs: Visited[] = [];
    if (isBoundary) {
      // 词界:为下一字符播种(本轮不下降——边界字符不是匹配首字符)。
      if (!queued.has(root)) {
        queued.add(root);
        next.push({ node: root, start: end, startsAtBoundary: true });
      }
    } else {
      if (UNSPACED_SCRIPT_RE.test(ch)) descendInputs.push({ node: root, start, startsAtBoundary: true });
      else if (opts.matchAnyPartsOfWords || opts.matchEndOfWords) descendInputs.push({ node: root, start, startsAtBoundary: false });
    }
    for (const v of live) descendInputs.push(v);
    for (const v of descendInputs) {
      let child = v.node.children.get(ch);
      if (!child && lower !== ch) child = v.node.children.get(lower);
      if (!child) continue;
      // 根→子边的首次下降 = 匹配首字符:起点取当前字符位;词界旗标一律
      // 继承播种节点(词界/非空隔播种=true,flag 播种=false)。
      const childStart = v.node === root ? start : v.start;
      if (!queued.has(child)) {
        queued.add(child);
        next.push({ node: child, start: childStart, startsAtBoundary: v.startsAtBoundary });
      }
    }
    live = next;
  }

  // 3) 文末收集:live = 消耗到末字符的位置,词尾 = 文末。
  for (const v of live) {
    if (v.node.hit) pushCandidate(v, text.length, true);
  }

  return resolveOverlaps(candidates);
}

/**
 * 重叠消解:长度降序 → 起点升序贪心保留(长候选优先占位)。
 * 近似上游 filterOverlapping 的「长/精确者存活」。
 */
export function resolveOverlaps(matches: VirtualLinkMatch[]): VirtualLinkMatch[] {
  const sorted = [...matches].sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  const kept: VirtualLinkMatch[] = [];
  for (const m of sorted) {
    if (kept.some((k) => m.from < k.to && k.from < m.to)) continue;
    kept.push(m);
  }
  return kept.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** 词条 key 是否够格入索引(<2 字符跳过,上游同款)。 */
export function isIndexableKeyword(raw: string): boolean {
  return raw.length >= MIN_KEYWORD_LENGTH;
}
