// TextMate 引擎（vscode-textmate + vscode-oniguruma）
// 已安装扩展的 grammar 注册中心：scopeName → 语法 JSON、fence 语言别名 →
// scopeName。供 tmHighlight 的代码块编辑态高亮查询与 tokenize。
//
// oniguruma wasm 经 esbuild base64 内联（define 注入 __ONIG_WASM_B64__，
// 与 wa-sqlite 同策略：单文件部署、离线可用）。

import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { Registry, type IGrammar, type IRawGrammar } from 'vscode-textmate';
import type { InstalledExtension } from './types';

declare const __ONIG_WASM_B64__: string | undefined;

let wasmLoaded = false;
async function ensureWasm(): Promise<void> {
  if (wasmLoaded) return;
  const b64 = typeof __ONIG_WASM_B64__ === 'string' ? __ONIG_WASM_B64__ : '';
  if (!b64) throw new Error('oniguruma wasm 未内联（构建配置缺失）');
  // base64 → 二进制（btoa/atob 在渲染进程可用；大数组分块避免栈溢出）
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await loadWASM({ data: bytes });
  wasmLoaded = true;
}

// scopeName → 原始语法 JSON（已安装扩展提供；嵌入语法的 loadGrammar 回调也查这里）
const grammarMap = new Map<string, IRawGrammar>();
// fence 语言名（含别名，小写）→ scopeName
const fenceAlias = new Map<string, string>();
// 注册来源扩展 id 集合（防重复注册/重复注销）
const registeredExts = new Set<string>();

// scopeName → 已解析 IGrammar 缓存（Registry.loadGrammar 本身有缓存，这里直接靠它）
let registry: Registry | null = null;

function ensureRegistry(): Registry {
  if (!registry) {
    registry = new Registry({
      onigLib: ensureWasm().then(() => ({
        createOnigScanner: (sources: string[]) => new OnigScanner(sources),
        createOnigString: (str: string) => new OnigString(str),
      })),
      loadGrammar: async (scopeName: string) => grammarMap.get(scopeName) ?? null,
    });
  }
  return registry;
}

/** 注册一个启用扩展的全部语法贡献（重复调用幂等） */
export function registerGrammarFromExtension(ext: InstalledExtension): void {
  if (registeredExts.has(ext.id)) return;
  const contributes = ext.contributes;
  if (!contributes) return;
  // grammar 文件：contributes.grammars[].path → ext.files[path]（tmLanguage JSON 文本）
  for (const g of contributes.grammars ?? []) {
    if (!g.scopeName || !g.path) continue;
    const raw = ext.files[g.path] ?? ext.files[g.path.replace(/^\.\//, '')];
    if (raw === undefined) continue;
    try {
      grammarMap.set(g.scopeName, JSON.parse(raw) as IRawGrammar);
    } catch {
      // 语法 JSON 损坏时跳过该条
    }
  }
  // fence 别名：languages[].id + aliases + extensions（".py" → 语言 id）与 grammar.language 关联
  for (const lang of contributes.languages ?? []) {
    const grammarForLang = (contributes.grammars ?? []).find((g) => g.language === lang.id);
    const scopeName = grammarForLang?.scopeName;
    if (!scopeName || !grammarMap.has(scopeName)) continue;
    const names = new Set<string>([lang.id.toLowerCase()]);
    for (const a of lang.aliases ?? []) names.add(a.toLowerCase());
    for (const e of lang.extensions ?? []) names.add(e.replace(/^\./, '').toLowerCase());
    for (const n of names) fenceAlias.set(n, scopeName);
  }
  // grammar 自声明 language（无 languages 块）也补别名
  for (const g of contributes.grammars ?? []) {
    if (g.language && grammarMap.has(g.scopeName)) {
      fenceAlias.set(g.language.toLowerCase(), g.scopeName);
    }
  }
  registeredExts.add(ext.id);
}

/** 注销一个（被禁用/卸载）扩展的全部语法贡献 */
export function unregisterGrammarFromExtension(ext: InstalledExtension): void {
  if (!registeredExts.has(ext.id)) return;
  const contributes = ext.contributes;
  for (const g of contributes?.grammars ?? []) {
    if (g.scopeName) grammarMap.delete(g.scopeName);
    if (g.language) fenceAlias.delete(g.language.toLowerCase());
  }
  for (const lang of contributes?.languages ?? []) {
    fenceAlias.delete(lang.id.toLowerCase());
    for (const a of lang.aliases ?? []) fenceAlias.delete(a.toLowerCase());
    for (const e of lang.extensions ?? []) fenceAlias.delete(e.replace(/^\./, '').toLowerCase());
  }
  registeredExts.delete(ext.id);
}

/** fence 语言是否命中已安装的 TM 语法 */
export function hasGrammarForFence(lang: string): boolean {
  return fenceAlias.has(lang.toLowerCase());
}

/** 取 fence 语言的 IGrammar（未命中/解析失败返回 null → 调用方回落 Prism） */
export async function getGrammarForFence(lang: string): Promise<IGrammar | null> {
  const scopeName = fenceAlias.get(lang.toLowerCase());
  if (!scopeName) return null;
  try {
    const reg = ensureRegistry();
    return (await reg.loadGrammar(scopeName)) ?? null;
  } catch {
    return null;
  }
}

/** 引擎就绪探测（wasm 加载失败时 UI/消费端可提示） */
export async function ensureTmEngineReady(): Promise<void> {
  ensureRegistry();
  await ensureWasm();
}
