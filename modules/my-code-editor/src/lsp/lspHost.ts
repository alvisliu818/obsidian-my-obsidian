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

import type { LspHostLike, LspServerSpec } from '../types';
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
  /** 语义 token 图例（initialize 响应捕获；server 不支持/未就绪 = null） */
  semanticLegend: LspSemanticLegend | null;
}

const states = new Map<string, ServerState>();
const diagListeners = new Set<(ds: LspDiagnostic[]) => void>();

/** 语义 token 图例(server initialize 响应里声明;null = 该 server 不支持) */
export interface LspSemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

// 客户端可解码的语义 token 类型/修饰符(能力握手声明;服务端用自己的 legend 回,
// 这里只是握手的一部分。表抄思源侧 python-lsp 的 basedpyright 1.40 实测值)。
const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'typeParameter', 'parameter', 'variable',
  'property', 'enumMember', 'function', 'method', 'keyword', 'decorator',
  'selfParameter', 'clsParameter',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'async', 'defaultLibrary',
  'builtin', 'classMember', 'parameter',
];

// 首次调用时缓存的宿主上下文（manifest.dir 是相对路径，需要插件实例解析）
let hostCtx: { absPluginDir: string; vaultRoot: string } | null = null;

function hostContextOf(plugin: LspHostLike): { absPluginDir: string; vaultRoot: string } {
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

async function startServer(plugin: LspHostLike, spec: LspServerSpec): Promise<{ client: LspClient; semanticLegend: LspSemanticLegend | null }> {
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
          // 语义 token:basedpyright 实测 gate(思源侧 python-lsp 探针两次对照)——
          // dynamicRegistration 不声明 true 时 initialize 结果里根本不会出现
          // semanticTokensProvider,语义着色拿不到数据源。registerCapability
          // 我们照样回 null(下面 message 分发),basedpyright 是静态声明,不实际走。
          semanticTokens: {
            dynamicRegistration: true,
            tokenTypes: SEMANTIC_TOKEN_TYPES,
            tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            formats: ['relative'],
            requests: { range: false, full: { delta: false } },
            multilineTokenSupport: false,
            overlappingTokenSupport: false,
            serverCancelSupport: false,
            augmentsSyntaxTokens: true,
          },
        },
      },
      initializationOptions: pythonPath ? { pythonPath } : {},
    },
    30000,
  )) as { capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: string[]; tokenModifiers?: string[] } } } };
  const stp = init?.capabilities?.semanticTokensProvider;
  const semanticLegend: LspSemanticLegend | null =
    stp?.legend?.tokenTypes?.length
      ? { tokenTypes: stp.legend.tokenTypes, tokenModifiers: stp.legend.tokenModifiers ?? [] }
      : null;
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

  return { client: c, semanticLegend };
}

function stateOf(spec: LspServerSpec): ServerState {
  let st = states.get(spec.id);
  if (!st) {
    st = { spec, client: null, starting: null, openDocs: new Map(), envKey: '', semanticLegend: null };
    states.set(spec.id, st);
  }
  st.spec = spec; // 配置可能被设置更新（如 enabled/args），以最新为准
  return st;
}

/** 获取（或启动）某语言的 server；python 系环境变化时自动重启 */
async function ensureServer(plugin: LspHostLike, spec: LspServerSpec): Promise<LspClient | null> {
  const st = stateOf(spec);
  const isPyright = isPyrightLike(spec);
  const envKeyNow = isPyright ? (getActivePythonEnv()?.cmd ?? '') : '';
  if (st.client?.isAlive && st.envKey === envKeyNow) return st.client;
  if (st.starting) return st.starting;
  if (st.client) {
    const old = st.client;
    st.client = null;
    st.openDocs.clear();
    st.semanticLegend = null; // 重启后图例要随 initialize 重新捕获
    await old.stop();
  }
  st.envKey = envKeyNow;
  st.starting = (async () => {
    try {
      const started = await startServer(plugin, spec);
      st.client = started.client;
      st.semanticLegend = started.semanticLegend;
      if (started.semanticLegend) {
        console.info(`[lgp-lsp] ${spec.id} semanticTokens 可用:${started.semanticLegend.tokenTypes.length} types`);
      }
      console.info(`[lgp-lsp] ${spec.id} 已启动`);
      return started.client;
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
export async function openLspDocument(plugin: LspHostLike, uri: string, languageId: string, text: string): Promise<boolean> {
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

export async function lspCompletion(plugin: LspHostLike, languageId: string, uri: string, line: number, ch: number): Promise<LspCompletionItem[]> {
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

export async function lspHover(plugin: LspHostLike, languageId: string, uri: string, line: number, ch: number): Promise<string | null> {
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

/** 某语言的语义 token 图例;server 未就绪/不支持/语言无 server 时返回 null */
export function lspSemanticLegend(plugin: LspHostLike, languageId: string): LspSemanticLegend | null {
  const spec = resolveLspSpec(languageId, plugin.settings.lspServers);
  if (!spec) return null;
  return states.get(spec.id)?.semanticLegend ?? null;
}

/**
 * 全文档语义 token(LSP 五元组 deltaLine/deltaStartChar/length/type/modifiers)。
 * 与 Monaco registerDocumentSemanticTokensProvider 期望的编码完全一致,
 * bridge 层直接转 Uint32Array 即可。失败/未就绪返回 null(调用方回空集)。
 */
export async function lspSemanticTokensFull(plugin: LspHostLike, languageId: string, uri: string): Promise<number[] | null> {
  const spec = resolveLspSpec(languageId, plugin.settings.lspServers);
  if (!spec) return null;
  const st = states.get(spec.id);
  const client = st?.client;
  if (!st || !client) return null;
  // 诊断打点：provide 入口（每次 Monaco 请求都会打——多次出现=有重算）
  console.info(`[lgp-lsp][diag] provide enter: model=${uri.slice(-60)}`);
  const sent = resolveOpenDocUri(st, uri);
  if (!sent) {
    console.info(`[lgp-lsp][diag] semantic full: NO OPEN-DOC MATCH for ${uri.slice(-60)}`);
    return null;
  }
  try {
    const result = (await client.request(
      'textDocument/semanticTokens/full',
      { textDocument: { uri: sent } },
      10000,
    )) as { data?: number[] } | null;
    console.info(
      `[lgp-lsp][diag] semantic full: len=${result?.data?.length ?? -1} sent=${sent.slice(-60)}`,
    );
    return result?.data ?? null;
  } catch (e) {
    console.info(`[lgp-lsp][diag] semantic full FAILED: ${String(e).slice(0, 140)}`);
    return null;
  }
}

/** 在 openDocs 里找出与 uri 同一文档的 didOpen 原始字符串（精确 → 解码归一化）。 */
function resolveOpenDocUri(st: ServerState, uri: string): string | null {
  if (st.openDocs.has(uri)) return uri;
  const dec = (p: string): string => {
    let s = p;
    try { s = decodeURIComponent(s); } catch { /* 非法编码保持原样 */ }
    return s.toLowerCase();
  };
  const want = dec(uri);
  for (const key of st.openDocs.keys()) {
    if (dec(key) === want) return key;
  }
  return null;
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
