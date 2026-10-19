/**
 * 「VS Code 编辑器设置」纯逻辑层测试:清洗(editorSettingsFrom)、
 * 覆盖表生成(buildEditorOptionOverrides / buildModelOverrides)、
 * 哨兵约定与公式(effectiveFontSize / suggestLineHeightFor)。
 *
 * 存取层(settings.json 读写)见 editorSettingsStore.test.ts。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  EDITOR_SETTINGS_DEFAULTS,
  buildEditorOptionOverrides,
  buildModelOverrides,
  editorSettingsFrom,
  effectiveFontSize,
  getEditorSettings,
  setEditorSettings,
  suggestLineHeightFor,
  type EditorSettings,
} from '../src/editor/editorSettings';

afterEach(() => {
  // 模块级运行态是跨用例共享的,恢复默认避免串味。
  setEditorSettings({ ...EDITOR_SETTINGS_DEFAULTS });
});

describe('editorSettingsFrom 清洗', () => {
  it('非对象输入回退全默认(未知键 0)', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      const { settings, unknownKeys } = editorSettingsFrom(raw);
      expect(settings).toEqual(EDITOR_SETTINGS_DEFAULTS);
      expect(unknownKeys).toBe(0);
    }
  });

  it('未知键计数,已知键非法逐项回退', () => {
    const { settings, unknownKeys } = editorSettingsFrom({
      fontSize: 20,
      bogusKey: 1,
      another: 'x',
      cursorBlinking: 'nope',
      minimap: 'yes',
    });
    expect(unknownKeys).toBe(2);
    expect(settings.fontSize).toBe(20);
    expect(settings.cursorBlinking).toBe(EDITOR_SETTINGS_DEFAULTS.cursorBlinking);
    expect(settings.minimap).toBe(EDITOR_SETTINGS_DEFAULTS.minimap);
  });

  it('字号哨兵:0 = 跟随;1~4 钳到 5;字符串数字可解析', () => {
    expect(editorSettingsFrom({ fontSize: 0 }).settings.fontSize).toBe(0);
    expect(editorSettingsFrom({ fontSize: 3 }).settings.fontSize).toBe(5);
    expect(editorSettingsFrom({ fontSize: '20' }).settings.fontSize).toBe(20);
    expect(editorSettingsFrom({ fontSize: 999 }).settings.fontSize).toBe(100);
    expect(editorSettingsFrom({ fontSize: NaN }).settings.fontSize).toBe(0);
  });

  it('行高哨兵:<8 收敛(5 → 8),0 = 跟随', () => {
    expect(editorSettingsFrom({ lineHeight: 0 }).settings.lineHeight).toBe(0);
    expect(editorSettingsFrom({ lineHeight: 5 }).settings.lineHeight).toBe(8);
    expect(editorSettingsFrom({ lineHeight: 22 }).settings.lineHeight).toBe(22);
  });

  it('枚举键白名单外回退默认', () => {
    expect(editorSettingsFrom({ wordWrap: 'sideways' }).settings.wordWrap).toBe('on');
    expect(editorSettingsFrom({ wordWrap: 'off' }).settings.wordWrap).toBe('off');
    expect(editorSettingsFrom({ wordBasedSuggestions: 'allDocuments' }).settings.wordBasedSuggestions).toBe(
      'allDocuments',
    );
  });
});

describe('buildEditorOptionOverrides 作用域', () => {
  const FULL: EditorSettings = {
    ...EDITOR_SETTINGS_DEFAULTS,
    fontSize: 20,
    fontFamily: 'Cascadia Code',
    lineHeight: 30,
    letterSpacing: 1,
    fontLigatures: true,
    wordWrap: 'wordWrapColumn',
    wordWrapColumn: 80,
    tabSize: 2,
    minimap: true,
    minimapRenderCharacters: false,
    stickyScroll: true,
    scrollBeyondLastLine: false,
    detectIndentation: false,
    quickSuggestions: false,
  };

  it('file 作用域:全部用户键生效(minimap/folding/wordWrap/stickyScroll/缩进)', () => {
    const o = buildEditorOptionOverrides('file', FULL);
    expect(o.fontSize).toBe(20);
    expect(o.fontFamily).toBe('Cascadia Code');
    expect(o.lineHeight).toBe(30);
    expect(o.letterSpacing).toBe(1);
    expect(o.fontLigatures).toBe(true);
    expect(o.wordWrap).toBe('wordWrapColumn');
    expect(o.wordWrapColumn).toBe(80);
    expect(o.minimap).toEqual({ enabled: true, renderCharacters: false });
    expect(o.folding).toBe(true);
    expect(o.showFoldingControls).toBe('mouseover');
    expect(o.stickyScroll).toEqual({ enabled: true });
    expect(o.scrollBeyondLastLine).toBe(false);
    expect(o.detectIndentation).toBe(false);
    expect('tabSize' in o).toBe(false); // tabSize 是 model 级,不进编辑器覆盖表
    expect(o.quickSuggestions).toBe(false);
    expect(o.cursorBlinking).toBe('smooth');
  });

  it('block 作用域:锁死键(wordWrap/minimap/folding/stickyScroll/scrollBeyondLastLine)沉默', () => {
    const o = buildEditorOptionOverrides('block', FULL);
    expect(o.fontSize).toBe(20); // 字体全局统一覆盖(用户拍板),块内也生效
    expect(o.fontFamily).toBe('Cascadia Code');
    expect(o.lineHeight).toBe(30);
    expect('wordWrap' in o).toBe(false);
    expect('wordWrapColumn' in o).toBe(false);
    expect('minimap' in o).toBe(false);
    expect('folding' in o).toBe(false);
    expect('showFoldingControls' in o).toBe(false);
    expect('stickyScroll' in o).toBe(false);
    expect('scrollBeyondLastLine' in o).toBe(false);
    expect('detectIndentation' in o).toBe(false);
    // 渲染/光标/补全键照常生效
    expect(o.cursorBlinking).toBe('smooth');
    expect(o.renderWhitespace).toBe('selection');
    expect(o.matchBrackets).toBe('near');
    expect(o.quickSuggestions).toBe(false);
    expect(o.wordBasedSuggestions).toBe('currentDocument');
  });

  it('哨兵键(0/空串/<8)不进覆盖表 —— 各编辑器保持自己的现值', () => {
    const o = buildEditorOptionOverrides('file', { ...EDITOR_SETTINGS_DEFAULTS });
    expect('fontSize' in o).toBe(false);
    expect('fontFamily' in o).toBe(false);
    expect('lineHeight' in o).toBe(false);
    expect('letterSpacing' in o).toBe(false);
    expect('tabSize' in buildModelOverrides('file', EDITOR_SETTINGS_DEFAULTS)).toBe(false);
  });

  it('wordWrap 哨兵(空串)映射为 on;wordWrapColumn 仅在模式匹配时发出', () => {
    const sentinel = buildEditorOptionOverrides('file', { ...EDITOR_SETTINGS_DEFAULTS, wordWrap: '' });
    expect(sentinel.wordWrap).toBe('on');
    expect('wordWrapColumn' in sentinel).toBe(false);
    const colOff = buildEditorOptionOverrides('file', { ...EDITOR_SETTINGS_DEFAULTS, wordWrap: 'on', wordWrapColumn: 80 });
    expect('wordWrapColumn' in colOff).toBe(false);
  });

  it('quickSuggestions 布尔 → 分类对象(other 开,注释/字符串不触发)', () => {
    expect(buildEditorOptionOverrides('file', EDITOR_SETTINGS_DEFAULTS).quickSuggestions).toEqual({
      other: true,
      comments: false,
      strings: false,
    });
    expect(buildEditorOptionOverrides('file', { ...EDITOR_SETTINGS_DEFAULTS, quickSuggestions: false }).quickSuggestions).toBe(false);
  });
});

describe('buildModelOverrides(model 级选项)', () => {
  it('file:tabSize>0 才发;insertSpaces/括号着色恒发', () => {
    const on = buildModelOverrides('file', { ...EDITOR_SETTINGS_DEFAULTS, tabSize: 2 });
    expect(on).toEqual({
      tabSize: 2,
      insertSpaces: true,
      bracketColorizationOptions: { enabled: true },
    });
    const off = buildModelOverrides('file', {
      ...EDITOR_SETTINGS_DEFAULTS,
      tabSize: 0,
      insertSpaces: false,
      bracketPairColorization: false,
    });
    expect(off).toEqual({
      insertSpaces: false,
      bracketColorizationOptions: { enabled: false },
    });
  });

  it('block:恒为空表 —— 块内 model 不动(默认 4 空格与阅读态一致)', () => {
    expect(buildModelOverrides('block', { ...EDITOR_SETTINGS_DEFAULTS, tabSize: 2 })).toEqual({});
  });
});

describe('哨兵与公式', () => {
  it('effectiveFontSize:哨兵 0 用调用方默认', () => {
    setEditorSettings({ ...EDITOR_SETTINGS_DEFAULTS, fontSize: 0 });
    expect(effectiveFontSize(13.5)).toBe(13.5);
    setEditorSettings({ ...EDITOR_SETTINGS_DEFAULTS, fontSize: 20 });
    expect(effectiveFontSize(13.5)).toBe(20);
  });

  it('suggestLineHeightFor:28 起步,大字号随行放大', () => {
    expect(suggestLineHeightFor(13)).toBe(28);
    expect(suggestLineHeightFor(20)).toBe(36);
    expect(suggestLineHeightFor(0)).toBe(28);
  });

  it('运行态 get/set 往返', () => {
    const next: EditorSettings = { ...EDITOR_SETTINGS_DEFAULTS, fontSize: 16, wordWrap: 'off' };
    setEditorSettings(next);
    expect(getEditorSettings()).toEqual(next);
  });
});
