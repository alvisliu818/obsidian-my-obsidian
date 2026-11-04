// 已装扩展的 TextMate 语法 → Monaco 桥(移植自 siyuan-virtual-tree grammar-loader)。
// 复用 tmEngine 的 registry/grammarMap/fenceAlias(onig wasm 已 base64 内联),
// 把 IGrammar 注册为 Monaco 的 tokens provider —— 市场扩展覆盖内置 monarch。
import type * as monacoNs from 'monaco-editor';
import { monaco } from '../editor/lazyMonaco';
import { INITIAL } from 'vscode-textmate';
import { getGrammarForFence, hasGrammarForFence } from './tmEngine';

const registered = new Set<string>();
// 语言 → setTokensProvider 的句柄。禁用/卸载语法扩展时 dispose,否则已挂的
// TM provider 会陈旧残留(fenceAlias 已删但 provider 永远生效)。
const providers = new Map<string, monacoNs.IDisposable>();

class TMState implements monacoNs.languages.IState {
  constructor(public ruleStack: unknown) {}
  clone(): monacoNs.languages.IState {
    return new TMState(this.ruleStack);
  }
  equals(other: monacoNs.languages.IState): boolean {
    return other instanceof TMState && other.ruleStack === this.ruleStack;
  }
}

/**
 * 把某 fence 语言的已装 TM 语法注册进 Monaco(异步加载完成后实时切换 tokenizer)。
 *
 * force:重新挂 provider(consumeFn 在扩展安装/启用/启动恢复后调用 —— 编辑器
 * 创建可能早于扩展恢复完成,createEditor 时的首次注册因 fence 未命中空手而归,
 * 此后没人再补;force 重挂后 setTokensProvider fire change,已打开的 model
 * 自动重分词,无需重开文件)。幂等调用默认跳过。
 */
export async function registerTmGrammarForMonaco(
  lang: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  const id = lang.toLowerCase();
  if (!hasGrammarForFence(id)) return false;
  if (registered.has(id) && !opts?.force) return false;
  const grammar = await getGrammarForFence(id);
  if (!grammar) return false;
  if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
    monaco.languages.register({ id, aliases: [id] });
  }
  providers.get(id)?.dispose();
  providers.set(
    id,
    monaco.languages.setTokensProvider(id, {
      getInitialState: () => new TMState(INITIAL),
      tokenize(line: string, state: TMState) {
        const result = grammar.tokenizeLine(line, state.ruleStack as never);
        if (!result) return { tokens: [], endState: state };
        const tokens = result.tokens.map((tk) => ({
          startIndex: tk.startIndex,
          // 传最内层 scope 名,Monaco 主题按前缀匹配(vs 的 token 规则同源)
          scopes: tk.scopes[tk.scopes.length - 1],
        }));
        return { tokens, endState: new TMState(result.ruleStack) };
      },
    }),
  );
  registered.add(id);
  console.info(`[lgp-tm] tokens provider registered for ${id}${opts?.force ? ' (force)' : ''}`);
  return true;
}

/** 注销某语言的 TM provider(语法扩展被禁用/卸载时;未注册过则无事发生)。 */
export function disposeTmGrammarForMonaco(lang: string): void {
  const id = lang.toLowerCase();
  providers.get(id)?.dispose();
  providers.delete(id);
  registered.delete(id);
}
