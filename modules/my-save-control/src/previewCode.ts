/**
 * 历史版本预览的代码渲染(2026-10-30 用户要求:代码版本要渲染 + 行号)。
 *
 * 预览模态此前对非 md 一律落 <pre> 裸文本——同一个插件里明明有 VS Code 同款
 * 的 Monaco。这里用同一台引擎做只读预览:行号、语法高亮、TM 扩展主题与代码
 * 编辑器全部同源;md 仍走 MarkdownRenderer(那边的「渲染」另有正主)。
 *
 * 实例必须随预览销毁:预览是偶发查看,Modal 关闭/「原始」切换/预览页签重渲染
 * 都要 dispose,否则每看一个版本堆一台 Monaco(用户对堆内存敏感,有专门的
 * heap 探针史)。
 */
import type { App } from "obsidian";
import {
  createEditor,
  getLanguageByPath,
  setupMonaco,
} from "../../my-code-editor/src/editor/monaco";

/** 在 host 里挂一台只读 Monaco;返回清场函数(调用方负责在宿主销毁前调用)。 */
export function mountCodePreview(
  host: HTMLElement,
  plugin: { app: App; manifest: { dir?: string } },
  content: string,
  fileName: string,
): () => void {
  setupMonaco(plugin);
  const editor = createEditor(host, {
    value: content,
    language: getLanguageByPath(fileName),
    lineNumbers: true,
  });
  editor.updateOptions({ readOnly: true });
  return () => {
    const model = editor.getModel();
    editor.dispose();
    model?.dispose();
  };
}
