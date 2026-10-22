// 编译期/单测替身:真正的 API 只在 Obsidian 运行时存在
// (同 modules/logseq/obsidian-stub.js 的做法)。
//
// editorLivePreviewField 必须是**真的** StateField:本模块的实时预览装饰器
// 读 `state.field(editorLivePreviewField, false)`,而探针要能把它装进
// EditorState 里让那条路径真正跑起来。
import { StateField } from "@codemirror/state";

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  register() {}
  registerMarkdownPostProcessor() {}
  registerEditorExtension() {}
}

export function renderMath(source) {
  const el = document.createElement("span");
  el.className = "math";
  el.setAttribute("data-math", source);
  el.textContent = source;
  return el;
}

export async function finishRenderMath() {}
export async function loadMathJax() {}

export const editorLivePreviewField = StateField.define({
  create: () => true,
  update: (value) => value,
});
