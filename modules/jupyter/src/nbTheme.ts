/**
 * ipynb 视图的代码主题桥：把 logseq 编辑器插件加载的 VS Code 主题
 * （extensions/themeLoader，Monaco 侧）转换成 CodeMirror 6 的 HighlightStyle。
 *
 * 背景（2026-10-24）：ipynb 的代码格是 CM6（cm-bundle 自包含副本），而 VS Code
 * 主题只 defineTheme 进了 Monaco —— 两套编辑器互不相通，表现为「VS Code 代码
 * 主题没在 ipynb 生效」。这里在加载主题时留底的 tokenRules 之上，做一次
 * TextMate scope → lezer tag 的近似映射，让 ipynb 跟随同一个主题配色。
 *
 * 近似点（可接受的降级）：
 *  - TextMate 的嵌套 scope 选择器（空格分隔祖先链）在 themeLoader 里已被拆成
 *    独立 scope，这里只做点分段前缀匹配，选最特异的规则；
 *  - 主题切换不热更新 —— 重新打开 ipynb 生效（视图按滚动懒重建实例，重开成本≈0）。
 */

import { HighlightStyle, syntaxHighlighting } from 'cm-bundle:@codemirror/language';
import type { Extension } from 'cm-bundle:@codemirror/state';
import { tags as t, type Tag } from 'cm-bundle:@lezer/highlight';
import {
  getActiveThemeName, getLoadedThemes,
  type NbTokenRule,
} from '../../code-editor/src/extensions/themeLoader';

/** lezer tag → TextMate scope 前缀候选（按特异度从高到低排列只是可读性，匹配本身按长度） */
const TAG_SCOPES: Array<{ tag: Tag | Tag[]; scopes: string[] }> = [
  { tag: t.comment, scopes: ['comment'] },
  { tag: t.string, scopes: ['string'] },
  { tag: t.regexp, scopes: ['string.regexp'] },
  { tag: t.escape, scopes: ['constant.character.escape'] },
  { tag: t.number, scopes: ['constant.numeric'] },
  { tag: [t.bool, t.null], scopes: ['constant.language'] },
  { tag: t.controlKeyword, scopes: ['keyword.control'] },
  { tag: t.moduleKeyword, scopes: ['keyword.control.import', 'keyword.control.include'] },
  { tag: t.operatorKeyword, scopes: ['keyword.operator.logical', 'keyword.operator.assignment'] },
  { tag: t.definitionKeyword, scopes: ['storage.type.function', 'keyword.declaration'] },
  { tag: t.modifier, scopes: ['storage.modifier'] },
  { tag: t.operator, scopes: ['keyword.operator'] },
  { tag: t.keyword, scopes: ['keyword', 'storage'] },
  { tag: t.function(t.variableName), scopes: ['entity.name.function', 'support.function'] },
  { tag: [t.typeName, t.className], scopes: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'] },
  { tag: t.namespace, scopes: ['entity.name.namespace'] },
  { tag: t.tagName, scopes: ['entity.name.tag'] },
  { tag: t.attributeName, scopes: ['entity.other.attribute-name'] },
  { tag: t.constant(t.name), scopes: ['variable.other.constant', 'constant.other'] },
  { tag: t.propertyName, scopes: ['variable.other.property', 'meta.property-name', 'support.variable.property'] },
  { tag: t.definition(t.variableName), scopes: ['variable.parameter'] },
  { tag: t.variableName, scopes: ['variable'] },
  { tag: t.heading, scopes: ['markup.heading', 'heading'] },
  { tag: t.invalid, scopes: ['invalid'] },
];

/** 点分段前缀匹配：两者相等，或其一为另一个的「点段前缀」 */
function scopeRelated(candidate: string, ruleScope: string): boolean {
  if (candidate === ruleScope) return true;
  if (candidate.startsWith(ruleScope + '.')) return true;
  return ruleScope.startsWith(candidate + '.');
}

/** 两个 scope 的匹配特异度（命中段越长越特异；不命中返回 -1） */
function matchSpecificity(candidate: string, ruleScope: string): number {
  return scopeRelated(candidate, ruleScope) ? Math.min(candidate.length, ruleScope.length) : -1;
}

/**
 * 从主题规则里为一个 scope 候选挑颜色：遍历所有规则取命中且特异度最高者。
 * 纯函数（导出供未来单测），不含 CM 依赖。
 */
export function pickRule(
  rules: NbTokenRule[],
  candidate: string,
): { foreground: string; fontStyle?: string } | null {
  let best: NbTokenRule | null = null;
  let bestSpec = -1;
  for (const rule of rules) {
    const spec = matchSpecificity(candidate, rule.scope);
    if (spec > bestSpec) {
      best = rule;
      bestSpec = spec;
    }
  }
  if (!best) return null;
  return { foreground: best.foreground, fontStyle: best.fontStyle };
}

/** fontStyle 字符串 → HighlightStyle 样式字段 */
function fontStyleFields(fontStyle?: string): { fontStyle?: string; fontWeight?: string; textDecoration?: string } {
  if (!fontStyle) return {};
  const out: Record<string, string> = {};
  if (fontStyle.includes('italic')) out.fontStyle = 'italic';
  if (fontStyle.includes('bold')) out.fontWeight = '700';
  if (fontStyle.includes('underline')) out.textDecoration = 'underline';
  return out;
}

/** 激活主题 → CM6 HighlightStyle（无激活扩展主题时返回 null，调用方用内置配色） */
export function getNbHighlightStyle(): HighlightStyle | null {
  const themeName = getActiveThemeName();
  if (!themeName) return null;
  const theme = getLoadedThemes().find((x) => x.name === themeName);
  if (!theme?.tokenRules?.length) return null;
  const entries: Array<Record<string, unknown>> = [];
  for (const { tag, scopes } of TAG_SCOPES) {
    // 多个候选 scope 各自挑最特异的规则；第一个有结果的胜（候选本身已按特异度排）
    for (const scope of scopes) {
      const hit = pickRule(theme.tokenRules, scope);
      if (!hit) continue;
      entries.push({ tag, color: hit.foreground, ...fontStyleFields(hit.fontStyle) });
      break;
    }
  }
  if (!entries.length) return null;
  try {
    return HighlightStyle.define(entries as never);
  } catch {
    // 主题里有怪颜色/字段时保底：宁可回退内置配色也不崩视图
    return null;
  }
}

/** cellExtensions 用的组合：有主题用主题，没有回退内置配色 */
export function nbSyntaxHighlighting(fallback: HighlightStyle): Extension {
  return syntaxHighlighting(getNbHighlightStyle() ?? fallback, { fallback: true });
}
