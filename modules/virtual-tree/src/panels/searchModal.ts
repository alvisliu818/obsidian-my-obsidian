/**
 * 在此目录搜索(思源 search-panel.ts 的「目录」范围对齐):
 * 模态框内搜一个目录(挂载根或任意深层文件夹)的文件名与文本内容。
 *
 * 三种挂载形态的枚举策略:
 *   external  Node fs 递归(scanExternalAsync,协作式让出,UI 不卡);
 *   vault     TFolder 内存树递归(不碰磁盘);
 *   remote    只搜「已加载层」(面板回调给已展开的 MountNode 子树;远端逐个
 *             下载代价过高,内容搜索对 remote 不参与)。
 *
 * 语义对齐思源版:全部(名称+内容)/文件名/内容三模式;大小写/正则开关;
 * 包含/排除 glob(逗号分隔);上下文行数;内容命中按文件分组、行号+上下文预览;
 * token 失效防并发(再次搜索使旧搜索作废)。
 */

import { Modal, Notice, TFile, TFolder, type App } from 'obsidian';
import { readExternalText, scanExternalAsync, extOf } from '../features/extFs';
import { isTextFileName } from '../features/mountFilter';
import { isVaultMount, isRemoteMount, type ExternalMount } from '../types';
import type { MountNode } from '../features/mountFilter';

/** 一个搜索目标目录:挂载 + 挂载内相对路径('' = 挂载根)。 */
export interface SearchTarget {
  mount: ExternalMount;
  rel: string;
}

interface NameEntry {
  /** 挂载内相对路径('/' 分隔)。 */
  rel: string;
  name: string;
  isDir: boolean;
}

interface LineMatch {
  lineNo: number;
  preview: string;
  before: string[];
  after: string[];
}

interface FileGroup {
  rel: string;
  name: string;
  matches: LineMatch[];
}

type SearchMode = 'all' | 'filename' | 'content';

interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  include: string;
  exclude: string;
  context: number;
}

const NAME_LIMIT = 2000;
const WALK_DEPTH = 16;
const CONTENT_MAX_FILE = 1024 * 1024;
const CONTENT_CONCURRENCY = 8;

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 关键词 → 正则;非法正则返回 null(调用方提示,不静默吞掉)。 */
function buildRegex(keyword: string, o: SearchOptions): RegExp | null {
  const flags = o.caseSensitive ? 'g' : 'gi';
  const src = o.regex ? keyword : escapeRegExp(keyword);
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

/** glob(逗号分隔,* / ** / ?)→ 匹配器;空串返回 null(不限制)。 */
function buildGlobMatcher(raw: string): ((rel: string, name: string) => boolean) | null {
  const pats = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (pats.length === 0) return null;
  const res: RegExp[] = [];
  for (const p of pats) {
    let src = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*') {
        if (p[i + 1] === '*') {
          src += '.*';
          i++;
        } else {
          src += '[^/]*';
        }
      } else if (c === '?') {
        src += '[^/]';
      } else {
        src += escapeRegExp(c);
      }
    }
    try {
      res.push(new RegExp('^' + src + '$', 'i'));
    } catch {
      // 非法 glob 忽略(不因此让整个搜索失败)
    }
  }
  if (res.length === 0) return null;
  return (rel, name) => res.some((re) => re.test(name) || re.test(rel));
}

/** 按正则高亮(html 已转义后替换命中段)。 */
function highlightRegex(text: string, re: RegExp): string {
  const escaped = escapeHTML(text);
  const clone = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return escaped.replace(clone, (m) => `<mark class="lgp-search__mark">${m}</mark>`);
}

/**
 * 在此目录搜索弹窗。面板传 root(挂载+相对路径)、远端已加载层枚举回调与
 * 打开回调;打开行为(原生/块编辑器/vault 路由)由面板统一决定。
 */
export class DirSearchModal extends Modal {
  private target: SearchTarget;
  private listLoaded: (mount: ExternalMount, rel: string) => MountNode[] | null;
  private openRel: (mount: ExternalMount, rel: string, isDir: boolean) => void;
  private dirLabel: string;

  private mode: SearchMode = 'all';
  private runToken = 0;
  private infoEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private modeBtns = new Map<SearchMode, HTMLElement>();

  constructor(
    app: App,
    target: SearchTarget,
    opts: {
      dirLabel: string;
      listLoaded: (mount: ExternalMount, rel: string) => MountNode[] | null;
      openRel: (mount: ExternalMount, rel: string, isDir: boolean) => void;
    },
  ) {
    super(app);
    this.target = target;
    this.dirLabel = opts.dirLabel;
    this.listLoaded = opts.listLoaded;
    this.openRel = opts.openRel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('lgp-search-modal');
    contentEl.createEl('h3', { text: `在此目录搜索:${this.dirLabel}` });

    const barEl = contentEl.createDiv({ cls: 'lgp-search-modal__bar' });
    this.inputEl = barEl.createEl('input', {
      type: 'text',
      cls: 'lgp-search-modal__input',
      attr: { placeholder: '搜索文件名与内容…', spellcheck: 'false' },
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.doSearch();
      }
    });
    const btn = barEl.createEl('button', { cls: 'mod-cta', text: '搜索' });
    btn.addEventListener('click', () => void this.doSearch());

    const modesEl = contentEl.createDiv({ cls: 'lgp-search-modal__modes' });
    for (const m of [
      ['all', '全部'],
      ['filename', '文件名'],
      ['content', '内容'],
    ] as const) {
      const b = modesEl.createEl('button', { text: m[1] });
      if (m[0] === 'all') b.addClass('lgp-search-modal__mode--on');
      b.addEventListener('click', () => {
        this.mode = m[0];
        for (const [k, el] of this.modeBtns) el.toggleClass('lgp-search-modal__mode--on', k === this.mode);
        if (this.inputEl.value.trim()) void this.doSearch();
      });
      this.modeBtns.set(m[0], b);
    }

    const optsEl = contentEl.createDiv({ cls: 'lgp-search-modal__opts' });
    const caseChk = optsEl.createEl('label', { cls: 'lgp-search-modal__opt' });
    caseChk.append('大小写 ');
    const caseBox = caseChk.createEl('input', { type: 'checkbox' });
    const regexChk = optsEl.createEl('label', { cls: 'lgp-search-modal__opt' });
    regexChk.append('正则 ');
    const regexBox = regexChk.createEl('input', { type: 'checkbox' });
    const includeWrap = optsEl.createEl('label', { cls: 'lgp-search-modal__opt lgp-search-modal__opt--grow' });
    includeWrap.append('包含 ');
    const includeInput = includeWrap.createEl('input', {
      type: 'text',
      attr: { placeholder: '*.md, *.ts', spellcheck: 'false' },
    });
    const excludeWrap = optsEl.createEl('label', { cls: 'lgp-search-modal__opt lgp-search-modal__opt--grow' });
    excludeWrap.append('排除 ');
    const excludeInput = excludeWrap.createEl('input', {
      type: 'text',
      attr: { placeholder: 'node_modules/**, *.log', spellcheck: 'false' },
    });
    const ctxWrap = optsEl.createEl('label', { cls: 'lgp-search-modal__opt' });
    ctxWrap.append('上下文 ');
    const ctxSel = ctxWrap.createEl('select');
    for (const n of [0, 1, 2]) ctxSel.createEl('option', { value: String(n), text: String(n) });

    this.infoEl = contentEl.createDiv({ cls: 'lgp-search-modal__info' });
    this.resultsEl = contentEl.createDiv({ cls: 'lgp-search-modal__results' });

    this.readOptions = () => ({
      caseSensitive: caseBox.checked,
      regex: regexBox.checked,
      include: includeInput.value,
      exclude: excludeInput.value,
      context: parseInt(ctxSel.value || '0', 10) || 0,
    });
    for (const el of [caseBox, regexBox, ctxSel]) {
      el.addEventListener('change', () => {
        if (this.inputEl.value.trim()) void this.doSearch();
      });
    }
    for (const el of [includeInput, excludeInput]) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (this.inputEl.value.trim()) void this.doSearch();
        }
      });
    }
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  private readOptions: () => SearchOptions = () => ({
    caseSensitive: false,
    regex: false,
    include: '',
    exclude: '',
    context: 0,
  });

  onClose(): void {
    this.runToken++; // 使进行中的搜索失效
    this.contentEl.empty();
  }

  // ===== 枚举 =====

  /** 挂载内相对路径全集(名称搜索用)。remote 只到已加载层。 */
  private async enumerateNames(): Promise<{ entries: NameEntry[]; truncated: boolean }> {
    const mount = this.target.mount;
    const rel0 = this.target.rel;
    const entries: NameEntry[] = [];
    let truncated = false;
    const push = (rel: string, name: string, isDir: boolean): boolean => {
      if (entries.length >= NAME_LIMIT) {
        truncated = true;
        return false;
      }
      entries.push({ rel, name, isDir });
      return true;
    };

    if (isVaultMount(mount)) {
      const rootPath = rel0 ? `${mount.path}/${rel0}` : mount.path;
      const walk = (folder: TFolder, rel: string): void => {
        for (const child of folder.children) {
          const childRel = rel ? `${rel}/${child.name}` : child.name;
          if (child instanceof TFolder) {
            if (push(childRel, child.name, true)) walk(child, childRel);
          } else if (child instanceof TFile) {
            push(childRel, child.name, false);
          }
        }
      };
      const af = this.app.vault.getAbstractFileByPath(rootPath);
      if (af instanceof TFolder) walk(af, rel0);
      return { entries, truncated };
    }

    if (isRemoteMount(mount)) {
      // 已加载层枚举:树里有什么搜什么(懒加载语义,与面板所见一致)
      const walk = (nodes: MountNode[], baseRel: string): void => {
        for (const n of nodes) {
          const childRel = baseRel ? `${baseRel}/${n.name}` : n.name;
          if (!push(childRel, n.name, n.isDir)) return;
          if (n.isDir || n.children.length) walk(n.children, childRel);
          if (truncated) return;
        }
      };
      const nodes = this.listLoaded(mount, rel0);
      if (nodes) walk(nodes, rel0);
      return { entries, truncated };
    }

    // external:Node fs 协作式递归(.git 等点目录不进入)
    const rootAbs = rel0 ? this.joinAbs(mount.path, rel0) : mount.path;
    const r = await scanExternalAsync(rootAbs, {
      shouldEnterDir: (rel) => {
        const seg = rel.split('/').pop() ?? '';
        return !seg.startsWith('.');
      },
      keepFile: () => true,
      limit: NAME_LIMIT,
      depth: WALK_DEPTH,
    });
    truncated = r.truncated;
    for (const e of r.entries) push(rel0 ? `${rel0}/${e.rel}` : e.rel, e.name, e.isDir);
    return { entries, truncated };
  }

  /** 内容搜索候选:文本文件 + 读取函数(vault 是异步读,统一 Promise)。 */
  private async enumerateTextFiles(): Promise<Array<{ rel: string; name: string; read: () => Promise<string> }>> {
    const mount = this.target.mount;
    const out: Array<{ rel: string; name: string; read: () => Promise<string> }> = [];
    if (isRemoteMount(mount)) return out;
    if (isVaultMount(mount)) {
      const rootPath = this.target.rel ? `${mount.path}/${this.target.rel}` : mount.path;
      const af = this.app.vault.getAbstractFileByPath(rootPath);
      if (!(af instanceof TFolder)) return out;
      const walk = (folder: TFolder, rel: string): void => {
        for (const child of folder.children) {
          const childRel = rel ? `${rel}/${child.name}` : child.name;
          if (child instanceof TFolder) walk(child, childRel);
          else if (child instanceof TFile && isTextFileName(child.name) && child.stat.size <= CONTENT_MAX_FILE) {
            const f = child;
            out.push({ rel: childRel, name: child.name, read: () => this.app.vault.cachedRead(f) });
          }
        }
      };
      walk(af, this.target.rel);
      return out;
    }
    const rootAbs = this.target.rel ? this.joinAbs(mount.path, this.target.rel) : mount.path;
    const r = await scanExternalAsync(rootAbs, {
      shouldEnterDir: (rel) => {
        const seg = rel.split('/').pop() ?? '';
        return !seg.startsWith('.');
      },
      keepFile: (_rel, name) => isTextFileName(name) && extOf(name) !== '',
      limit: NAME_LIMIT,
      depth: WALK_DEPTH,
    });
    for (const e of r.entries) {
      if (e.isDir) continue;
      out.push({
        rel: this.target.rel ? `${this.target.rel}/${e.rel}` : e.rel,
        name: e.name,
        read: async () => readExternalText(e.abs),
      });
    }
    return out;
  }

  private joinAbs(root: string, rel: string): string {
    const sep = root.includes('\\') ? '\\' : '/';
    return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
  }

  // ===== 搜索 =====

  private async doSearch(): Promise<void> {
    const keyword = this.inputEl.value.trim();
    if (!keyword) return;
    const token = ++this.runToken;
    const mode = this.mode;
    const opts = this.readOptions();
    const re = buildRegex(keyword, opts);
    if (!re) {
      this.infoEl.textContent = '正则表达式无效,请检查后重试';
      return;
    }
    // 测试用副本不带 g(带 g 的正则用 test 会推进 lastIndex,逐行判断会漏)
    const testRe = new RegExp(re.source, re.flags.replace(/g/g, ''));
    const includeMatch = buildGlobMatcher(opts.include);
    const excludeMatch = buildGlobMatcher(opts.exclude);
    const keep = (rel: string, name: string): boolean => {
      if (includeMatch && !includeMatch(rel, name)) return false;
      if (excludeMatch && excludeMatch(rel, name)) return false;
      return true;
    };
    const lower = keyword.toLowerCase();
    this.resultsEl.empty();
    this.infoEl.textContent = '搜索中…';
    let nameCount = 0;
    let contentCount = 0;
    let fileCount = 0;

    try {
      // 1) 名称匹配
      if (mode !== 'content') {
        const { entries } = await this.enumerateNames();
        if (token !== this.runToken) return;
        const matched = entries
          .filter((e) => keep(e.rel, e.name) && e.name.toLowerCase().includes(lower))
          .sort((a, b) => (a.isDir === b.isDir ? a.rel.localeCompare(b.rel) : a.isDir ? -1 : 1));
        for (const e of matched) {
          nameCount++;
          this.appendNameResult(e, re);
        }
        this.infoEl.textContent =
          mode === 'filename' ? (nameCount > 0 ? `找到 ${nameCount} 个名称结果` : '未找到结果') : `搜索中… 名称 ${nameCount}`;
      }

      // 2) 内容匹配
      if (mode !== 'filename') {
        const candidates = (await this.enumerateTextFiles()).filter((c) => keep(c.rel, c.name));
        if (token !== this.runToken) return;
        for (let i = 0; i < candidates.length; i += CONTENT_CONCURRENCY) {
          if (token !== this.runToken) return;
          const batch = candidates.slice(i, i + CONTENT_CONCURRENCY);
          await Promise.all(
            batch.map(async (cand) => {
              let content = '';
              try {
                content = await cand.read();
              } catch {
                return;
              }
              if (!content) return;
              const lines = content.replace(/\r\n?/g, '\n').split('\n');
              const matches: LineMatch[] = [];
              for (let j = 0; j < lines.length; j++) {
                if (!testRe.test(lines[j])) continue;
                testRe.lastIndex = 0;
                const before: string[] = [];
                const after: string[] = [];
                for (let k = Math.max(0, j - opts.context); k < j; k++) before.push(lines[k].trim().slice(0, 200));
                for (let k = j + 1; k <= Math.min(lines.length - 1, j + opts.context); k++) after.push(lines[k].trim().slice(0, 200));
                matches.push({ lineNo: j + 1, preview: lines[j].trim().slice(0, 200), before, after });
              }
              if (matches.length === 0 || token !== this.runToken) return;
              const g: FileGroup = { rel: cand.rel, name: cand.name, matches };
              fileCount++;
              contentCount += matches.length;
              this.appendGroup(g, re);
              const prefix = mode === 'all' ? `名称 ${nameCount} · ` : '';
              this.infoEl.textContent = `搜索中… ${prefix}内容 ${contentCount} (${Math.min(i + batch.length, candidates.length)}/${candidates.length})`;
            }),
          );
        }
      }
    } catch (e) {
      if (token === this.runToken) this.infoEl.textContent = `搜索出错: ${(e as Error)?.message ?? e}`;
      return;
    }
    if (token !== this.runToken) return;

    if (mode === 'all') {
      this.infoEl.textContent =
        nameCount + contentCount > 0
          ? `名称 ${nameCount} · 内容 ${contentCount}(${fileCount} 个文件)`
          : '未找到结果';
    } else if (mode === 'content') {
      this.infoEl.textContent = contentCount > 0 ? `内容 ${contentCount}(${fileCount} 个文件)` : '未找到结果';
    } else {
      this.infoEl.textContent = nameCount > 0 ? `名称 ${nameCount}` : '未找到结果';
    }
  }

  // ===== 结果渲染 =====

  private appendNameResult(e: NameEntry, re: RegExp): void {
    const li = this.resultsEl.createDiv({ cls: 'lgp-search__item' });
    const head = li.createDiv({ cls: 'lgp-search__name' });
    head.createSpan({ cls: 'lgp-search__icon', text: e.isDir ? '📁' : '📄' });
    head.createSpan({ cls: 'lgp-search__name-text' }).innerHTML = highlightRegex(e.name, re);
    if (e.isDir) head.createSpan({ cls: 'lgp-search__badge', text: '文件夹' });
    li.createDiv({ cls: 'lgp-search__sub', text: e.rel });
    li.addEventListener('click', () => {
      if (e.isDir) {
        new Notice('文件夹请在挂载面板里展开定位');
        return;
      }
      this.openRel(this.target.mount, e.rel, false);
    });
  }

  private appendGroup(g: FileGroup, re: RegExp): void {
    const li = this.resultsEl.createDiv({ cls: 'lgp-search__group' });
    const head = li.createDiv({ cls: 'lgp-search__group-head' });
    head.createSpan({ cls: 'lgp-search__icon', text: '📄' });
    head.createSpan({ cls: 'lgp-search__name-text' }).innerHTML = highlightRegex(g.name, re);
    head.createSpan({ cls: 'lgp-search__count', text: String(g.matches.length) });
    head.createSpan({ cls: 'lgp-search__sub', text: g.rel });
    head.addEventListener('click', () => {
      this.openRel(this.target.mount, g.rel, false);
    });
    for (const m of g.matches) {
      const item = li.createDiv({ cls: 'lgp-search__hit-item' });
      for (const b of m.before) item.createDiv({ cls: 'lgp-search__ctx', text: b });
      const hit = item.createDiv({ cls: 'lgp-search__hit' });
      hit.createSpan({ cls: 'lgp-search__line', text: String(m.lineNo) });
      hit.createSpan({ cls: 'lgp-search__hit-text' }).innerHTML = highlightRegex(m.preview, re);
      for (const a of m.after) item.createDiv({ cls: 'lgp-search__ctx', text: a });
      item.addEventListener('click', () => this.openRel(this.target.mount, g.rel, false));
    }
  }
}
