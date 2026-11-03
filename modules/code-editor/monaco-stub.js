// vitest 专用 stub:monaco-editor 的真实实现只在 Obsidian 运行时存在。
// renderTree → codeBlockEdit → monaco.ts 的导入链需要可解析,但单测从不
// 真正创建编辑器(那属于 e2e 的职责)。任何在单测里触达编辑器本体的调用
// 都会立刻抛错,而不是静默通过。
export const editor = {
  EditorOption: { lineHeight: 0, readOnly: 0 },
  KeyMod: { CtrlCmd: 0 },
  KeyCode: { KeyS: 0, Escape: 0 },
  defineTheme() {},
  setTheme() {},
  setModelLanguage() {},
  getEditors() {
    return [];
  },
  tokenize() {
    return [];
  },
  // 阅读态静态着色(真实实现只在 Obsidian 运行时;单测走到就把文本转义返回)
  async colorize(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },
  create() {
    throw new Error('monaco-editor stub: editor.create() called in a unit test');
  },
};

export const languages = {
  typescript: {
    typescriptDefaults: { setDiagnosticsOptions() {}, setCompilerOptions() {} },
    javascriptDefaults: { setDiagnosticsOptions() {}, setCompilerOptions() {} },
  },
  register() {},
  registerTokensColorizer() {},
  setMonarchTokensProvider() {},
};

export default { editor, languages };
