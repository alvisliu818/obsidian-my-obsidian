// 颜色主题加载器：VSCode 扩展的 theme JSON → Monaco 主题（defineTheme）。
// 移植自 siyuan-virtual-tree theme-loader。
//
// 与思源侧的差异：这里只 defineTheme，不在加载时自动 setTheme —— 聚合插件自己
// 管理代码编辑器主题，自动切换会覆盖用户在设置里选的配色。应用时机交给调用方
// （设置项/市场 UI）显式触发 applyExtensionTheme / applyThemeByPreference。
import type * as monacoNs from 'monaco-editor';
import { monaco } from '../editor/lazyMonaco';
// Structural subset of logseq's `InstalledExtension` (extensions/types.ts):
// theme loading only reads id / files / contributes.themes, and this module
// must not import the extension-management domain back (code-editor is a
// bottom-layer module). Callers passing the full InstalledExtension stay
// compatible.
export interface CodeThemeExtension {
  id: string;
  files: Record<string, string>;
  contributes?: {
    themes?: { label: string; uiTheme?: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'; path: string }[];
  };
}

export interface LoadedTheme {
  extensionId: string;
  label: string;
  /** Monaco base 主题 */
  base: 'vs' | 'vs-dark';
  /** 注册到 Monaco 的主题名 */
  name: string;
  /**
   * 规范化后的 VSCode token 规则（scope 已拆分、颜色已归一为 #RRGGBB）。
   * Monaco 之外的编辑器（如 jupyter 的 CodeMirror 视图）用它做自己的
   * token→颜色映射 —— Monaco 的 rules 无法反向导出，所以加载时留底。
   */
  tokenRules?: NbTokenRule[];
}

/** 一条拆分后的 token 着色规则 */
export interface NbTokenRule {
  scope: string;
  foreground: string;
  fontStyle?: string;
}

const loadedThemes: LoadedTheme[] = [];
let activeThemeName: string | null = null;

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

/** 加载扩展的颜色主题贡献，返回注册的主题数（重复调用先清理旧的，幂等） */
export function loadThemes(extension: CodeThemeExtension): number {
  removeExtensionThemes(extension.id);

  const contributes = extension.contributes;
  if (!contributes?.themes || contributes.themes.length === 0) return 0;

  let count = 0;
  for (const themeContribution of contributes.themes) {
    try {
      const content = extension.files[normalizePath(themeContribution.path)];
      if (!content) continue;
      const themeData = JSON.parse(content);
      const themeName = `ext-${extension.id}-${themeContribution.label}`.replace(/[^a-zA-Z0-9-]/g, '-');
      const base: 'vs' | 'vs-dark' =
        themeContribution.uiTheme === 'vs' || themeData.type === 'light' ? 'vs' : 'vs-dark';

      convertThemeToMonaco(themeData, themeName, base);
      loadedThemes.push({
        extensionId: extension.id,
        label: themeContribution.label,
        base,
        name: themeName,
        tokenRules: collectTokenRules(themeData),
      });
      count++;
    } catch {
      // 单个主题损坏不影响其余
    }
  }
  return count;
}

/** 应用主题（Monaco 延迟校验颜色，失败时回退内置并清空记录） */
function safeSetTheme(themeName: string): boolean {
  try {
    monaco.editor.setTheme(themeName);
    activeThemeName = themeName;
    return true;
  } catch {
    activeThemeName = null;
    try {
      monaco.editor.setTheme('vs-dark');
    } catch {
      // 忽略
    }
    return false;
  }
}

// ===== 语义 token 规则(LSP semanticTokens → 主题颜色)=====
// 移植自 siyuan-virtual-tree theme-loader 的 appendSemanticRules。
//
// 背景:LSP(basedpyright) 下发"语义 token"(类型如 parameter/function/variable),
// Monaco 拿语义 token 字符串(类型 + '.' + 修饰符,如 "parameter.declaration")
// 走与 TextMate **同一个** ThemeTrie 匹配。主题 tokenColors 里没有 'parameter'
// 这种顶层选择器,所以要按 VS Code 官方 tokenClassificationRegistry 把语义类型
// 映射成 TextMate 探测 scope,再到主题 tokenColors 里取色,落成 Monaco 规则
// (VS Code 里 Pylance 的参数名橙色就是这么来的)。
//
// 探测算法(VS Code colorThemeData 语义):
//   - 主题规则 scope 是探测 scope 的"点分段前缀"才命中,且选择器不能比 scope 长;
//   - 多个命中取最长选择器;
//   - 探测不到 → 不生成规则 → 该语义 token 回退 TextMate 语法着色(同 VS Code)。

/** 官方默认规则(createDefaultTokenClassificationRegistry 全表) */
const SEMANTIC_DEFAULT_RULES: Array<{ selector: string; scopes: string[] }> = [
  { selector: 'comment', scopes: ['comment'] },
  { selector: 'string', scopes: ['string'] },
  { selector: 'keyword', scopes: ['keyword.control'] },
  { selector: 'number', scopes: ['constant.numeric'] },
  { selector: 'regexp', scopes: ['constant.regexp'] },
  { selector: 'operator', scopes: ['keyword.operator'] },
  { selector: 'namespace', scopes: ['entity.name.namespace'] },
  { selector: 'type', scopes: ['entity.name.type', 'support.type'] },
  { selector: 'struct', scopes: ['entity.name.type.struct'] },
  { selector: 'class', scopes: ['entity.name.type.class', 'support.class'] },
  { selector: 'interface', scopes: ['entity.name.type.interface'] },
  { selector: 'enum', scopes: ['entity.name.type.enum'] },
  { selector: 'typeParameter', scopes: ['entity.name.type.parameter'] },
  { selector: 'function', scopes: ['entity.name.function', 'support.function'] },
  { selector: 'method', scopes: ['entity.name.function.member', 'support.function'] },
  { selector: 'macro', scopes: ['entity.name.function.preprocessor'] },
  { selector: 'variable', scopes: ['variable.other.readwrite', 'entity.name.variable'] },
  { selector: 'parameter', scopes: ['variable.parameter'] },
  { selector: 'property', scopes: ['variable.other.property'] },
  { selector: 'enumMember', scopes: ['variable.other.enummember'] },
  { selector: 'event', scopes: ['variable.other.event'] },
  { selector: 'decorator', scopes: ['entity.name.decorator', 'entity.name.function'] },
  // 带 modifier 的默认规则(只有 readonly/defaultLibrary 影响 scope 探测)
  { selector: 'variable.readonly', scopes: ['variable.other.constant'] },
  { selector: 'property.readonly', scopes: ['variable.other.constant.property'] },
  { selector: 'type.defaultLibrary', scopes: ['support.type'] },
  { selector: 'class.defaultLibrary', scopes: ['support.class'] },
  { selector: 'interface.defaultLibrary', scopes: ['support.class'] },
  { selector: 'variable.defaultLibrary', scopes: ['support.variable', 'support.other.variable'] },
  { selector: 'variable.defaultLibrary.readonly', scopes: ['support.constant'] },
  { selector: 'property.defaultLibrary', scopes: ['support.variable.property'] },
  { selector: 'property.defaultLibrary.readonly', scopes: ['support.constant.property'] },
  { selector: 'function.defaultLibrary', scopes: ['support.function'] },
  { selector: 'member.defaultLibrary', scopes: ['support.function'] },
];

/** 主题 tokenColors 解析结果:scope 按点分段 + 颜色 */
interface ParsedTokenRule {
  segments: string[];
  foreground: string;
  fontStyle?: string;
}

/** 探测:找"点分段前缀"命中的主题规则,取最长选择器 */
function probeTokenColor(parsed: ParsedTokenRule[], scopeSegments: string[]): ParsedTokenRule | null {
  let best: ParsedTokenRule | null = null;
  let bestLen = 0;
  for (const rule of parsed) {
    if (rule.segments.length > scopeSegments.length) continue; // 选择器比 scope 长
    if (rule.segments.length <= bestLen) continue; // 只找更长的
    let ok = true;
    for (let i = 0; i < rule.segments.length; i++) {
      if (rule.segments[i] !== scopeSegments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      best = rule;
      bestLen = rule.segments.length;
    }
  }
  return best;
}

/**
 * 生成语义 token 规则并追加到 rules。生成的规则 key 是语义类型/类型.修饰符
 * (如 "parameter"、"variable.readonly"),与 Monaco 语义 token 字符串在同一
 * ThemeTrie 里前缀匹配。对 TextMate 语法着色无副作用:裸类型规则的颜色 = 主题
 * 对同名 scope 的既有匹配结果,对以它为前缀的语法 scope 是重复/更弱的匹配。
 *
 * 导出给内置回退主题(editor/monaco.ts 的 applyTheme)复用:它没有 VSCode
 * themeData,用合成的 tokenColors 表调进来 —— 不补这层,LSP 语义 token 在
 * 内置主题下全部落进 {token:''} 默认规则,表现为语义高亮不生效。
 */
export function appendSemanticRules(themeData: any, rules: monacoNs.editor.ITokenThemeRule[]): void {
  // 主题声明不支持语义高亮时跳过(与 VS Code semanticHighlighting 开关一致)
  if (themeData?.semanticHighlighting === false) return;

  // 解析主题 tokenColors 为可探测的规则表
  const parsed: ParsedTokenRule[] = [];
  for (const tokenColor of themeData?.tokenColors ?? []) {
    const rawScopes = Array.isArray(tokenColor.scope) ? tokenColor.scope : [tokenColor.scope];
    const settings = tokenColor.settings || {};
    const foreground = settings.foreground ? normalizeHex(settings.foreground) : '';
    if (!foreground) continue;
    const fontStyle = typeof settings.fontStyle === 'string' ? settings.fontStyle : undefined;
    for (const rawScope of rawScopes) {
      if (typeof rawScope !== 'string') continue;
      for (const scope of rawScope.split(/[\s,]+/).filter(Boolean)) {
        parsed.push({ segments: scope.split('.'), foreground, fontStyle });
      }
    }
  }

  // semanticTokenColors:键 "variable" / "variable.readonly",值为颜色或 TokenStyle。
  // 优先级高于默认规则(VS Code 同序)。
  const byToken = new Map<string, monacoNs.editor.ITokenThemeRule>();
  const putRule = (token: string, foreground: string, fontStyle?: string): void => {
    byToken.set(token, { token, foreground, fontStyle: fontStyle as any });
  };
  const stc = themeData?.semanticTokenColors || {};
  for (const key of Object.keys(stc)) {
    if (key.includes(':')) continue; // 语言限定键(type:python)不处理
    const value = stc[key];
    let foreground = '';
    let fontStyle: string | undefined;
    if (typeof value === 'string') {
      foreground = value;
    } else if (value && typeof value === 'object') {
      foreground = value.foreground || '';
      fontStyle = value.fontStyle;
    }
    foreground = normalizeHex(foreground);
    if (foreground) putRule(key, foreground, fontStyle);
  }

  // 默认规则表:每条 selector 解析一次颜色
  for (const dr of SEMANTIC_DEFAULT_RULES) {
    if (byToken.has(dr.selector)) continue; // semanticTokenColors 已覆盖
    let resolved: ParsedTokenRule | null = null;
    // 依次尝试各探测 scope(官方顺序),首个探到颜色的生效
    for (const scope of dr.scopes) {
      resolved = probeTokenColor(parsed, scope.split('.'));
      if (resolved) break;
    }
    if (resolved) putRule(dr.selector, resolved.foreground, resolved.fontStyle);
  }

  rules.push(...byToken.values());
}

/** 将 VSCode 主题转换为 Monaco 主题 */
function convertThemeToMonaco(themeData: any, themeName: string, base: 'vs' | 'vs-dark'): void {  const colors: Record<string, string> = {};
  const rules: monacoNs.editor.ITokenThemeRule[] = [];

  // 编辑器颜色：走 Monaco 的 CSS 生成路径，支持带 alpha 的 8 位 hex
  //（主题常用半透明叠加，如 lineHighlightBackground=#383A420C，截断会变纯黑）
  if (themeData.colors) {
    const setColor = (key: string, vscodeKey: string) => {
      const v = themeData.colors[vscodeKey];
      if (v) {
        const normalized = normalizeHex(v, true);
        if (normalized) colors[key] = normalized;
      }
    };
    setColor('editor.background', 'editor.background');
    setColor('editor.foreground', 'editor.foreground');
    setColor('editor.selectionBackground', 'editor.selectionBackground');
    setColor('editor.lineHighlightBackground', 'editor.lineHighlightBackground');
  }

  if (themeData.tokenColors) {
    for (const tokenColor of themeData.tokenColors) {
      const rawScopes = Array.isArray(tokenColor.scope) ? tokenColor.scope : [tokenColor.scope];
      const settings = tokenColor.settings || {};
      const foreground = settings.foreground ? normalizeHex(settings.foreground) : '';
      const fontStyle = settings.fontStyle;
      for (const rawScope of rawScopes) {
        if (!rawScope || typeof rawScope !== 'string') continue;
        // scope 可能是逗号/空格分隔的多个选择器；TextMate 里空格表示嵌套，
        // Monaco 不支持，拆成独立 scope 分别注册（近似匹配）
        for (const scope of rawScope.split(/[\s,]+/).filter(Boolean)) {
          if (foreground) {
            rules.push({ token: scope, foreground, fontStyle: fontStyle as any });
          }
        }
      }
    }
  }

  // 语义 token 规则(LSP semanticTokens 的取色换算,移植自思源侧;无 LSP 或
  // 探测不到颜色时不生成规则,自然回退 TextMate 语法着色)
  appendSemanticRules(themeData, rules);

  monaco.editor.defineTheme(themeName, { base, inherit: true, rules, colors });
}

/**
 * 收集规范化 token 规则（供 Monaco 之外的编辑器复用，如 jupyter 的 CM 视图）。
 * 与 convertThemeToMonaco 的解析保持同构：scope 按空格/逗号拆分、颜色归一为
 * #RRGGBB（token 前景丢弃 alpha）、无 foreground 的规则跳过。
 */
function collectTokenRules(themeData: any): NbTokenRule[] {
  const out: NbTokenRule[] = [];
  if (!Array.isArray(themeData?.tokenColors)) return out;
  for (const tokenColor of themeData.tokenColors) {
    const rawScopes = Array.isArray(tokenColor.scope) ? tokenColor.scope : [tokenColor.scope];
    const settings = tokenColor.settings || {};
    const foreground = settings.foreground ? normalizeHex(settings.foreground) : '';
    const fontStyle = typeof settings.fontStyle === 'string' ? settings.fontStyle : undefined;
    if (!foreground) continue;
    for (const rawScope of rawScopes) {
      if (!rawScope || typeof rawScope !== 'string') continue;
      for (const scope of rawScope.split(/[\s,]+/).filter(Boolean)) {
        out.push({ scope, foreground, fontStyle });
      }
    }
  }
  return out;
}

/** 规范化颜色为 hex（无法识别时返回 ''，调用方据此跳过） */
// allowAlpha=false（token 规则用）：输出 6 位 hex，丢弃 alpha —— Monaco token
//   前景色只接受 #RRGGBB
// allowAlpha=true（editor 颜色用）：输出 6 或 8 位 hex，保留 alpha
function normalizeHex(color: string, allowAlpha: boolean = false): string {
  if (!color) return '';
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{8}$/.test(c)) return allowAlpha ? c : c.slice(0, 7);
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  if (/^#[0-9a-f]{4}$/.test(c)) {
    const [r, g, b, a] = [c[1], c[2], c[3], c[4]];
    return allowAlpha ? `#${r}${r}${g}${g}${b}${b}${a}${a}` : `#${r}${r}${g}${g}${b}${b}`;
  }
  const named: Record<string, string> = {
    white: '#ffffff',
    black: '#000000',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    transparent: '',
  };
  if (c in named) return named[c];
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${hex(+m[1])}${hex(+m[2])}${hex(+m[3])}`;
  }
  return '';
}

export function getActiveThemeName(): string | null {
  return activeThemeName;
}

export function getLoadedThemes(): LoadedTheme[] {
  return loadedThemes;
}

export function hasExtensionThemes(): boolean {
  return loadedThemes.length > 0;
}

/** 应用指定主题（name 为 Monaco 主题名） */
export function applyExtensionTheme(themeName: string): boolean {
  const exists = loadedThemes.some((t) => t.name === themeName);
  if (exists) return safeSetTheme(themeName);
  return false;
}

/** 自动应用第一个匹配当前明暗模式的扩展主题 */
export function applyFirstExtensionTheme(isDark: boolean): boolean {
  if (loadedThemes.length === 0) return false;
  const targetBase = isDark ? 'vs-dark' : 'vs';
  const matched = loadedThemes.find((t) => t.base === targetBase) || loadedThemes[0];
  return safeSetTheme(matched.name);
}

/** 按用户偏好应用代码主题
 * pref: '' = 自动（优先扩展主题）；'__none__' = 不用扩展主题；其他 = Monaco 主题名
 * 返回 false 表示调用方需回退到自己的配色 */
export function applyThemeByPreference(pref: string, isDark: boolean): boolean {
  if (pref === '__none__') {
    activeThemeName = null;
    return false;
  }
  if (pref) {
    const matched = loadedThemes.find((t) => t.name === pref);
    if (matched) return safeSetTheme(matched.name);
    // 指定主题已不存在（扩展被卸载）→ 回退自动
  }
  return applyFirstExtensionTheme(isDark);
}

/** 移除扩展的主题（禁用/卸载时调用） */
export function removeExtensionThemes(extensionId: string): void {
  for (let i = loadedThemes.length - 1; i >= 0; i--) {
    if (loadedThemes[i].extensionId === extensionId) loadedThemes.splice(i, 1);
  }
  // 激活主题属于被移除的扩展时清空记录（调用方负责重新应用回退主题）
  if (activeThemeName && !loadedThemes.some((t) => t.name === activeThemeName)) {
    activeThemeName = null;
  }
}

/** 清理所有主题 */
export function clearAllThemes(): void {
  loadedThemes.length = 0;
  activeThemeName = null;
}
