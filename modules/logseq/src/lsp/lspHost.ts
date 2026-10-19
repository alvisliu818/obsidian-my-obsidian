// 通用 LSP 语言服务器宿主（多语言）。
//
// 语言 → 服务器映射由 LspServerSpec 描述（settings.lspServers + 内置 pyright，
// 见 serverSpecs.ts），按 serverId 管理多个 LspClient。内置 pyright 保留专属
// 语义（选定 Python 环境前置 PATH + workspace/configuration 动态 section）；
// generic 服务器（typescript-language-server、clangd 等）直接按 spec 启动。
//
// 启动命令：
//   launch:'node'   → <系统 node.exe> <command> <args...>（node.exe 复用终端
//                     的发现逻辑；command 相对插件目录或绝对路径）
//   launch:'direct' → <command> <args...>（PATH 上的可执行文件，如 clangd）
//
// 诊断：所有 server 的 publishDiagnostics 统一进多播监听（bridge 按 uri 过滤）。

import type LogseqEditorPlugin from '../main';
import type { LspServerSpec } from '../types';
import { resolveLspSpec, isPyrightLike } from './serverSpecs';
import { getActivePythonEnv } from '../exec/activeEnv';
import { spawnEnvFor } from '../exec/pythonEnvs';
import type { LspClient } from './lspClient';

interface ServerState {
  spec: LspServerSpec;
  client: LspClient | null;
  starting: Promise<LspClient | null> | null;
  /** uri → version（本 server 打开的文档） */
  openDocs: Map<string, number>;
  /** pyright：启动时的环境指纹（python 路径），变化即重启；generic 恒 '' */
  envKey: string;
}

const states = new Map<string, ServerState>();
const diagListeners = new Set<(ds: LspDiagnostic[]) => void>();

// 首次调用时缓存的宿主上下文（manifest.dir 是相对路径，需要插件实例解析）
let hostCtx: { absPluginDir: string; vaultRoot: string } | null = null;

function hostContextOf(plugin: LogseqEditorPlugin): { absPluginDir: string; vaultRoot: string } {
  if (hostCtx) return hostCtx;
  const { absolutePluginDir } = require('../terminal/ptyClient') as typeof import('../terminal/ptyClient');
  const absPluginDir = absolutePluginDir(plugin.manifest.dir ?? '', plugin.app.vault.adapter);
  const adapter = plugin.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
  const vaultRoot = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : adapter.basePath || '';
  hostCtx = { absPluginDir, vaultRoot };
  return hostCtx;
}

export function encodeFileUri(absPath: string): string {
  const p = absPath.replace(/\\/g, '/');
  const enc = p
    .split('/')
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join('/');
  return `file:///${enc.replace(/^\/+/, '')}`;
}

export function decodeUri(uri: string): string {
  let p = uri.replace(/^file:\/\/\//, '').replace(/\//g, '\\');
  try {
    p = decodeURIComponent(p);
  } catch {
    // 保持原样
  }
  return p;
}

export interface LspDiagnostic {
  uri: string;
  line: number; // 0-based
  ch: number; // 0-based UTF-16 列
  length: number; // UTF-16 长度
  severity: number; // 1=error 2=warning 3=info 4=hint
  message: string;
  source?: string;
}

/** 订阅诊断（CM 桥挂载时注册）；返回取消函数。多 server 统一多播。 */
export function onLspDiagnostics(fn: (ds: LspDiagnostic[]) => void): () => void {
  diagListeners.add(fn);
  return () => {
    diagListeners.delete(fn);
  };
}

function dispatchDiagnostics(msg: { params?: Record<string, unknown> }): void {
  if (!diagListeners.size) return;
  const params = msg.params ?? {};
  const uri = String(params.uri ?? '');
  const rawDiags = (params.diagnostics ?? []) as {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
    message: string;
    source?: string;
  }[];
  const ds = rawDiags.map((d) => ({
    uri,
    line: d.range.start.line,
    ch: d.range.start.character,
    length: Math.max(0, (d.range.end.character - d.range.start.character) || 1),
    severity: d.severity ?? 1,
    message: d.message,
    source: d.source,
  }));
  for (const fn of diagListeners) fn(ds);
}

/**
 * python 系语言服务器的启动定位。三档兜底（越靠前越省事）：
 *   1. 插件目录自带：`basedpyright/dist/basedpyright-langserver.js`（部署脚本复制）
 *      —— 不依赖 PATH 与网络，离线可用；
 *   2. PATH 上的 `basedpyright-langserver`；
 *   3. `uvx basedpyright-langserver --stdio`：本机装了 uv 时首次运行自动拉包，
 *      之后走 uv 缓存。
 * pyright（旧 id）沿用同样的顺序，只是找 pyright 的文件名。
 */
function resolvePyrightLaunch(absPluginDir: string, id: string): { launch: 'node' | 'direct'; command: string; args: string[] } {
  const scripts =
    id === 'basedpyright'
      ? ['basedpyright\\dist\\basedpyright-langserver.js', 'basedpyright\\dist\\pyright-langserver.js']
      : ['pyright\\dist\\pyright-langserver.js'];
  try {
    const { existsSync } = require('fs') as typeof import('fs');
    for (const rel of scripts) {
      const bundled = `${absPluginDir}\\${rel}`;
      if (existsSync(bundled)) return { launch: 'node', command: bundled, args: ['--stdio'] };
    }
  } catch {
    // 忽略（existsSync 不可用则退回 PATH）
  }
  const exe = id === 'basedpyright' ? 'basedpyright-langserver' : 'pyright-langserver';
  return { launch: 'direct', command: exe, args: ['--stdio'] };
}

async function startServer(plugin: LogseqEditorPlugin, spec: LspServerSpec): Promise<LspClient> {
  const { absPluginDir, vaultRoot } = hostContextOf(plugin);
  const isPyright = isPyrightLike(spec);

  let command: string;
  let args: string[];
  let env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (isPyright) {
    const launch = resolvePyrightLaunch(absPluginDir, spec.id);
    if (launch.launch === 'node') {
      const { findNodeExe } = await import('../terminal/ptyClient');
      const node = await findNodeExe();
      if (!node) throw new Error('LSP 需要 Node.js（与终端共用 node.exe 发现）');
      command = node;
      args = [launch.command, ...launch.args];
    } else {
      command = launch.command;
      args = launch.args;
    }
    // basedpyright/pyright 内部按 PATH 探测 python 解析 site-packages；渲染进程
    // PATH 可能带着别的 python（灵犀/python-env 等），必须用选定环境前置覆盖，
    // 否则 numpy/torch 全解析不到。
    env = spawnEnvFor(getActivePythonEnv(), { ...process.env } as Record<string, string>);
  } else if (spec.launch === 'node') {
    const { findNodeExe } = await import('../terminal/ptyClient');
    const node = await findNodeExe();
    if (!node) throw new Error(`LSP(${spec.id}) 需要 Node.js`);
    const script = /^[a-zA-Z]:[\\/]/.test(spec.command) ? spec.command : `${absPluginDir}\\${spec.command.replace(/\//g, '\\')}`;
    command = node;
    args = [script, ...spec.args];
  } else {
    command = spec.command;
    args = spec.args;
  }

  const { LspClient } = await import('./lspClient');
  const c = new LspClient();
  await c.start({ command, args, env });

  const pythonPath = isPyright ? (getActivePythonEnv()?.cmd ?? null) : null;

  const init = (await c.request(
    'initialize',
    {
      processId: null,
      rootUri: encodeFileUri(vaultRoot),
      capabilities: {
        textDocument: {
          completion: { completionItem: { documentationFormat: ['markdown', 'plaintext'] } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
        },
      },
      initializationOptions: pythonPath ? { pythonPath } : {},
    },
    30000,
  )) as Record<string, unknown>;
  void init;
  c.notify('initialized', {});

  // workspace/configuration：pyright 动态 section（环境跟随）；generic 用 spec.config 静态表
  c.on('message', (msg: { id?: number; method?: string; params?: { items?: { section?: string }[] } }) => {
    if (msg.method === 'workspace/configuration' && msg.id != null) {
      const items = msg.params?.items ?? [];
      if (isPyright) {
        c.reply(
          msg.id,
          items.map((it) => {
            if (it?.section === 'python') return { pythonPath: pythonPath ?? undefined };
            if (it?.section === 'pyright') return { pythonPath: pythonPath ?? undefined, openFilesOnly: false, useLibraryCodeForTypes: true };
            return {};
          }),
        );
      } else {
        const cfg = new Map((spec.config ?? []).map((e) => [e.section, e.value]));
        c.reply(
          msg.id,
          items.map((it) => (it?.section != null && cfg.has(it.section) ? cfg.get(it.section) : {})),
        );
      }
    } else if (msg.method === 'client/registerCapability') {
      c.reply(msg.id!, null);
    } else if (msg.method === 'window/workDoneProgress/create') {
      c.reply(msg.id!, null);
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      dispatchDiagnostics(msg as { params?: Record<string, unknown> });
    }
  });

  return c;
}

function stateOf(spec: LspServerSpec): ServerState {
  let st = states.get(spec.id);
  if (!st) {
    st = { spec, client: null, starting: null, openDocs: new Map(), envKey: '' };
    states.set(spec.id, st);
  }
  st.spec = spec; // 配置可能被设置更新（如 enabled/args），以最新为准
  return st;
}

/** 获取（或启动）某语言的 server；python 系环境变化时自动重启 */
async function ensureServer(plugin: LogseqEditorPlugin, spec: LspServerSpec): Promise<LspClient | null> {
  const st = stateOf(spec);
  const isPyright = isPyrightLike(spec);
  const envKeyNow = isPyright ? (getActivePythonEnv()?.cmd ?? '') : '';
  if (st.client?.isAlive && st.envKey === envKeyNow) return st.client;
  if (st.starting) return st.starting;
  if (st.client) {
    const old = st.client;
    st.client = null;
    st.openDocs.clear();
    await old.stop();
  }
  st.envKey = envKeyNow;
  st.starting = (async () => {
    try {
      const c = await startServer(plugin, spec);
      st.client = c;
      console.info(`[lgp-lsp] ${spec.id} 已启动`);
      return c;
    } catch (e) {
      console.warn(`[lgp-lsp] ${spec.id} 启动失败:`, e);
      return null;
    } finally {
      st.starting = null;
    }
  })();
  return st.starting;
}

/** 打开（或全量更新）一份文档；返回是否有 server 接管 */
export async function openLspDocument(plugin: LogseqEditorPlugin, uri: string, languageId: string, text: string): Promise<boolean> {
  const spec = resolveLspSpec(languageId, plugin.settings.lspServers);
  if (!spec) return false;
  const st = stateOf(spec);
  const c = await ensureServer(plugin, spec);
  if (!c) return false;
  const ver = (st.openDocs.get(uri) ?? 0) + 1;
  st.openDocs.set(uri, ver);
  if (ver === 1) {
    c.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: ver, text } });
  } else {
    c.notify('textDocument/didChange', { textDocument: { uri, version: ver }, contentChanges: [{ text }] });
  }
  return true;
}

export function closeLspDocument(uri: string): void {
  for (const st of states.values()) {
    if (!st.client?.isAlive) continue;
    if (!st.openDocs.has(uri)) continue;
    st.client.notify('textDocument/didClose', { textDocument: { uri } });
    st.openDocs.delete(uri);
    return;
  }
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

export async function lspCompletion(plugin: LogseqEditorPlugin, languageId: string, uri: string, line: number, ch: number): Promise<LspCompletionItem[]> {
  const spec = resolveLspSpec(languageId, plugin.settings.lspServers);
  if (!spec) return [];
  const st = states.get(spec.id);
  if (!st?.client?.isAlive) {
    console.warn('[lgp-lsp] completion skipped: server not alive');
    return [];
  }
  try {
    const result = (await st.client.request(
      'textDocument/completion',
      { textDocument: { uri }, position: { line, character: ch } },
      20000, // 首次请求时 basedpyright 还在分析刚 didOpen 的文档,8s 不够
    )) as unknown;
    const items = Array.isArray(result) ? result : ((result as { items?: unknown[] })?.items ?? []);
    return (items as { label: string; kind?: number; detail?: string; documentation?: string | { value: string }; insertText?: string }[]).map((it) => ({
      label: String(it.label),
      kind: it.kind,
      detail: it.detail,
      documentation: typeof it.documentation === 'string' ? it.documentation : it.documentation?.value,
      insertText: it.insertText,
    }));
  } catch {
    return [];
  }
}

export async function lspHover(plugin: LogseqEditorPlugin, languageId: string, uri: string, line: number, ch: number): Promise<string | null> {
  const spec = resolveLspSpec(languageId, plugin.settings.lspServers);
  if (!spec) return null;
  const st = states.get(spec.id);
  if (!st?.client?.isAlive) return null;
  try {
    const result = (await st.client.request(
      'textDocument/hover',
      { textDocument: { uri }, position: { line, character: ch } },
      8000,
    )) as { contents?: string | { kind?: string; value: string } | { value: string }[] } | null;
    if (!result?.contents) return null;
    const c = result.contents;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => x.value).join('\n\n');
    return c.value ?? null;
  } catch {
    return null;
  }
}

/** 插件卸载：停止全部 server */
export async function shutdownAllLsp(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const st of states.values()) {
    const c = st.client;
    st.client = null;
    st.openDocs.clear();
    if (c) jobs.push(c.stop());
  }
  states.clear();
  diagListeners.clear();
  await Promise.all(jobs);
}
