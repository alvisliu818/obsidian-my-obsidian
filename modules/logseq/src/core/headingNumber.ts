/**
 * 标题编号（批次 24）：思源 kernel/model/heading_number.go 服务端算法 1:1 转译。
 * 思源把编号计算放在服务端（/api/outline/getDocHeadingNumbers），前端只渲染；
 * 我们是本地插件，同一算法落成纯函数，渲染前直接计算。
 *
 * 计数规则（buildHeadingNumbers）：文档序遍历标题，栈式 levels/counters——
 * 进入不深于栈顶的层级时一路弹出并截断计数（1.2.3 之后回到 1 级 → 2）。
 * 格式 preset 九种：六种层级 hierarchical（alpha/roman/greek × 大小写）+
 * decimal-parenthesized + chinese-document（一、（一）1.（1）① A. 混合）+
 * 默认 decimal hierarchical。counter 格式化超界（罗马>3999、圈数>20）一律
 * 回落十进制。编号 key 用块对象引用（新建块可能还没有 id prop）。
 */
import { headingLevel } from './fold';
import type { Block } from '../types';

export type HeadingNumberStyle =
  | 'decimal'
  | 'upper-alpha'
  | 'lower-alpha'
  | 'upper-roman'
  | 'lower-roman'
  | 'upper-greek'
  | 'lower-greek'
  | 'chinese'
  | 'circled';

export interface HeadingNumberPreset {
  styles: HeadingNumberStyle[];
  templates: string[];
}

const HIERARCHICAL_TEMPLATES = [
  '{1}',
  '{1}.{2}',
  '{1}.{2}.{3}',
  '{1}.{2}.{3}.{4}',
  '{1}.{2}.{3}.{4}.{5}',
  '{1}.{2}.{3}.{4}.{5}.{6}',
];

const hierarchicalPreset = (style: HeadingNumberStyle): HeadingNumberPreset => ({
  styles: Array.from({ length: 6 }, () => style),
  templates: HIERARCHICAL_TEMPLATES,
});

/** 思源 headingNumberPresetByID：九种格式（未知 id 回落 decimal hierarchical）。 */
export const headingNumberPresetByID = (id: string): HeadingNumberPreset => {
  switch (id) {
    case 'upper-alpha-hierarchical':
      return hierarchicalPreset('upper-alpha');
    case 'lower-alpha-hierarchical':
      return hierarchicalPreset('lower-alpha');
    case 'upper-roman-hierarchical':
      return hierarchicalPreset('upper-roman');
    case 'lower-roman-hierarchical':
      return hierarchicalPreset('lower-roman');
    case 'upper-greek-hierarchical':
      return hierarchicalPreset('upper-greek');
    case 'lower-greek-hierarchical':
      return hierarchicalPreset('lower-greek');
    case 'decimal-parenthesized':
      return {
        styles: Array.from({ length: 6 }, () => 'decimal' as const),
        templates: ['{1}）', '{2}）', '{3}）', '{4}）', '{5}）', '{6}）'],
      };
    case 'chinese-document':
      return {
        styles: ['chinese', 'chinese', 'decimal', 'decimal', 'circled', 'upper-alpha'],
        templates: ['{1}、', '（{2}）', '{3}.', '（{4}）', '{5}', '{6}.'],
      };
    default:
      return hierarchicalPreset('decimal');
  }
};

/** Bijective base-N（Go alphabeticNumber）：1=A、26=Z、27=AA——没有零位。 */
const alphabeticNumber = (number: number, alphabet: string): string => {
  if (number < 1 || alphabet.length === 0) return String(number);
  let n = number;
  let ret = '';
  const base = alphabet.length;
  while (n > 0) {
    n--;
    ret = alphabet[n % base] + ret;
    n = Math.floor(n / base);
  }
  return ret;
};

const ROMAN_VALUES = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
const ROMAN_SYMBOLS = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];

const romanNumber = (number: number): string => {
  if (number < 1 || number > 3999) return String(number);
  let n = number;
  let ret = '';
  for (let i = 0; i < ROMAN_VALUES.length; i++) {
    while (ROMAN_VALUES[i] <= n) {
      ret += ROMAN_SYMBOLS[i];
      n -= ROMAN_VALUES[i];
    }
  }
  return ret;
};

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CHINESE_UNITS = ['', '十', '百', '千'];
const CHINESE_BIG_UNITS = ['', '万', '亿', '万亿'];

const chineseSection = (section: number): string => {
  let s = section;
  let ret = '';
  let zeroPending = false;
  const divisors = [1000, 100, 10, 1];
  for (let i = 0; i < divisors.length; i++) {
    const digit = Math.floor(s / divisors[i]);
    s %= divisors[i];
    if (digit === 0) {
      if (ret.length > 0 && s > 0) zeroPending = true;
      continue;
    }
    if (zeroPending) {
      ret += CHINESE_DIGITS[0];
      zeroPending = false;
    }
    ret += CHINESE_DIGITS[digit];
    ret += CHINESE_UNITS[CHINESE_UNITS.length - 1 - i];
  }
  return ret;
};

/** 中文编号（Go chineseNumber）：万/亿分段、段间零补齐、段内高位缺失补零、一十→十。 */
const chineseNumber = (number: number): string => {
  if (number < 1) return String(number);
  const original = number;
  let n = number;
  let ret = '';
  let zeroPending = false;
  let lowerSection = 0;
  let unitIndex = 0;
  while (n > 0) {
    const section = n % 10000;
    if (section === 0) {
      if (ret !== '') zeroPending = true;
    } else {
      if (unitIndex >= CHINESE_BIG_UNITS.length) return String(original);
      let sectionText = chineseSection(section) + CHINESE_BIG_UNITS[unitIndex];
      if (ret !== '' && (zeroPending || lowerSection < 1000)) sectionText += '零';
      ret = sectionText + ret;
      zeroPending = false;
    }
    lowerSection = section;
    n = Math.floor(n / 10000);
    unitIndex++;
  }
  if (ret.startsWith('一十')) ret = '十' + ret.slice(2);
  return ret;
};

const CIRCLED = [
  '', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
  '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
];

const circledNumber = (number: number): string =>
  number > 0 && number < CIRCLED.length ? CIRCLED[number] : String(number);

export const formatHeadingCounter = (number: number, style: HeadingNumberStyle): string => {
  switch (style) {
    case 'upper-alpha':
      return alphabeticNumber(number, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    case 'lower-alpha':
      return alphabeticNumber(number, 'abcdefghijklmnopqrstuvwxyz');
    case 'upper-roman':
      return romanNumber(number);
    case 'lower-roman':
      return romanNumber(number).toLowerCase();
    case 'upper-greek':
      return alphabeticNumber(number, 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ');
    case 'lower-greek':
      return alphabeticNumber(number, 'αβγδεζηθικλμνξοπρστυφχψω');
    case 'chinese':
      return chineseNumber(number);
    case 'circled':
      return circledNumber(number);
    default:
      return String(number);
  }
};

/** Go formatHeadingNumber：按层深取模板替换 {N}；超出模板深回落 `1.2.3...` 连写。 */
export const formatHeadingNumber = (path: number[], preset: HeadingNumberPreset): string => {
  if (path.length === 0) return '';
  const depth = path.length - 1;
  if (preset.templates.length <= depth) return path.join('.').trim();
  let ret = preset.templates[depth];
  for (let i = 0; i < path.length; i++) {
    const style = i < preset.styles.length ? preset.styles[i] : 'decimal';
    ret = ret.split(`{${i + 1}}`).join(formatHeadingCounter(path[i], style));
  }
  return ret.trim();
};

/**
 * 编号收集（思源 collectOutlineHeadings 语义）：块级标题都参与——list 块首行
 * `# ` 与 raw 顶层 `# `（headingLevel 不分 kind，与渲染一致）；quote/callout 是
 * raw 块（无子块），内部不会出现列表标题——思源对 blockquote/callout/tab/embed
 * 容器的排除在我们这里天然成立。列表嵌套子块内的标题照收（思源 ListItem 不排除）。
 * 全树深度优先（折叠不影响编号——思源按文档树序）。
 */
export const collectHeadings = (roots: Block[]): { block: Block; level: number }[] => {
  const out: { block: Block; level: number }[] = [];
  const walk = (bs: Block[]): void => {
    for (const b of bs) {
      const level = headingLevel(b);
      if (level > 0) out.push({ block: b, level });
      walk(b.children);
    }
  };
  walk(roots);
  return out;
};

/** Go buildHeadingNumberEntries：栈式计数，块对象 → 显示编号。 */
export const buildHeadingNumbers = (
  roots: Block[],
  format: string,
): Map<Block, string> => {
  const ret = new Map<Block, string>();
  const headings = collectHeadings(roots);
  if (headings.length === 0) return ret;
  const preset = headingNumberPresetByID(format);
  const levels: number[] = [];
  const counters: number[] = [];
  for (const h of headings) {
    while (levels.length > 0 && levels[levels.length - 1] >= h.level) levels.pop();
    const depth = levels.length;
    levels.push(h.level);
    if (depth === counters.length) counters.push(0);
    else counters.length = depth + 1;
    counters[depth]++;
    const path = [...counters];
    ret.set(h.block, formatHeadingNumber(path, preset));
  }
  return ret;
};

/** 思源 headingNumberNeedsSpacing：`、`/`）` 结尾自带间距，不再加边距。 */
export const headingNumberNeedsSpacing = (number: string): boolean =>
  !['、', '）'].some((suffix) => number.endsWith(suffix));
