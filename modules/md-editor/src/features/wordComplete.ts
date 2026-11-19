/**
 * VC(Various Complements)式词补全源(md-editor 原生吸收,2026-11-19):
 * 随打随补的词候选,走 CM6 autocompletion 管线(与 [[ # (( 源同一套,无
 * editorSuggest 依赖)。
 *
 * VC 语义对照(data.json 用户配置):
 *  - minNumberOfCharactersTriggered: 2 → 前缀 ≥2 字符才触发;
 *  - matchStrategy prefix → 前缀命中(大小写不敏);fuzzyMatch v1 不做;
 *  - maxNumberOfSuggestions: 5 → 候选上限(默认 8);
 *  - firstCharactersDisableSuggestions "-#:/^@" → 词首字符在这些符号里
 *    不触发(列表标记/标签/时间/属性场景);
 *  - disableSuggestionsDuringImeOn → CM autocompletion 自带 IME 兼容
 *    (组合期间不出弹层),无需额外处理;
 *  - emoji 补全:`:name` 前缀 → gemoji 全集(与本模块 emojiShortcodesData
 *    同表),选中插入 emoji 字符。
 *
 * 候选来源(v1 收敛):
 *  - 当前文件词:本页块树文本的拉丁词(≥2 字符,按出现频次排序);
 *  - 全库词:metadataCache 的 basename/aliases/标题头(与虚拟链接索引同一
 *    口径,复用其快照——一次索引两处受益);
 *  - 自定义词典:settings 指定的库内文本文件(每行一词,可 `词<TAB>说明`
 *    带说明列),带 mtime 缓存。
 *
 * 有意收敛(v1):fuzzy/词干匹配、多词短语(maxNumberOfWordsAsPhrase)、
 * 历史频次加权(histories.json)未移植;当前文件 CJK 词不做全文抽取(误拆
 * 严重)——CJK 候选走词库索引的 curated 词条。
 */

import { syntaxTree } from '@codemirror/language';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { hintSuppressedAt } from './hintGuards';
import { EMOJI_SHORTCODES } from './emojiShortcodesData';
import type { BlockRenderHost } from '../blocks/renderHost';
import type { Block } from '../types';

/** VC firstCharactersDisableSuggestions 同款:词首为这些符号不触发。 */
const SUPPRESS_FIRST_CHARS = new Set(['-', '#', ':', '/', '^', '@']);

const WORD_PREFIX_RE = /[\p{L}\p{N}_-]{2,}$/u;
const EMOJI_PREFIX_RE = /:([a-zA-Z0-9_+-]+)$/;

const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9_-]+/g;

/** 当前文件词频统计(块树文本;>300k 字符的块跳过,整页预算 1MB——大文档不吃满)。 */
function collectCurrentFileWords(host: BlockRenderHost, freq: Map<string, number>): void {
  let budget = 1_000_000;
  const walk = (b: Block, depth: number): void => {
    if (depth > 50 || budget <= 0) return;
    const text = b.text ?? '';
    if (text.length > 300_000) return;
    budget -= text.length;
    LATIN_WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LATIN_WORD_RE.exec(text))) {
      const w = m[0];
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    for (const c of b.children ?? []) walk(c, depth + 1);
  };
  for (const root of host.doc?.blocks ?? []) {
    if (budget <= 0) return;
    walk(root, 0);
  }
}

/** 词典缓存:path → {mtime, words, details}。 */
const dictCache = new Map<string, { mtime: number; words: string[]; details: Map<string, string> }>();

async function loadDictionary(host: BlockRenderHost, path: string): Promise<{ words: string[]; details: Map<string, string> } | null> {
  if (!path) return null;
  try {
    const adapter = host.app.vault.adapter;
    const stat = await adapter.stat(path).catch(() => null);
    if (!stat) return null;
    const cached = dictCache.get(path);
    if (cached && cached.mtime === stat.mtime) return { words: cached.words, details: cached.details };
    const raw = await adapter.read(path);
    const words: string[] = [];
    const details = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // `词<TAB>说明` 或 `词 说明`(首个空白分隔;单列文件整行是词)
      const tabAt = trimmed.indexOf('\t');
      const spaceMatch = /\s/.exec(trimmed);
      const sep = tabAt >= 0 ? tabAt : spaceMatch ? spaceMatch.index : -1;
      if (sep > 0) {
        const w = trimmed.slice(0, sep).trim();
        const d = trimmed.slice(sep).trim();
        if (w) {
          words.push(w);
          if (d) details.set(w.toLowerCase(), d);
        }
      } else {
        words.push(trimmed);
      }
    }
    dictCache.set(path, { mtime: stat.mtime, words, details });
    return { words, details };
  } catch {
    return null;
  }
}

/** 光标上下文是否允许词补全(代码/链接内不触发;行首禁用字符守卫)。 */
function wordContextAllowed(ctx: CompletionContext, from: number, prefix: string): boolean {
  if (hintSuppressedAt(ctx.state, ctx.pos, true)) return false; // 行内代码内不触发(思源守卫)
  const tree = syntaxTree(ctx.state);
  let node = tree.resolveInner(ctx.pos, -1);
  while (node) {
    const name = node.name.toLowerCase();
    if (name.includes('code') || name.includes('link')) return false;
    node = node.parent as typeof node;
  }
  // VC firstCharactersDisableSuggestions:词首字符为 -#:/^@ 不触发
  if (prefix.length > 0 && SUPPRESS_FIRST_CHARS.has(prefix[0])) return false;
  void from;
  return true;
}

/**
 * 词补全源(emoji `:` 分支 + 词前缀分支)。settings.wordCompleteEnabled
 * 关闭时直接返回 null(键面让给其余来源)。
 */
export function wordCompletionSource(host: BlockRenderHost): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> => {
    const settings = host.plugin.settings;
    if (settings.wordCompleteEnabled === false) return null;

    // emoji 分支:`:name` 前缀(行内代码内不触发)
    const emojiBefore = ctx.matchBefore(EMOJI_PREFIX_RE);
    if (emojiBefore) {
      if (hintSuppressedAt(ctx.state, ctx.pos, true)) return null;
      const name = EMOJI_PREFIX_RE.exec(emojiBefore.text)?.[1] ?? '';
      const query = name.toLowerCase();
      const options: Completion[] = [];
      for (const key of Object.keys(EMOJI_SHORTCODES)) {
        if (query && !key.startsWith(query)) continue;
        const emoji = EMOJI_SHORTCODES[key];
        options.push({
          label: `${emoji} :${key}:`,
          apply: emoji,
          type: 'text',
          boost: 20, // 精确 shortcode 前缀比普通词优先
        });
        if (options.length >= (settings.wordCompleteMaxSuggestions ?? 8)) break;
      }
      if (!options.length) return null;
      return { from: emojiBefore.from, options, validFor: /^[a-zA-Z0-9_+-]*$/ };
    }

    // 词分支:前缀 ≥ min chars
    const before = ctx.matchBefore(WORD_PREFIX_RE);
    if (!before) return null;
    const minChars = Math.max(2, settings.wordCompleteMinChars ?? 2);
    const prefix = before.text;
    if (prefix.length < minChars) return null;
    if (!wordContextAllowed(ctx, before.from, prefix)) return null;
    const query = prefix.toLowerCase();

    const seen = new Set<string>();
    const options: Completion[] = [];
    const cap = settings.wordCompleteMaxSuggestions ?? 8;

    // vcWord 标记:词源补全不吞 Enter(completionYieldKeymap 检查)——块切分
    // 语义优先;Tab/点击仍接受。
    const push = (word: string, detail?: string, boost?: number): void => {
      const lower = word.toLowerCase();
      if (lower === query || seen.has(lower)) return;
      if (!lower.startsWith(query)) return;
      seen.add(lower);
      const c: Completion & { vcWord?: boolean } = { label: word, detail, type: 'text', boost, vcWord: true };
      options.push(c);
    };

    // 1) 当前文件词(频次降序)——含正在编辑的本块文本
    const freq = new Map<string, number>();
    collectCurrentFileWords(host, freq);
    const fileWords = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    for (const [w] of fileWords) {
      if (options.length >= cap) break;
      push(w, '本页', 10);
    }

    // 2) 全库词:虚拟链接索引快照(basename/alias/header 同口径)
    const snapshot = host.plugin.virtualLinkIndex?.snapshot();
    if (snapshot) {
      for (const key of snapshot.terms.keys()) {
        if (options.length >= cap) break;
        push(key, '词库');
      }
    }

    // 3) 自定义词典(异步源:CM 支持异步 completionSource——这里返回
    //    Promise,词典未命中时不出弹层)
    //    注:CM 的 source 可以直接返回 Promise<CompletionResult | null>。
    return (async (): Promise<CompletionResult | null> => {
      const dictPath = settings.wordCompleteDictionaryPath ?? '';
      if (dictPath) {
        const dict = await loadDictionary(host, dictPath);
        if (dict) {
          for (const w of dict.words) {
            if (options.length >= cap) break;
            push(w, dict.details.get(w.toLowerCase()));
          }
        }
      }
      if (!options.length) return null;
      return { from: before.from, options, validFor: /^[\p{L}\p{N}_-]*$/u };
    })();
  };
}
