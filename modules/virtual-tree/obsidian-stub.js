
class Plugin { constructor(){}; registerEvent(){}; addCommand(){}; addSettingTab(){}; registerView(){}; addRibbonIcon(){}; async loadData(){ return {}; } async saveData(){} }
module.exports = {
  Plugin, PluginSettingTab: class {}, ItemView: class {}, Modal: class {},
  FuzzySuggestModal: class {}, Setting: class {}, Notice: class {},
  TFile: class {}, TFolder: class {}, TAbstractFile: class {},
  // remoteHttp 默认传输走 requestUrl;测试注入假传输层后不会走到这里
  requestUrl: async () => { throw new Error('requestUrl is not available in tests'); },
  normalizePath: (p) => p, MarkdownRenderer: { render: async () => {} },
  debounce: (f) => f, Menu: class {}, Scope: class {}, WorkspaceLeaf: class {},
  TextFileView: class {},
  // CM StateFields exported for third-party extension compatibility.
  editorInfoField: { id: 'stubInfo', create: () => null },
  editorLivePreviewField: { id: 'stubLp', create: () => false },
  // Math rendering (used by the live-preview math widget).
  renderMath: () => document.createElement('span'),
  finishRenderMath: async () => {},
  loadMathJax: async () => {},
};
