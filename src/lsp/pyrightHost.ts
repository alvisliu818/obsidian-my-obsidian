// pyright 语言服务器宿主（Python LSP）
//
// 启动：<node.exe> <插件目录>/pyright/dist/pyright-langserver.js --stdio
//   - node.exe 复用终端的发现逻辑（findNodeExe）
//   - pyright 随插件部署（npm 依赖复制，见部署脚本），无需全局安装
//
// 环境联动：selected Python 环境（代码运行同一个）作为 pythonPath 传给
// pyright（initializationOptions + workspace/configuration 双保险），
// 补全/诊断按该环境的包解析（如 ai 环境的 torch/numpy）。
// 环境切换后调用 invalidate() → 下一个文档操作时自动重启。

import type { LspClient } from './lspClient';
import { getActivePythonEnv } from '../exec/activeEnv';
import { spawnEnvFor } from '../exec/pythonEnvs';

let client: LspClient | null = null;
let starting: Promise<LspClient | null> | null = null;
let envKey = ''; // 启动时的环境指纹（python 路径），变化即失效
const openDocs = new Map<string, number>(); // uri → version

/** pyright 部署检测：插件目录自带（部署脚本复制）优先，其次 PATH 上的全局 */
function locatePyright(absPluginDir: string): { args: string[] } | null {
  const bundled = `${absPluginDir}\\pyright\\dist\\pyright-langserver.js`;
  try {
    const { existsSync } = require('fs') as typeof import('fs');
    if (existsSync(bundled)) return { args: [bundled, '--stdio'] };
  } catch {
    // 忽略
  }
  return null; // 全局 pyright 检测由调用方尝试（where pyright-langserver）
}

async function resolvePythonPath(): Promise<string | null> {
  const env = getActivePythonEnv();
  return env?.cmd ?? null;
}

async function startClient(absPluginDir: string, vaultRoot: string): Promise<LspClient | null> {
  const { findNodeExe } = await import('../terminal/ptyClient');
  const node = await findNodeExe();
  if (!node) throw new Error('LSP 需要 Node.js（与终端共用 node.exe 发现）');
  const specPyright = locatePyright(absPluginDir);
  if (!specPyright) throw new Error('插件目录未找到 pyright（部署缺 pyright/dist）');

  const { LspClient } = await import('./lspClient');
  const c = new LspClient();
  // langserver 进程的环境：选定 Python 环境前置 PATH。pyright 内部会探测
  // python（PATH 搜索）来解析 site-packages —— 渲染进程的 PATH 可能带着别的
  // python（灵犀/python-env 等），必须显式覆盖，否则 numpy/torch 全解析不到。
  const lspEnv = spawnEnvFor(getActivePythonEnv(), { ...process.env } as Record<string, string>);
  await c.start({ command: node, args: specPyright.args, env: lspEnv });

  const pythonPath = await resolvePythonPath();
  envKey = pythonPath ?? '';

  // initialize
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

  // 环境联动第二保险：pyright 通过 workspace/configuration 逐 section 拉
  // 配置（items: [{section:'python'}, {section:'pyright'}, ...]），按 section 映射。
  c.on('message', (msg: { id?: number; method?: string; params?: { items?: { section?: string }[] } }) => {
    if (msg.method === 'workspace/configuration' && msg.id != null) {
      const items = msg.params?.items ?? [];
      c.reply(
        msg.id,
        items.map((it) => {
          if (it?.section === 'python') return { pythonPath: pythonPath ?? undefined };
          if (it?.section === 'pyright') return { pythonPath: pythonPath ?? undefined, openFilesOnly: false, useLibraryCodeForTypes: true };
          return {};
        }),
      );
    } else if (msg.method === 'client/registerCapability') {
      c.reply(msg.id!, null);
    } else if (msg.method === 'window/workDoneProgress/create') {
      c.reply(msg.id!, null);
    }
  });

  return c;
}

function encodeFileUri(absPath: string): string {
  const p = absPath.replace(/\\/g, '/');
  const enc = p
    .split('/')
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join('/');
  return `file:///${enc.replace(/^\/+/, '')}`;
}

function decodeFileUri(uri: string): string {
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

const diagHandler: { fn: ((ds: LspDiagnostic[]) => void) | null } = { fn: null };

/** 订阅诊断（CM 桥在挂载时注册）；返回取消函数 */
export function onLspDiagnostics(fn: (ds: LspDiagnostic[]) => void): () => void {
  diagHandler.fn = fn;
  return () => {
    if (diagHandler.fn === fn) diagHandler.fn = null;
  };
}

async function dispatchMessage(c: LspClient, msg: { method?: string; params?: Record<string, unknown> }): Promise<void> {
  if (msg.method === 'textDocument/publishDiagnostics') {
    const params = msg.params ?? {};
    const uri = String(params.uri ?? '');
    const rawDiags = (params.diagnostics ?? []) as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string }[];
    if (diagHandler.fn) {
      diagHandler.fn(
        rawDiags.map((d) => ({
          uri,
          line: d.range.start.line,
          ch: d.range.start.character,
          length: Math.max(0, (d.range.end.character - d.range.start.character) || 1),
          severity: d.severity ?? 1,
          message: d.message,
          source: d.source,
        })),
      );
    }
    void c;
    return;
  }
  void c;
}

/** 获取（或启动）pyright 客户端；环境变化时自动重启 */
export async function ensurePyrightLsp(absPluginDir: string, vaultRoot: string): Promise<LspClient | null> {
  const pythonPath = await resolvePythonPath();
  if (client?.isAlive && envKey === (pythonPath ?? '')) return client;
  if (starting) return starting;
  // 环境变了或未启动：重启
  if (client) {
    const old = client;
    client = null;
    for (const uri of openDocs.keys()) openDocs.delete(uri);
    await old.stop();
  }
  starting = (async () => {
    try {
      const c = await startClient(absPluginDir, vaultRoot);
      if (!c) return null;
      client = c;
      c.on('message', (msg: { method?: string; params?: Record<string, unknown> }) => {
        void dispatchMessage(c, msg);
      });
      return c;
    } catch (e) {
      console.warn('[lgp-lsp] pyright 启动失败:', e);
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** 打开（或全量更新）一份文档 */
export async function openLspDocument(absPluginDir: string, vaultRoot: string, absPath: string, languageId: string, text: string): Promise<LspClient | null> {
  const c = await ensurePyrightLsp(absPluginDir, vaultRoot);
  if (!c) return null;
  const uri = encodeFileUri(absPath);
  const ver = (openDocs.get(uri) ?? 0) + 1;
  openDocs.set(uri, ver);
  if (ver === 1) {
    c.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: ver, text },
    });
  } else {
    c.notify('textDocument/didChange', {
      textDocument: { uri, version: ver },
      contentChanges: [{ text }],
    });
  }
  return c;
}

export function closeLspDocument(absPath: string): void {
  if (!client?.isAlive) return;
  const uri = encodeFileUri(absPath);
  if (!openDocs.has(uri)) return;
  client.notify('textDocument/didClose', { textDocument: { uri } });
  openDocs.delete(uri);
}

export async function lspCompletion(absPath: string, line: number, ch: number): Promise<{ label: string; kind?: number; detail?: string; documentation?: string; insertText?: string }[]> {
  if (!client?.isAlive) return [];
  const uri = encodeFileUri(absPath);
  try {
    const result = (await client.request(
      'textDocument/completion',
      { textDocument: { uri }, position: { line, character: ch } },
      8000,
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

export async function lspHover(absPath: string, line: number, ch: number): Promise<string | null> {
  if (!client?.isAlive) return null;
  const uri = encodeFileUri(absPath);
  try {
    const result = (await client.request(
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

export function decodeUri(uri: string): string {
  return decodeFileUri(uri);
}
