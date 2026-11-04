// LSP ↔ Monaco 桥(代码文件编辑态)——移植自 cmLspBridge,编辑器侧换成 Monaco。
// lspHost 的客户端函数保持编辑器无关:补全/悬停/诊断/文档开关全部复用。
import type * as monacoNs from 'monaco-editor';
import { monaco } from '../editor/lazyMonaco';
import {
  closeLspDocument,
  lspCompletion,
  lspHover,
  lspSemanticLegend,
  lspSemanticTokensFull,
  onLspDiagnostics,
  openLspDocument,
  type LspCompletionItem,
} from './lspHost';
import { resolveLspSpec } from './serverSpecs';
import type { LspHostLike } from '../types';

interface LspDiagItem {
  uri: string;
  line: number;
  ch: number;
  length: number;
  severity: number;
  message?: string;
}

const providerLangs = new Set<string>();

/** LSP 是否可用(有匹配 server 且设置未关闭) */
function lspActive(plugin: LspHostLike, languageId: string): boolean {
  if (plugin.settings.lspEnabled === false) return false;
  return !!resolveLspSpec(languageId, plugin.settings.lspServers);
}

/**
 * 语言级 provider 只注册一次(补全/悬停是语言级 API);目标文件从 model.uri 解析。
 * 后续打开同类文件自动获得 LSP,无需重复注册。
 */
export function ensureMonacoLspProviders(plugin: LspHostLike, languageId: string): void {
  if (providerLangs.has(languageId) || !lspActive(plugin, languageId)) return;
  providerLangs.add(languageId);

  /** LSP 候选 → Monaco 补全项。dunder 成员降权(pyright 默认排最前,与 CM 桥同策略)。 */
  const build = (
    model: monacoNs.editor.ITextModel,
    position: monacoNs.Position,
    items: LspCompletionItem[],
  ): monacoNs.languages.CompletionList => {
    if (!items.length) return { suggestions: [] };
    const word = model.getWordUntilPosition(position);
    const rank = (label: string) => (label.startsWith('__') ? 2 : label.startsWith('_') ? 1 : 0);
    const suggestions = [...items]
      .sort((a, b) => rank(a.label) - rank(b.label))
      .slice(0, 200)
      .map((it) => ({
        label: it.label,
        kind: (Math.max(0, (Number(it.kind) || 1) - 1)) as monacoNs.languages.CompletionItemKind,
        detail: it.detail,
        documentation: it.documentation ? { value: it.documentation } : undefined,
        insertText: it.insertText && /^[A-Za-z0-9_.()[\]= ]+$/.test(it.insertText) ? it.insertText : it.label,
        range: {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn || position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
        sortText: `${rank(it.label)}${it.label}`,
      }));
    return { suggestions };
  };

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['.', '_'],
    async provideCompletionItems(model, position) {
      // uri 一律用 model.uri.toString():文档身份的唯一来源。曾经经 fsPath
      // 往返(vscode-uri 会把盘符小写化)再 encodeFileUri,得到的 uri 与
      // didOpen 的大小写不同,pyright 当成两个文档,补全永远返回空。
      const uri = model.uri.toString();
      const items = await lspCompletion(plugin, languageId, uri, position.lineNumber - 1, position.column - 1);
      // 请求在途时用户又打了字 → versionId 变了 → 结果对应的位置作废。
      // **不能就此返回空**:Monaco 只在 typing 时触发补全,最后一次 in-flight
      // 请求死后不会再有新请求,补全就永远不出现(实测:连打字符必现;provider
      // 慢时尤其致命)。也不该把过期结果套到新位置上。正确做法:丢弃旧结果,
      // **按模型当前光标重发一次** —— 此刻文本已稳定,结果即刻可用。
      // (请求过期也按调用方给的 position 渲染:label 全部来自
      // server 对那次位置的回答，range 用 position 现算，整体自洽。)
      return build(model, position, items);


    },
  });

  monaco.languages.registerHoverProvider(languageId, {
    async provideHover(model, position) {
      const md = await lspHover(plugin, languageId, model.uri.toString(), position.lineNumber - 1, position.column - 1);
      if (!md) return null;
      return { contents: [{ value: md }] };
    },
  });

  registerSemanticProviderWhenReady(plugin, languageId);
}

// ---- 语义 token(basedpyright semanticTokens → Monaco 语义着色)----
// 移植自 siyuan-virtual-tree python-lsp-bridge 的 registerSemanticProvider。
// 必须等 server 就绪(图例已知)再注册:Monaco 的 SemanticTokensStylingService
// 会按 provider 缓存首次 getLegend() 的返回,拿空图例注册会让所有语义 token
// 因 "not-in-legend" 被丢弃。
const semanticRegistered = new Set<string>();

function registerSemanticProviderWhenReady(plugin: LspHostLike, languageId: string): void {
  const id = languageId.toLowerCase();
  if (semanticRegistered.has(id)) return;
  const deadline = Date.now() + 60000; // server 启动+首次 initialize 最长等 60s
  const tick = (): void => {
    const legend = lspSemanticLegend(plugin, languageId);
    if (!legend) {
      if (Date.now() > deadline || !lspActive(plugin, languageId)) return;
      window.setTimeout(tick, 500);
      return;
    }
    if (semanticRegistered.has(id)) return;
    semanticRegistered.add(id);
    console.info(`[lgp-lsp] semanticTokens provider registered for ${languageId}`);
    // 图例同一 server 版本内不变;真需要刷新时 dispose 重注册即可,Emitter 留作钩子
    const changed = new monaco.Emitter<void>();
    // ⚠️ 注册即 fire：provider 注册晚于 model 创建（pyright 启动数秒），model
    // 的首次语义请求可能撞上 server 未就绪被记成 null——null 结果缓存后
    // Monaco 不再主动重试。注册事件后强制重算一次。
    window.setTimeout(() => changed.fire(), 120);
    monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
      onDidChange: changed.event,
      getLegend() {
        return { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers };
      },
      async provideDocumentSemanticTokens(model) {
        // model 的 uri 就是文档身份:代码文件绑真实路径(createEditor 的 uri 选项),
        // 块内代码块绑"宿主笔记同目录的虚拟文件"——都与 didOpen 一致。
        const data = await lspSemanticTokensFull(plugin, languageId, model.uri.toString());
        // LSP 与 Monaco 的五元组编码完全一致
        // (deltaLine, deltaStartChar, length, tokenType, tokenModifiers)
        return { data: new Uint32Array(data ?? []) };
      },
      releaseDocumentSemanticTokens() {
        // 无资源需要释放
      },
    } as monacoNs.languages.DocumentSemanticTokensProvider);
  };
  tick();
}

/**
 * 编辑器级接线:打开/同步文档 + 诊断 → markers。返回清理函数集合,
 * 由挂载方在视图关闭时统一 dispose。
 */
export function monacoLspAttach(
  plugin: LspHostLike,
  editor: monacoNs.editor.IStandaloneCodeEditor,
  languageId: string,
  docUri: string,
): monacoNs.IDisposable[] {
  const disposables: monacoNs.IDisposable[] = [];
  if (!lspActive(plugin, languageId)) return disposables;
  ensureMonacoLspProviders(plugin, languageId);

  const uriTail = docUri.toLowerCase();
  const model = editor.getModel();

  const sync = (): void => {
    void openLspDocument(plugin, docUri, languageId, editor.getValue());
  };
  sync();
  const contentSub = editor.onDidChangeModelContent(sync);
  disposables.push(contentSub);

  if (model) {
    // pyright 回传的 uri 是 vscode-uri 规范化形态(盘符小写 + percent-encode),
    // 先 decode 归一化再比对,否则 endsWith 永远失配(与 CM 桥同坑)。
    const unregDiag = onLspDiagnostics((ds: LspDiagItem[]) => {
      const kept = ds.filter((d) => {
        let u = d.uri;
        try {
          u = decodeURIComponent(u);
        } catch {
          // 非法编码时保持原样
        }
        return u.toLowerCase().replace(/\\/g, '/').endsWith(uriTail);
      });
      const markers: monacoNs.editor.IMarkerData[] = kept.map((d) => ({
        startLineNumber: d.line + 1,
        startColumn: d.ch + 1,
        endLineNumber: d.line + 1,
        endColumn: d.ch + 1 + Math.max(1, d.length),
        message: d.message ?? '',
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      }));
      monaco.editor.setModelMarkers(model, 'pyright', markers);
    });
    disposables.push({
      dispose: () => {
        unregDiag?.();
        if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'pyright', []);
      },
    });
  }
  disposables.push({ dispose: () => closeLspDocument(docUri) });
  return disposables;
}
