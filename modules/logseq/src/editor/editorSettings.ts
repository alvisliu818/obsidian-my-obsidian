/**
 * 「VS Code 编辑器设置」—— 用户可调的 Monaco 编辑器选项。
 *
 * 数据流:settings.json(唯一存储,见 settings/editorSettingsStore.ts)
 *   → editorSettingsFrom() 清洗为 EditorSettings
 *   → buildEditorOptionOverrides() 生成选项覆盖表(纯数据,不含 monaco 依赖)
 *   → monaco.ts 的 createEditor 把覆盖表叠到调用方默认之上;applyEditorSettings
 *     对已存在的编辑器实例 updateOptions 即时生效。
 *
 * 合并优先级:**结构锁死 > 用户设置 > 调用方默认**。
 * 块内代码块的锁死项(lineNumbers/folding/minimap/wordWrap/括号色/Enter 补全)
 * 不在本文件的覆盖表里 —— 它们由 monaco.ts 的块内分支显式写死,覆盖表对这些键
 * 保持沉默,顺序上也不可能穿透。
 *
 * 哨兵约定:fontSize 0 / fontFamily '' / lineHeight <8 / letterSpacing 0 /
 * tabSize 0 = 跟随现状(块内跟阅读态、文件视图用 Monaco 默认)。
 */

export type CursorBlinkingStyle = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
export type CursorSmoothCaretMode = 'off' | 'explicit' | 'on';
export type RenderWhitespaceMode = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
export type RenderLineHighlightMode = 'none' | 'gutter' | 'line' | 'all';
export type MatchBracketsMode = 'always' | 'near' | 'never';
export type WordWrapMode = '' | 'off' | 'on' | 'wordWrapColumn' | 'bounded';
export type WordBasedSuggestionsMode = 'off' | 'currentDocument' | 'matchingDocuments' | 'allDocuments';
export type ShowFoldingControlsMode = 'always' | 'never' | 'mouseover';

export interface EditorSettings {
  // ---- 字体(0/'' = 跟随现状) ----
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  letterSpacing: number;
  fontLigatures: boolean;
  // ---- 光标与滚动 ----
  cursorBlinking: CursorBlinkingStyle;
  cursorSmoothCaretAnimation: CursorSmoothCaretMode;
  mouseWheelZoom: boolean;
  scrollBeyondLastLine: boolean;
  // ---- 渲染 ----
  renderWhitespace: RenderWhitespaceMode;
  renderLineHighlight: RenderLineHighlightMode;
  matchBrackets: MatchBracketsMode;
  bracketPairColorization: boolean;
  stickyScroll: boolean;
  // ---- 换行与缩进 ----
  wordWrap: WordWrapMode;
  wordWrapColumn: number;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  // ---- Minimap 与折叠 ----
  minimap: boolean;
  minimapRenderCharacters: boolean;
  folding: boolean;
  showFoldingControls: ShowFoldingControlsMode;
  // ---- 补全 ----
  quickSuggestions: boolean;
  wordBasedSuggestions: WordBasedSuggestionsMode;
}

/**
 * 默认值 = 插件当前(2026-10)的硬编码行为:
 *  - 字号/字体/行高 0/''/0 = 跟随(块内 1.5×阅读态、文件视图 Monaco 默认 13);
 *  - wordWrap 'on' = 外部代码文件一直默认换行(CodeDoc 原为 off,统一后跟随);
 *  - minimap false = 现状(所有创建点都显式关);
 *  - cursorBlinking 'smooth' / renderWhitespace 'selection' / quickSuggestions true /
 *    wordBasedSuggestions 'currentDocument' = createEditor 现有显式值。
 */
export const EDITOR_SETTINGS_DEFAULTS: EditorSettings = {
  fontSize: 0,
  fontFamily: '',
  lineHeight: 0,
  letterSpacing: 0,
  fontLigatures: false,

  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'off',
  mouseWheelZoom: false,
  scrollBeyondLastLine: true,

  renderWhitespace: 'selection',
  renderLineHighlight: 'line',
  matchBrackets: 'near',
  bracketPairColorization: true,
  stickyScroll: false,

  wordWrap: 'on',
  wordWrapColumn: 0,
  tabSize: 0,
  insertSpaces: true,
  detectIndentation: true,

  minimap: false,
  minimapRenderCharacters: true,
  folding: true,
  showFoldingControls: 'mouseover',

  quickSuggestions: true,
  wordBasedSuggestions: 'currentDocument',
};

// ---------------------------------------------------------------------
// 清洗:unknown → EditorSettings(未知键忽略、逐键类型/范围钳制)
// ---------------------------------------------------------------------

const CURSOR_BLINKING: readonly CursorBlinkingStyle[] = ['blink', 'smooth', 'phase', 'expand', 'solid'];
const CURSOR_SMOOTH_CARET: readonly CursorSmoothCaretMode[] = ['off', 'explicit', 'on'];
const RENDER_WHITESPACE: readonly RenderWhitespaceMode[] = ['none', 'boundary', 'selection', 'trailing', 'all'];
const RENDER_LINE_HIGHLIGHT: readonly RenderLineHighlightMode[] = ['none', 'gutter', 'line', 'all'];
const MATCH_BRACKETS: readonly MatchBracketsMode[] = ['always', 'near', 'never'];
const WORD_WRAP: readonly WordWrapMode[] = ['', 'off', 'on', 'wordWrapColumn', 'bounded'];
const WORD_BASED: readonly WordBasedSuggestionsMode[] = ['off', 'currentDocument', 'matchingDocuments', 'allDocuments'];
const FOLDING_CONTROLS: readonly ShowFoldingControlsMode[] = ['always', 'never', 'mouseover'];

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function pickBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/** 整数钳制;非有限数或越界时返回 fallback。 */
function pickInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pickStr(raw: unknown, maxLen: number, fallback: string): string {
  return typeof raw === 'string' ? raw.slice(0, maxLen) : fallback;
}

/**
 * 清洗入口。返回未知键数量(设置页可提示「settings.json 里 N 个键未被识别」),
 * 任何键非法都回退该项默认而不是整体拒绝 —— 部分手改的文件仍尽量生效。
 */
export function editorSettingsFrom(raw: unknown): { settings: EditorSettings; unknownKeys: number } {
  const d = EDITOR_SETTINGS_DEFAULTS;
  const out: EditorSettings = { ...d };
  let unknownKeys = 0;
  if (typeof raw !== 'object' || raw === null) return { settings: out, unknownKeys };
  const o = raw as Record<string, unknown>;
  const known = new Set(Object.keys(d));
  for (const key of Object.keys(o)) {
    if (!known.has(key)) unknownKeys += 1;
  }
  out.fontSize = pickInt(o.fontSize, 0, 100, d.fontSize) === 0 ? 0 : pickInt(o.fontSize, 5, 100, d.fontSize);
  out.fontFamily = pickStr(o.fontFamily, 300, d.fontFamily);
  out.lineHeight = pickInt(o.lineHeight, 0, 200, d.lineHeight) === 0 ? 0 : Math.max(8, pickInt(o.lineHeight, 8, 200, d.lineHeight));
  out.letterSpacing = pickInt(o.letterSpacing, -5, 20, d.letterSpacing);
  out.fontLigatures = pickBool(o.fontLigatures, d.fontLigatures);

  out.cursorBlinking = pickEnum(o.cursorBlinking, CURSOR_BLINKING, d.cursorBlinking);
  out.cursorSmoothCaretAnimation = pickEnum(o.cursorSmoothCaretAnimation, CURSOR_SMOOTH_CARET, d.cursorSmoothCaretAnimation);
  out.mouseWheelZoom = pickBool(o.mouseWheelZoom, d.mouseWheelZoom);
  out.scrollBeyondLastLine = pickBool(o.scrollBeyondLastLine, d.scrollBeyondLastLine);

  out.renderWhitespace = pickEnum(o.renderWhitespace, RENDER_WHITESPACE, d.renderWhitespace);
  out.renderLineHighlight = pickEnum(o.renderLineHighlight, RENDER_LINE_HIGHLIGHT, d.renderLineHighlight);
  out.matchBrackets = pickEnum(o.matchBrackets, MATCH_BRACKETS, d.matchBrackets);
  out.bracketPairColorization = pickBool(o.bracketPairColorization, d.bracketPairColorization);
  out.stickyScroll = pickBool(o.stickyScroll, d.stickyScroll);

  out.wordWrap = pickEnum(o.wordWrap, WORD_WRAP, d.wordWrap);
  out.wordWrapColumn = pickInt(o.wordWrapColumn, 0, 500, d.wordWrapColumn);
  out.tabSize = pickInt(o.tabSize, 0, 16, d.tabSize);
  out.insertSpaces = pickBool(o.insertSpaces, d.insertSpaces);
  out.detectIndentation = pickBool(o.detectIndentation, d.detectIndentation);

  out.minimap = pickBool(o.minimap, d.minimap);
  out.minimapRenderCharacters = pickBool(o.minimapRenderCharacters, d.minimapRenderCharacters);
  out.folding = pickBool(o.folding, d.folding);
  out.showFoldingControls = pickEnum(o.showFoldingControls, FOLDING_CONTROLS, d.showFoldingControls);

  out.quickSuggestions = pickBool(o.quickSuggestions, d.quickSuggestions);
  out.wordBasedSuggestions = pickEnum(o.wordBasedSuggestions, WORD_BASED, d.wordBasedSuggestions);
  return { settings: out, unknownKeys };
}

// ---------------------------------------------------------------------
// 运行态:当前生效的设置(store 加载后写入)
// ---------------------------------------------------------------------

let current: EditorSettings = { ...EDITOR_SETTINGS_DEFAULTS };

export function getEditorSettings(): EditorSettings {
  return current;
}

export function setEditorSettings(s: EditorSettings): void {
  current = s;
}

/** 哨兵感知的有效字号:0 = 跟随调用方给的默认(块内是宿主计算值)。 */
export function effectiveFontSize(callerDefault: number): number {
  return current.fontSize > 0 ? current.fontSize : callerDefault;
}

// ---------------------------------------------------------------------
// 覆盖表(纯数据,monaco.ts 负责叠到 IEditorOptions 上)
// ---------------------------------------------------------------------

/** 编辑器作用域:'file' = 文件类视图(代码文件/CodeDoc/混合);'block' = 块内单例。 */
export type EditorScope = 'file' | 'block';

/** 覆盖表的键就是 monaco IEditorOptions 的键;monaco.ts 直接 Object.assign。 */
export type EditorOptionOverrides = Record<string, unknown>;

/**
 * 由设置生成选项覆盖表。
 *
 * - file 作用域:全部用户键生效(minimap/folding/wordWrap/stickyScroll/缩进);
 * - block 作用域:只出字体/光标/渲染/补全这些与阅读态对齐不冲突的键 ——
 *   wordWrap/minimap/folding/行号/括号色/scrollBeyondLastLine 的锁死由
 *   monaco.ts 块内分支在覆盖表**之后**显式写死(结构锁死优先)。
 */
export function buildEditorOptionOverrides(scope: EditorScope, s: EditorSettings): EditorOptionOverrides {
  const o: EditorOptionOverrides = {};
  // 字体
  if (s.fontSize > 0) o.fontSize = s.fontSize;
  if (s.fontFamily) o.fontFamily = s.fontFamily;
  if (s.lineHeight >= 8) o.lineHeight = s.lineHeight;
  if (s.letterSpacing !== 0) o.letterSpacing = s.letterSpacing;
  o.fontLigatures = s.fontLigatures;
  // 光标与滚动
  o.cursorBlinking = s.cursorBlinking;
  o.cursorSmoothCaretAnimation = s.cursorSmoothCaretAnimation;
  o.mouseWheelZoom = s.mouseWheelZoom;
  if (scope === 'file') o.scrollBeyondLastLine = s.scrollBeyondLastLine;
  // 渲染
  o.renderWhitespace = s.renderWhitespace;
  o.renderLineHighlight = s.renderLineHighlight;
  o.matchBrackets = s.matchBrackets;
  if (scope === 'file') o.stickyScroll = { enabled: s.stickyScroll };
  // 换行(块内不覆盖 —— monaco.ts 块内分支写死 'off')
  if (scope === 'file') {
    o.wordWrap = s.wordWrap === '' ? 'on' : s.wordWrap;
    if (s.wordWrap === 'wordWrapColumn' && s.wordWrapColumn > 0) o.wordWrapColumn = s.wordWrapColumn;
  }
  // Minimap 与折叠(块内不覆盖)
  if (scope === 'file') {
    o.minimap = { enabled: s.minimap, renderCharacters: s.minimapRenderCharacters };
    o.folding = s.folding;
    o.showFoldingControls = s.showFoldingControls;
    o.detectIndentation = s.detectIndentation;
  }
  // 补全(quickSuggestions 保持现有分类形态:other 开、注释/字符串不触发)
  o.quickSuggestions = s.quickSuggestions ? { other: true, comments: false, strings: false } : false;
  o.wordBasedSuggestions = s.wordBasedSuggestions;
  return o;
}

/**
 * model 级覆盖(tabSize/insertSpaces 是 model 的选项,editor 级到不了;
 * 括号着色同理 —— 见 monaco.ts disableBlockBracketColorization 的先例论证)。
 * tabSize 0 = 不动模型(保持 monaco 默认 4 / detectIndentation 的探测结果)。
 */
export function buildModelOverrides(scope: EditorScope, s: EditorSettings): EditorOptionOverrides {
  const o: EditorOptionOverrides = {};
  if (scope !== 'file') return o; // 块内 model 不动(默认 4 空格,与阅读态一致)
  if (s.tabSize > 0) o.tabSize = s.tabSize;
  o.insertSpaces = s.insertSpaces;
  o.bracketColorizationOptions = { enabled: s.bracketPairColorization };
  return o;
}

/**
 * 补全面板行高公式(与 createEditor/mountSharedBlockEditor 保持同一出处):
 * 28px 起步,字号大时随字号放大。
 */
export function suggestLineHeightFor(fontSize: number): number {
  return Math.max(28, Math.round(fontSize * 1.8));
}
