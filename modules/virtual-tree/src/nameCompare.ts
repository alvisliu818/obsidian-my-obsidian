/**
 * 名称排序：对齐 Windows 资源管理器的「按名称」顺序（StrCmpLogicalW）。
 *
 * 用户 2026-11-27 再次报告虚拟文档树与资源管理器排序不一致。旧实现只按
 * **首字符**分组「ASCII 先于 CJK」，字符串中段出现 CJK 时仍按 locale collator
 * 排在 ASCII 前（`05_尚硅谷…` 排到 `05_FastAPIProject` 前），数字前导零、连字符
 * 等规则也与资源管理器不同。
 *
 * StrCmpLogicalW 实测语义（Windows 11 / zh-CN，2026-11-27 探针）：
 *  - 大小写不敏感；
 *  - ASCII 主序：空格 . / : … > 0-9 > a-z（见 PUNCT_ORDER，标点 < 数字 < 字母）；
 *  - 数字串按数值比较；数值相等时前导零多的排前面（01 < 1）；
 *  - `-` 与 `'` 在比较中忽略，整串同序时带忽略字符的更长者排后面；
 *  - 任意位置：ASCII/全角/带音标拉丁 < 非 ASCII 符号 < emoji < CJK
 *    （全角字符与带音标字母折算到 ASCII 基字符，且排在原 ASCII 之后）；
 *  - Han/假名/谚文之间按系统 locale 的 collator（中文＝拼音）比较。
 *
 * 「文件夹优先」不在这里做：调用方（mountPanel / vaultExplorer / mountFilter）
 * 已先按 isDir 分组。共享一个 Collator 实例——排序在每次渲染都会跑。
 */
const collator = new Intl.Collator(undefined, { usage: 'sort', sensitivity: 'base', numeric: true });

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const LETTER_RE = /\p{L}/u;

/** Windows 下可打印 ASCII 的主序（撇号/连字符被忽略，故不在表内）。 */
const PUNCT_ORDER = " !\"#$%&()*,./:;?@[\\]^_`{|}~+<=>";
const PUNCT_WEIGHT = new Map<number, number>();
for (let i = 0; i < PUNCT_ORDER.length; i++) PUNCT_WEIGHT.set(PUNCT_ORDER.charCodeAt(i), i);

const W_SYMBOL = PUNCT_ORDER.length + 0.5; // 30.5：非 ASCII 符号排在数字前
const W_DIGIT = PUNCT_ORDER.length + 1; // 31..40
const W_LETTER = W_DIGIT + 10; // 41..66
const W_OTHER_LETTER = W_LETTER + 26 + 0.5; // 66.5：西里尔/希腊等拉丁以外字母
const W_EMOJI = W_LETTER + 27; // 67
const W_HAN = 100;

interface CharWeight {
  /** 主序权重；相同权重才比较 secondary */
  weight: number;
  /** 0 = 原型（ASCII / 半角），1 = 全角或带音标变体，排在原型之后 */
  secondary: number;
}

function isAsciiDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

/** `-` 与 `'` 不参与比较（含全角/兼容形式，NFKC 后落到这两个 ASCII 字符）。 */
function isIgnored(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x2d || cp === 0x27) return true;
  if (cp > 0x7f) {
    const nk = ch.normalize('NFKC');
    if (nk.length === 1) {
      const nc = nk.codePointAt(0) ?? 0;
      return nc === 0x2d || nc === 0x27;
    }
  }
  return false;
}

function weightOf(ch: string): CharWeight {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x80) {
    if (isAsciiDigit(cp)) return { weight: W_DIGIT + (cp - 0x30), secondary: 0 };
    if (cp >= 0x41 && cp <= 0x5a) return { weight: W_LETTER + (cp - 0x41), secondary: 0 };
    if (cp >= 0x61 && cp <= 0x7a) return { weight: W_LETTER + (cp - 0x61), secondary: 0 };
    return { weight: PUNCT_WEIGHT.get(cp) ?? W_SYMBOL, secondary: 0 };
  }
  // 全角标点/字母/数字折算到 ASCII 基字符，排在原型之后（（ > (，Ａ > a，１ > 1）。
  const nk = ch.normalize('NFKC');
  if (nk.length === 1) {
    const nc = nk.codePointAt(0) ?? 0;
    if (nc < 0x80) {
      if (isAsciiDigit(nc)) return { weight: W_DIGIT + (nc - 0x30), secondary: 1 };
      if (nc >= 0x41 && nc <= 0x5a) return { weight: W_LETTER + (nc - 0x41), secondary: 1 };
      if (nc >= 0x61 && nc <= 0x7a) return { weight: W_LETTER + (nc - 0x61), secondary: 1 };
      return { weight: PUNCT_WEIGHT.get(nc) ?? W_SYMBOL, secondary: 1 };
    }
  }
  // 带音标拉丁字母（é/ñ/ü…）按基字母参与主序。
  const base = ch.normalize('NFD').replace(/\p{M}/gu, '');
  if (base.length === 1) {
    const bc = base.codePointAt(0) ?? 0;
    const lower = bc >= 0x41 && bc <= 0x5a ? bc + 0x20 : bc;
    if (lower >= 0x61 && lower <= 0x7a) return { weight: W_LETTER + (lower - 0x61), secondary: 1 };
  }
  if (CJK_RE.test(ch)) return { weight: W_HAN, secondary: 0 };
  if (EMOJI_RE.test(ch)) return { weight: W_EMOJI, secondary: 0 };
  if (LETTER_RE.test(ch)) return { weight: W_OTHER_LETTER, secondary: 0 };
  return { weight: W_SYMBOL, secondary: 0 };
}

/** 同权重内的次序：CJK/其他字母走 locale collator，符号与 emoji 走码位。 */
function bandCompare(a: string, b: string, weight: number): number {
  if (weight >= W_HAN || weight === W_OTHER_LETTER) return collator.compare(a, b);
  if (weight === W_SYMBOL || weight === W_EMOJI) {
    return (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0);
  }
  return 0;
}

/**
 * Windows 资源管理器同款名称比较。返回 <0 / 0 / >0，可直接喂给 Array#sort。
 * 文件夹优先由调用方处理；本函数对文件夹名与文件名一视同仁。
 */
export function compareNames(a: string, b: string): number {
  let i = 0;
  let j = 0;
  let secondary = 0; // 首个「全角/音标」次要差异；主序全等时才算数
  while (i < a.length && j < b.length) {
    const cpa = a.codePointAt(i) ?? 0;
    const cpb = b.codePointAt(j) ?? 0;
    const la = cpa > 0xffff ? 2 : 1;
    const lb = cpb > 0xffff ? 2 : 1;
    if (isAsciiDigit(cpa) && isAsciiDigit(cpb)) {
      let ie = i;
      while (ie < a.length && isAsciiDigit(a.codePointAt(ie) ?? 0)) ie++;
      let je = j;
      while (je < b.length && isAsciiDigit(b.codePointAt(je) ?? 0)) je++;
      const ra = a.slice(i, ie);
      const rb = b.slice(j, je);
      const va = ra.replace(/^0+/, '') || '0';
      const vb = rb.replace(/^0+/, '') || '0';
      if (va.length !== vb.length) return va.length < vb.length ? -1 : 1;
      if (va !== vb) return va < vb ? -1 : 1;
      // 数值相等：前导零多（串更长）的排前面，01 < 1。
      if (ra.length !== rb.length) return ra.length > rb.length ? -1 : 1;
      i = ie;
      j = je;
      continue;
    }
    const ca = a.slice(i, i + la);
    const cb = b.slice(j, j + lb);
    if (isIgnored(ca)) {
      i += la;
      continue;
    }
    if (isIgnored(cb)) {
      j += lb;
      continue;
    }
    const wa = weightOf(ca);
    const wb = weightOf(cb);
    if (wa.weight !== wb.weight) return wa.weight < wb.weight ? -1 : 1;
    const d = bandCompare(ca, cb, wa.weight);
    if (d) return d;
    if (!secondary && wa.secondary !== wb.secondary) secondary = wa.secondary - wb.secondary;
    i += la;
    j += lb;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  // 主序全等：带忽略字符（- / '）的整串更长，排后面（a-b > ab）。
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return secondary;
}
