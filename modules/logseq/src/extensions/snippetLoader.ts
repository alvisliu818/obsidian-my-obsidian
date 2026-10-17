// 代码片段加载器：VSCode 扩展的 snippets JSON → Monaco completion provider。
// 移植自 siyuan-virtual-tree snippet-loader（约定与消费端注册方式对齐本模块）。
//
// VSCode snippet JSON 结构:
//   {
//     "Snippet Name": {
//       "prefix": "log",
//       "body": ["console.log(${1:var})", "$2"],
//       "description": "Log to console"
//     }
//   }
import * as monaco from 'monaco-editor';
import type { InstalledExtension } from './types';

interface Snippet {
  name: string;
  prefix: string;
  body: string;
  description: string;
}

// 已注册的 provider dispose 句柄（按扩展 id）
const registeredProviders = new Map<string, monaco.IDisposable[]>();
// 已注册的片段数（按扩展 id），供 LoadResult 回填
const registeredCounts = new Map<string, number>();

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

/** 加载扩展的代码片段贡献，返回注册的片段条数（重复调用先清理旧的，幂等） */
export function loadSnippets(extension: InstalledExtension): number {
  removeExtensionSnippets(extension.id);

  const contributes = extension.contributes;
  if (!contributes?.snippets || contributes.snippets.length === 0) return 0;

  const disposables: monaco.IDisposable[] = [];
  let count = 0;
  // 按语言分组（同一语言的多个 snippet 文件合并）
  const languageSnippets = new Map<string, Snippet[]>();

  for (const snippetContribution of contributes.snippets) {
    try {
      const content = extension.files[normalizePath(snippetContribution.path || '')];
      if (!content) continue;
      const snippetsData = JSON.parse(content);
      const language = snippetContribution.language || snippetContribution.languageId || 'plaintext';

      const snippets: Snippet[] = [];
      for (const [name, value] of Object.entries(snippetsData)) {
        const s = value as any;
        if (s.prefix && s.body) {
          snippets.push({
            name,
            prefix: Array.isArray(s.prefix) ? s.prefix[0] : s.prefix,
            body: Array.isArray(s.body) ? s.body.join('\n') : s.body,
            description: s.description || '',
          });
        }
      }

      if (snippets.length > 0) {
        const existing = languageSnippets.get(language) || [];
        languageSnippets.set(language, [...existing, ...snippets]);
        count += snippets.length;
      }
    } catch {
      // 单个 snippet 文件损坏不影响其余
    }
  }

  for (const [language, snippets] of languageSnippets) {
    const provider = monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: snippets.map((s) => ({
            label: s.prefix,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: s.name,
            documentation: s.description,
            range,
          })),
        };
      },
    });
    disposables.push(provider);
  }

  if (disposables.length > 0) {
    registeredProviders.set(extension.id, disposables);
    registeredCounts.set(extension.id, count);
  }
  return count;
}

/** 移除扩展的代码片段（禁用/卸载时调用） */
export function removeExtensionSnippets(extensionId: string): void {
  const disposables = registeredProviders.get(extensionId);
  if (disposables) {
    disposables.forEach((d) => d.dispose());
    registeredProviders.delete(extensionId);
  }
  registeredCounts.delete(extensionId);
}

/** 某扩展当前注册的片段数（未注册为 0） */
export function getSnippetCount(extensionId: string): number {
  return registeredCounts.get(extensionId) ?? 0;
}

/** 清理所有代码片段 */
export function clearAllSnippets(): void {
  registeredProviders.forEach((disposables) => disposables.forEach((d) => d.dispose()));
  registeredProviders.clear();
  registeredCounts.clear();
}
