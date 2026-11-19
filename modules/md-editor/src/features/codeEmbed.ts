/**
 * 代码行范围嵌入块(2026-11-19,阶段 B):`![[file.py#L10-L20]]` 在 md 里渲染
 * 成代码块(显示文件的那几行)+ 头部(文件名/行锚/编辑按钮)。
 *
 * 链接来源:代码文件(ExternalCodeView)的行号列——点击选中行、Shift+点击扩展
 * 选区、右键「复制嵌入块链接」(见 views/ExternalCodeView.ts 的
 * buildEmbedLink)——粘贴进 md 即得本嵌入块。
 *
 * 链接形态:
 *  - 库内文件:`![[<库内路径>#L10-L20]]`(generateMarkdownLink 产物加 !)
 *  - 库外文件:`![[ext:<绝对路径>#L10-L20]]`(ext: 伪路径约定,与
 *    ExternalCodeView.buildCodeExtLink 同款;openLinkText patch 负责路由)
 *  - 行锚:`#L10`(单行)或 `#L10-L20`(范围,1-based 含端)。
 *
 * 解析:库内先 vault.getAbstractFileByPath(TFile → vault.read);库外按绝对
 * 路径 fs 直读(挂载文件都是真实文件)。渲染:头部(文件名+行锚+编辑按钮)
 * + pre 正文(异步读文件填充——渲染管线同步,then 填充,prologResults 同款
 * 模式)。编辑按钮 = openLinkText(path#Lstart) → 代码视图(registerExtensions
 * 注册的代码扩展)经 setEphemeralState 落到行锚。
 *
 * 编辑态说明:聚焦块内显示原始 `![[...]]` 文本(标准嵌入交互),失焦后的
 * 静态渲染出嵌入盒——与媒体嵌入同款交互。
 */

import { TFile, type App } from 'obsidian';
import type { BlockRenderHost } from '../blocks/renderHost';

/** `![[<target>#L<start>[-L<end>]]]`:target 不含 # 与 [];行锚 1-based。 */
export const CODE_EMBED_RE = /!\[\[([^\[\]|#]+)#(L\d+(?:-L\d+)?)\]\]/g;

export interface CodeEmbedTarget {
  /** 原样 target(库内相对路径或 ext: 绝对路径伪路径) */
  raw: string;
  /** 库内 TFile(库内文件时);库外为 null */
  vaultFile: TFile | null;
  /** 库外绝对路径(库外文件时);库内为 null */
  extAbs: string | null;
  start: number;
  end: number;
}

/** 解析嵌入目标:库内 TFile 优先,回落库外绝对路径存在性。 */
export function resolveCodeEmbedTarget(app: App, raw: string, start: number, end: number): CodeEmbedTarget | null {
  const af = app.vault.getAbstractFileByPath(raw);
  if (af instanceof TFile) return { raw, vaultFile: af, extAbs: null, start, end };
  // 库外:绝对路径且真实存在(挂载文件都是真实文件;ext: 前缀剥掉)
  const abs = raw.startsWith('ext:') ? raw.slice(4) : raw;
  if (!/^([A-Za-z]:[/\\]|\/)/.test(abs)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return { raw, vaultFile: null, extAbs: abs, start, end };
}

/**
 * wiki 嵌入 inner(`E2E/embed-probe.py#L2-L4`,| 宽度段已被剥)→ 代码行嵌入
 * 参数。**形状判定**(target 非媒体 + #L 行锚合法)——文件是否存在由渲染时
 * resolve 决定(不存在 = 诚实 broken 盒)。renderTree 的 token 化回调用它。
 */
export function parseCodeEmbedInner(inner: string): { target: string; start: number; end: number } | null {
  const m = /^([^#]+)#L(\d+)(?:-L(\d+))?$/.exec(inner.trim());
  if (!m) return null;
  const target = m[1].trim();
  if (!target) return null;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (!Number.isFinite(start) || start < 1 || end < start) return null;
  return { target, start, end };
}

/** 行范围文本(1-based 含端;越界钳制)。 */
function sliceLines(content: string, start: number, end: number): string {
  const lines = content.split('\n');
  const s = Math.max(1, Math.min(start, lines.length));
  const e = Math.max(s, Math.min(end, lines.length));
  return lines.slice(s - 1, e).join('\n');
}

/** 编辑按钮的跳转目标(复用行锚体系:openLinkText → setEphemeralState)。 */
export function codeEmbedOpenLink(t: CodeEmbedTarget): string {
  const base = t.vaultFile ? t.vaultFile.path : 'ext:' + (t.extAbs ?? '');
  return `${base}#L${t.start}`;
}

/** 头部行锚文本(单行 #L10;范围 #L10-L20)。 */
export function codeEmbedAnchor(t: CodeEmbedTarget): string {
  return t.start === t.end ? `#L${t.start}` : `#L${t.start}-L${t.end}`;
}

/** 代码嵌入盒:头部(文件名+行锚+编辑/复制按钮)+ pre 正文(异步填充)。 */
export function buildCodeEmbedBox(host: BlockRenderHost, t: CodeEmbedTarget): HTMLElement {
  const box = document.createElement('div');
  box.className = 'lgp-code-embed';
  const fileName = (t.vaultFile?.name ?? t.extAbs?.split(/[\\/]/).pop() ?? '').trim();
  const anchor = codeEmbedAnchor(t);

  const header = box.createDiv({ cls: 'lgp-code-embed-header' });
  header.createSpan({ cls: 'lgp-code-embed-file', text: `${fileName} ${anchor}` });
  const actions = header.createDiv({ cls: 'lgp-code-embed-actions' });
  const editBtn = actions.createEl('button', { cls: 'lgp-code-embed-btn', attr: { 'aria-label': '打开文件对应位置编辑' } });
  editBtn.setText('编辑');
  editBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void host.app.workspace.openLinkText(codeEmbedOpenLink(t), '', false);
  });
  const copyBtn = actions.createEl('button', { cls: 'lgp-code-embed-btn', attr: { 'aria-label': '复制嵌入链接' } });
  copyBtn.setText('复制');
  copyBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const link = `![[${t.raw}${anchor}]]`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // 后台窗口兜底:Electron clipboard 不受 focus 门控(ExternalCodeView 同款)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ipcRenderer } = require('electron') as { ipcRenderer: { writeText: (s: string) => void } };
      ipcRenderer.writeText(link);
    }
  });

  const pre = box.createEl('pre', { cls: 'lgp-code-embed-body' });
  const code = pre.createEl('code');
  code.setText('加载中…');

  // 异步读内容(渲染管线同步——then 填充,prologResults 同款模式)
  void (async () => {
    let body = '';
    try {
      if (t.vaultFile) body = await host.app.vault.read(t.vaultFile);
      else if (t.extAbs) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs');
        body = await fs.promises.readFile(t.extAbs, 'utf8');
      }
    } catch (e) {
      code.setText(`读取失败:${String((e as Error)?.message ?? e).slice(0, 120)}`);
      box.addClass('is-broken');
      return;
    }
    code.setText(sliceLines(body, t.start, t.end));
  })();

  return box;
}

/**
 * 代码嵌入渲染 pass:扫文本节点里的 `![[target#L…]]`,替换为嵌入盒。
 * 两处来源:裸文本节点(markdown 渲染器没碰的)与 .internal-embed 占位
 * (Obsidian 对解析不到的嵌入发的占位,原文在占位内——整元素替换)。
 * 必须先于 enhanceEmbeds 跑:PAGE_EMBED_RE 会把 `![[...#L…]]` 捡走渲染成
 * "page not found" 盒。1.15.1 注意:Workspace.getLeaves 已移除——本 pass
 * 不用它(目标解析走 vault.getAbstractFileByPath + fs.statSync)。
 */
export function enhanceCodeEmbeds(el: HTMLElement, host: BlockRenderHost): void {
  // 一趟收集(enhanceEmbeds 同款:遍历文本节点攒目标,再统一替换——边走边换
  // 会让 TreeWalker 在被替换节点上行为不可预期)。
  const targets: {
    node: Text;
    matches: { text: string; target: string; anchor: string; idx: number; start: number; end: number }[];
    placeholder: HTMLElement | null;
    fullCover: boolean;
  }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let cur = walker.nextNode() as Text | null;
  while (cur) {
    const data = cur.data ?? '';
    if (data.includes('![[') && data.includes('#L')) {
      const matches = [...data.matchAll(CODE_EMBED_RE)].map((m) => {
        const a = /^L(\d+)(?:-L(\d+))?$/.exec(m[2]);
        return a ? { text: m[0], target: m[1], anchor: m[2], idx: m.index ?? 0, start: Number(a[1]), end: a[2] ? Number(a[2]) : Number(a[1]) } : null;
      }).filter((x) => x !== null);
      if (matches.length > 0) {
        const placeholder = cur.parentElement?.closest('.internal-embed') as HTMLElement | null;
        const fullCover = placeholder !== null && matches.length === 1 && (cur.data ?? '').trim() === matches[0].text;
        targets.push({ node: cur, matches, placeholder, fullCover });
      }
    }
    cur = walker.nextNode() as Text | null;
  }
  // 统一应用:逐节点逐匹配解析→建盒;任一匹配解析到目标才动手(全部解析不到
  // 保持原样——Obsidian 占位语义)。
  for (const t of targets) {
    const resolved = t.matches.map((x) => resolveCodeEmbedTarget(host.app, x.target, x.start, x.end));
    if (!resolved.some((r) => r !== null)) continue;
    if (t.placeholder && t.fullCover && resolved[0]) {
      t.placeholder.replaceWith(buildCodeEmbedBox(host, resolved[0]));
      continue;
    }
    const frag = document.createDocumentFragment();
    let last = 0;
    const value = t.node.data ?? '';
    for (let i = 0; i < t.matches.length; i++) {
      const { text, idx } = t.matches[i];
      if (idx > last) frag.appendChild(document.createTextNode(value.slice(last, idx)));
      const target2 = resolved[i];
      if (target2) frag.appendChild(buildCodeEmbedBox(host, target2));
      else frag.appendChild(document.createTextNode(text));
      last = idx + text.length;
    }
    if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
    t.node.replaceWith(frag);
  }
}
