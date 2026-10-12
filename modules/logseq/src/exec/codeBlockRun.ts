/**
 * 文档内 Python 代码块「▶ 运行」— 移植自 siyuan-editor
 * `src/protyle/code-block-run.ts` 的交互形态,适配 obsidian-logseq 的渲染树:
 *
 * - 挂载点:静态渲染的代码块在 enhanceCodeBlocks 里被包进 .lgp-code-block
 *   (工具栏含语言标签 + 复制按钮),运行按钮与输出面板都挂在这个容器里。
 * - 状态按 Block 记忆(WeakMap,同 blockViews 的 tab 记忆约定):块模型跨
 *   patch 稳定,重渲染后状态不丢。
 * - 面板重挂:Obsidian 的块重渲染会换掉 DOM,重渲染后由 renderTree 的
 *   enhance 流程重新调用 mountRunUi 把已有状态的面板重新接上。
 * - 思源侧「输出面板必须挂块外」的坑在 Obsidian 不存在:这里没有 lute
 *   序列化自定义 DOM 的问题(所见即所得模型只序列化 Block 模型,不碰
 *   静态渲染层的装饰节点),面板可以安全挂在代码块容器内部。
 */

import type { Block } from '../types';
import { runCode, isRunnableLang as isRunnable, langFromTag } from './runner';
import { stripANSI, type RunHandle } from './pythonRunner';

/** 语言门控:Python / JavaScript / Shell 三类可运行。 */
export function isRunnableLang(lang: string): boolean {
  return isRunnable(lang);
}

interface RunState {
  running: boolean;
  /** 首次运行时的语言标签;重跑沿用 */
  lang: string;
  handle: RunHandle | null;
  /** 累积输出(重挂面板时回放) */
  output: string;
  exitCode: number | null;
  collapsed: boolean;
  /** 面板 DOM(重渲染后失效,重挂时重建) */
  panel: HTMLElement | null;
}

/** 按块记忆运行状态:块模型跨 patch 稳定,WeakMap 跟随块生命周期。 */
const runStates = new WeakMap<Block, RunState>();

function stateOf(b: Block): RunState {
  let st = runStates.get(b);
  if (!st) {
    st = { running: false, lang: '', handle: null, output: '', exitCode: null, collapsed: false, panel: null };
    runStates.set(b, st);
  }
  return st;
}

/** 供 renderTree 在静态渲染代码块时调用:有状态则把面板重新接上。 */
export function mountRunUi(wrap: HTMLElement, lang: string, b: Block): void {
  if (!isRunnableLang(lang)) return;
  const st = runStates.get(b);
  if (st && (st.running || st.output || st.exitCode !== null)) {
    const panel = buildPanel(b, st);
    wrap.appendChild(panel);
  }
}

/** 创建「▶ 运行」按钮(挂进代码块工具栏)。 */
export function createRunButton(lang: string, getCode: () => string, b: Block): HTMLElement | null {
  if (!isRunnableLang(lang)) return null;
  const btn = document.createElement('span');
  btn.className = 'lgp-code-run';
  btn.setAttribute('aria-label', `运行 ${lang || '代码'}`);
  btn.textContent = '▶';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    void runBlock(b, getCode(), lang);
  });
  return btn;
}

/** 运行一个块的代码;面板会被创建/更新。 */
async function runBlock(b: Block, code: string, rawLang: string): Promise<void> {
  const st = stateOf(b);
  if (st.running) return;
  st.lang = rawLang || st.lang;
  st.running = true;
  st.exitCode = null;
  st.output = '';
  st.collapsed = false;

  let panel = st.panel;
  if (!panel || !panel.isConnected) {
    // 按钮在工具栏上,面板挂代码块容器;找不到容器(理论不可能)就退回按钮父级。
    const host = (btnHostOf(b) ?? panel) as HTMLElement | null;
    if (host) {
      panel = buildPanel(b, st);
      host.appendChild(panel);
      st.panel = panel;
    }
  }
  renderPanel(b, st, 'running');

  try {
    const lang = langFromTag(rawLang) ?? 'python';
    st.handle = runCode({
      code,
      lang,
      onOutput: (chunk) => {
        st.output += chunk;
        if (st.output.length > 200_000) st.output = st.output.slice(-100_000);
        renderPanel(b, st, 'running');
      },
      onExit: (code) => {
        st.handle = null;
        st.running = false;
        st.exitCode = code;
        renderPanel(b, st, 'done');
      },
    });
  } catch (err) {
    st.running = false;
    st.handle = null;
    st.exitCode = -1;
    st.output += `\n[启动失败] ${err instanceof Error ? err.message : String(err)}\n`;
    renderPanel(b, st, 'done');
  }
}

/** 找到块当前渲染的 .lgp-code-block 容器(重渲染后由 mountRunUi 重建连接)。 */
const wrapByBlock = new WeakMap<Block, HTMLElement>();

/** renderTree 在包代码块时注册容器,运行时按块找回。 */
export function registerCodeWrap(b: Block, wrap: HTMLElement): void {
  wrapByBlock.set(b, wrap);
}

function btnHostOf(b: Block): HTMLElement | null {
  return wrapByBlock.get(b) ?? null;
}

// ---------------------------------------------------------------------
// 面板 DOM
// ---------------------------------------------------------------------

function buildPanel(b: Block, st: RunState): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'lgp-cb-run';
  st.panel = panel;
  renderPanelInto(panel, b, st);
  return panel;
}

function renderPanel(b: Block, st: RunState, phase: 'running' | 'done' = 'running'): void {
  void phase;
  if (st.panel && st.panel.isConnected) renderPanelInto(st.panel, b, st);
  else {
    // 面板被重渲染丢掉:重新接上
    const host = btnHostOf(b);
    if (host) {
      const panel = buildPanel(b, st);
      host.appendChild(panel);
    }
  }
}

function renderPanelInto(panel: HTMLElement, b: Block, st: RunState, _phase: 'running' | 'done' = 'running'): void {
  panel.empty?.();
  if (panel.innerHTML !== undefined) panel.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'lgp-cb-run__head';
  const label = document.createElement('span');
  label.className = 'lgp-cb-run__label';
  label.textContent = st.running
    ? '运行中…'
    : st.exitCode === 0
      ? '完成'
      : `退出码 ${st.exitCode ?? '-'}`;
  head.appendChild(label);

  const actions = document.createElement('span');
  actions.className = 'lgp-cb-run__actions';

  const foldBtn = document.createElement('span');
  foldBtn.className = 'lgp-cb-run__btn';
  foldBtn.textContent = st.collapsed ? '展开' : '折叠';
  foldBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    st.collapsed = !st.collapsed;
    renderPanel(b, st);
  });
  actions.appendChild(foldBtn);

  const rerunBtn = document.createElement('span');
  rerunBtn.className = 'lgp-cb-run__btn';
  rerunBtn.textContent = '重跑';
  rerunBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (st.running) return;
    // 从块模型取最新代码:面板存在但代码可能已被编辑
    void runBlock(b, latestCodeOf(b), st.lang);
  });
  actions.appendChild(rerunBtn);

  if (st.running) {
    const stopBtn = document.createElement('span');
    stopBtn.className = 'lgp-cb-run__btn';
    stopBtn.textContent = '停止';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      st.handle?.interrupt();
    });
    actions.appendChild(stopBtn);
  }
  head.appendChild(actions);
  panel.appendChild(head);

  if (st.collapsed) return;

  // 输出区
  const out = document.createElement('pre');
  out.className = 'lgp-cb-run__output';
  out.textContent = st.output || (st.running ? '' : '(无输出)');
  panel.appendChild(out);

  // stdin 行:只在运行中显示(思源侧同款:程序等输入时才出现)
  if (st.running) {
    const inputWrap = document.createElement('div');
    inputWrap.className = 'lgp-cb-run__stdin';
    const field = document.createElement('input');
    field.type = 'text';
    field.placeholder = '程序在等输入,在这里输入后回车';
    field.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        ev.preventDefault();
        const v = field.value;
        field.value = '';
        st.handle?.sendInput(v);
      }
    });
    inputWrap.appendChild(field);
    panel.appendChild(inputWrap);
    window.setTimeout(() => field.focus(), 0);
  }
}

/** 从块模型重新解析代码(重跑时块可能已被编辑)。 */
function latestCodeOf(b: Block): string {
  const lines = b.text.split('\n');
  const open = lines.findIndex((l) => /^\s*(`{3,}|~{3,})/.test(l));
  if (open < 0) return b.text;
  const marker = (/^\s*(`{3,}|~{3,})/.exec(lines[open])?.[1]) ?? '```';
  const closeIdx = lines.findIndex((l, i) => i > open && l.trimStart().startsWith(marker));
  const end = closeIdx < 0 ? lines.length : closeIdx;
  return lines.slice(open + 1, end).join('\n');
}

export { stripANSI };
