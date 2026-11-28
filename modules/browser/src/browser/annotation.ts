/**
 * 网页标注：选中文字 → 悬浮小气泡点「标注」→ 在库里生成/追加标注笔记。
 *
 * 存储结构（Obsidian 适配版，对齐思源的「文档即标注清单」形态）：
 *   <标注保存目录>/<网站域名>/<页面标题>.md
 * frontmatter 记 url/domain/created；每条标注 = 一个列表项
 *   - [<引用文字>](<url>#syann=<id>) <!--syann:<base64 元数据>-->
 * 嵌套子列表项是批注正文（可直接在笔记里编辑，重开页面按文件回读）。
 * 元数据 JSON 走 base64 HTML 注释——阅读视图不可见、markdown 转义免疫、
 * 正则可解析。重新打开页面时按文件回读并恢复高亮位置；点击高亮弹 OS 浮动窗。
 * 纯函数（md 序列化/解析）在 annotationDoc.ts，单测直接覆盖。
 */
import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type { AnnotationPageInfo, BrowserSettings, IWebviewTag } from "../types";
import { getDomain } from "../utils/url";
import { webContentsFromId } from "../utils/electron";
import {
  b64encodeUtf8,
  escapeLinkText,
  normalizeUrlKey,
  parseAnnAnchor,
  parseAnnotationDoc,
  rebuildAnchorLine,
  safeTitle,
  unescapeLinkText,
  formatTimestamp as stampTime,
  stamp,
  type AnnItem,
  type AnnMeta,
} from "./annotationDoc";

export interface AnnCreatePayload {
  quote?: string;
  prefix?: string;
  suffix?: string;
  color?: string;
}

/**
 * 标注 UI 样式：必须走 webview.insertCSS（宿主侧注入，不受页面 CSP 约束）。
 * 部分站点用 meta CSP 禁内联 <style>/style 属性，页内脚本注入的样式会整段
 * 失效——表现为弹框变成普通 div 追加到页面底部（页面流布局）。
 */
function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

const ANN_CSS = `
.sy-ann-hl{position:relative;background:rgba(255,213,0,.4)!important;border-radius:2px;cursor:pointer;box-decoration-break:clone;-webkit-box-decoration-break:clone;}
.sy-ann-hl:hover{background:rgba(255,170,0,.6)!important;}
.sy-ann-hl-off{position:relative;background:transparent!important;color:inherit;border-radius:0;}
.sy-ann-bubble{position:fixed!important;z-index:2147483645!important;display:flex!important;align-items:center;gap:2px;box-sizing:border-box;max-width:calc(100vw - 16px);padding:5px 6px;background:#fff!important;color:#1f2937;border:1px solid rgba(15,23,42,.12);border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.16),0 1px 3px rgba(15,23,42,.08);font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;margin:0!important;right:auto!important;bottom:auto!important;}
.sy-ann-bubble *{box-sizing:border-box;}
.sy-ann-bubble button{border:0;background:transparent;color:#374151;cursor:pointer;font:inherit;line-height:1;height:26px;padding:0 8px;border-radius:6px;white-space:nowrap;transition:background .12s ease,color .12s ease;}
.sy-ann-bubble button:hover{background:#f3f4f6;}
.sy-ann-bubble .sy-ann-create{background:#2563eb;color:#fff;font-weight:600;padding:0 12px;}
.sy-ann-bubble .sy-ann-create:hover{background:#1d4ed8;}
.sy-ann-bubble .sy-ann-remove{color:#b91c1c;font-size:11px;padding:0 7px;}
.sy-ann-bubble .sy-ann-remove:hover{background:#fef2f2;color:#991b1b;}
.sy-ann-bubble [data-ann-act='close']{display:inline-flex!important;align-items:center;justify-content:center;min-width:30px!important;height:28px!important;margin-left:2px;padding:0 8px;border-radius:6px;color:#6b7280;font-size:18px;line-height:1;}
.sy-ann-bubble [data-ann-act='close']:hover{background:#fee2e2;color:#b91c1c;}
.sy-ann-pop{position:fixed!important;z-index:2147483645;max-width:340px;max-height:260px;overflow:auto;background:#fff;color:#222;border:none!important;outline:none;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18);padding:10px 12px;font-size:13px;line-height:1.5;font-family:sans-serif;word-break:break-word;margin:0!important;right:auto!important;bottom:auto!important;}
.sy-ann-pop-quote{font-size:12px;color:#666;border-left:3px solid #f5c542;padding-left:8px;margin-bottom:6px;white-space:pre-wrap;}
.sy-ann-pop-note{white-space:pre-wrap;}
.sy-ann-pop-empty{color:#999;font-style:italic;}
.sy-ann-pop-meta{margin-top:6px;font-size:11px;color:#aaa;}
.sy-ann-inline{position:absolute;left:0;top:100%;display:block;font-size:11px;color:#8a6d1a;background:none;border-radius:0;padding:0;margin:1px 0 0;cursor:pointer;line-height:1.2;white-space:nowrap;z-index:5;}
.sy-ann-inline:hover{opacity:.15;}
.sy-ann-c-yellow{background:rgba(255,213,0,.4)!important;}
.sy-ann-c-green{background:rgba(120,220,120,.45)!important;}
.sy-ann-c-blue{background:rgba(120,180,255,.45)!important;}
.sy-ann-c-pink{background:rgba(255,150,200,.45)!important;}
.sy-ann-c-purple{background:rgba(190,140,255,.45)!important;}
.sy-ann-swatches{display:flex;gap:4px;align-items:center;margin:6px 0;}
.sy-ann-bubble .sy-ann-swatches{display:inline-flex;gap:4px;align-items:center;padding:0 6px 0 1px;margin:0 2px 0 0;border-right:1px solid #e5e7eb;}
.sy-ann-sw{width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(15,23,42,.12);cursor:pointer;padding:0;}
/* 气泡内的色块同时是 button，需压过 .sy-ann-bubble button 的 transparent/26px 规则 */
.sy-ann-bubble .sy-ann-sw{width:14px!important;height:14px!important;flex:0 0 14px!important;padding:0!important;border:2px solid #fff!important;border-radius:50%!important;cursor:pointer!important;transition:none!important;}
.sy-ann-sw.on{box-shadow:0 0 0 2px #2563eb!important;}
.sy-ann-sw-yellow{background:rgba(255,213,0,.9);}
.sy-ann-sw-green{background:rgba(120,220,120,.9);}
.sy-ann-sw-blue{background:rgba(120,180,255,.9);}
.sy-ann-sw-pink{background:rgba(255,150,200,.9);}
.sy-ann-sw-purple{background:rgba(190,140,255,.9);}
.sy-ann-bubble .sy-ann-sw.sy-ann-sw-yellow{background:rgba(255,213,0,.9)!important;}
.sy-ann-bubble .sy-ann-sw.sy-ann-sw-green{background:rgba(120,220,120,.9)!important;}
.sy-ann-bubble .sy-ann-sw.sy-ann-sw-blue{background:rgba(120,180,255,.9)!important;}
.sy-ann-bubble .sy-ann-sw.sy-ann-sw-pink{background:rgba(255,150,200,.9)!important;}
.sy-ann-bubble .sy-ann-sw.sy-ann-sw-purple{background:rgba(190,140,255,.9)!important;}
.sy-ann-tags{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0;}
.sy-ann-tag{font-size:11px;background:#eef;border-radius:3px;padding:1px 6px;cursor:pointer;color:#335;}
.sy-ann-taginput{font-size:12px;border:1px solid #ddd;border-radius:4px;padding:2px 6px;width:110px;}
.sy-ann-pop-actions{margin-top:8px;display:flex;gap:6px;justify-content:flex-end;}
.sy-ann-pop-actions button{border:1px solid #ddd;background:#f7f7f7;border-radius:4px;font-size:12px;padding:2px 8px;cursor:pointer;}
.sy-ann-pop-bar{display:flex;align-items:center;gap:4px;margin:-4px -4px 6px;padding:2px 4px;cursor:move;user-select:none;}
.sy-ann-pop-bar .t{flex:1;font-size:11px;color:#999;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
.sy-ann-pop-bar button{border:none;background:transparent;cursor:pointer;font-size:13px;padding:1px 5px;border-radius:4px;color:#666;}
.sy-ann-pop-bar button:hover{background:#eee;}
.sy-ann-pop-bar button.on{color:#1a73e8;background:#dbeafe;}
.sy-ann-pop-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;}
@keyframes syAnnFlash{0%{box-shadow:0 0 0 0 rgba(255,140,0,.85);}70%{box-shadow:0 0 0 12px rgba(255,140,0,0);}100%{box-shadow:0 0 0 0 rgba(255,140,0,0);}}
.sy-ann-flash{animation:syAnnFlash 0.9s ease-out 2;}
`;

export interface AnnotationDeps {
  /** 浮窗页的 file:// URL（writePreloads 落盘后产出）。空 = 浮窗不可用。 */
  popupFileUrl: () => string;
  /** 列表跳转兜底 / 页面级打开：整页打开 url（浏览器模块 openUrl）。 */
  openLink: (url: string, newTab?: boolean) => void;
  /** annPages 变更后持久化（DataStore.save）。 */
  saveIndex: () => void;
  /** annPages 索引读写（PluginData.annPages）。 */
  pages: () => Record<string, AnnotationPageInfo>;
}

export class AnnotationController {
  /** 本会话已加载的页面标注缓存（urlKey → 标注列表），供点击弹窗快速取用 */
  private pageCache = new Map<string, AnnItem[]>();
  /** urlKey → webview，供元数据变更后回刷页内高亮/小字 */
  private webviews = new Map<string, IWebviewTag>();
  /** 标注 id（或 "list:"+urlKey）→ 浮动窗（复用，避免悬浮/点击重复弹窗） */
  private floatWins = new Map<string, any>();
  private floatChannel: BroadcastChannel | null = null;

  constructor(
    private app: App,
    private getSettings: () => BrowserSettings,
    private deps: AnnotationDeps,
  ) {
    // 轻量浮动窗（独立 OS 窗）经 BroadcastChannel 回传颜色/标签/编辑/保存批注/移动请求
    try {
      this.floatChannel = new BroadcastChannel("sy-ann-float");
      this.floatChannel.onmessage = (ev: MessageEvent) => {
        const m: any = ev.data;
        if (!m) return;
        if (m.type === "meta" && m.id) void this.applyMeta({ id: m.id, color: m.color, tags: m.tags });
        else if (m.type === "edit" && m.id) void this.openEditInVault(String(m.id));
        else if (m.type === "goto" && m.id) this.gotoAnnotation(String(m.id), String(m.url || ""));
        else if (m.type === "createPage") void this.createPageFromFloat(String(m.url || ""));
        else if (m.type === "openDoc") void this.openDoc(String(m.url || ""));
        else if (m.type === "saveNote" && m.id) void this.saveNoteFromFloat(String(m.id), String(m.note ?? ""));
        else if (m.type === "removeDisplay" && m.id) {
          // 浮动窗「取消标注 / 取消小字」：复用页内气泡的显示层取消逻辑
          const found = this.findItem(String(m.id));
          const wv = found ? this.webviews.get(found.urlKey) : null;
          const kind = m.kind === "inline" ? "inline" : "hl";
          if (!wv) {
            this.floatChannel?.postMessage({ type: "displayOff", id: String(m.id), kind, ok: false });
          } else {
            void this.setDisplayOff(wv, found!.urlKey, { kind, id: String(m.id) })
              .then(() => this.floatChannel?.postMessage({ type: "displayOff", id: String(m.id), kind, ok: true }))
              .catch(() => this.floatChannel?.postMessage({ type: "displayOff", id: String(m.id), kind, ok: false }));
          }
        } else if (m.id && (m.type === "pin" || m.type === "hide" || m.type === "resize" || m.type === "move" || m.type === "close")) {
          const w = this.floatWins.get(String(m.id));
          if (!w || w.isDestroyed()) return;
          if (m.type === "pin") w.setAlwaysOnTop(!!m.value);
          else if (m.type === "hide") w.hide();
          else if (m.type === "resize") w.setSize(Number(m.w) || 380, Number(m.h) || 340);
          else if (m.type === "move") {
            // 标题栏手动拖动（弹窗页 pointer capture + rAF 节流）
            const nx = Number(m.x), ny = Number(m.y);
            if (Number.isFinite(nx) && Number.isFinite(ny)) w.setPosition(nx, ny);
          } else if (m.type === "close") w.close();
        }
      };
    } catch {
      /* BroadcastChannel 不可用：浮窗交互降级（只读） */
    }
  }

  /** 卸载时关掉全部浮动窗（防孤儿窗口） */
  closeAllFloats(): void {
    for (const [, w] of this.floatWins) {
      try {
        if (!w.isDestroyed()) w.close();
      } catch {
        /* 已死 */
      }
    }
    this.floatWins.clear();
    try {
      this.floatChannel?.close();
    } catch {
      /* ignore */
    }
    this.floatChannel = null;
  }

  /** 跨页缓存按 id 找标注项及其 urlKey */
  private findItem(id: string): { urlKey: string; item: AnnItem } | null {
    for (const [urlKey, items] of this.pageCache) {
      const item = items.find((i) => i.id === id);
      if (item) return { urlKey, item };
    }
    return null;
  }

  // ---------------- vault note storage ----------------

  /** 定位/创建页面标注笔记（标注目录 → 域名 → 页面标题） */
  private async ensurePageNote(url: string, urlKey: string, title: string): Promise<AnnotationPageInfo | null> {
    const existing = this.deps.pages()[urlKey];
    if (existing) {
      // 笔记可能被用户删了：存在性兜底
      const ok = await this.app.vault.adapter.exists(existing.path).catch(() => false);
      if (ok) return existing;
    }
    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      /* keep empty */
    }
    const folder = (this.getSettings().annotationsFolder || "Browser/Annotations").replace(/^\/+|\/+$/g, "");
    const docTitle = safeTitle(title || domain || urlKey);
    // 同名不同页：标题追加 url hash8（思源同问题域，路径唯一锚在 urlKey 上）
    let hash = "";
    try {
      let h = 2166136261;
      for (let i = 0; i < urlKey.length; i++) {
        h ^= urlKey.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      hash = (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
    } catch {
      /* ignore */
    }
    const name = docTitle + (hash ? " " + hash : "") + ".md";
    const path = folder + "/" + (domain || "未分类") + "/" + name;
    const dir = folder + "/" + (domain || "未分类");
    const adapter = this.app.vault.adapter;
    try {
      await adapter.mkdir(dir).catch(() => {});
      if (!(await adapter.exists(path).catch(() => false))) {
        const head =
          "---\n" +
          'url: "' + url.replace(/"/g, '\\"') + '"\n' +
          "domain: " + domain + "\n" +
          "created: " + stamp() + "\n" +
          "---\n\n" +
          "- [来源](" + url + ")\n" +
          "- 创建于 " + stamp() + "\n";
        await adapter.write(path, head);
      }
    } catch (e) {
      console.warn("[obsidian-browser] annotation note create failed:", e);
      new Notice("标注笔记创建失败：" + String((e as Error)?.message ?? e));
      return null;
    }
    const info: AnnotationPageInfo = { path, title: docTitle, domain, createdAt: Date.now() };
    this.deps.pages()[urlKey] = info;
    this.deps.saveIndex();
    return info;
  }

  /** 读回笔记里全部标注锚点（含嵌套批注正文） */
  private async readAnnotations(path: string): Promise<AnnItem[]> {
    try {
      const raw = await this.app.vault.adapter.read(path);
      return parseAnnotationDoc(raw);
    } catch {
      return [];
    }
  }

  /** 写回一条标注的锚点行/嵌套批注（行级手术，不碰用户其它内容） */
  private async updateAnnotationLines(
    path: string,
    id: string,
    mutate: (item: AnnItem, anchorLine: string) => { anchorLine: string; note: string } | null,
  ): Promise<AnnItem | null> {
    const adapter = this.app.vault.adapter;
    let text = "";
    try {
      text = await adapter.read(path);
    } catch {
      return null;
    }
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => {
      const p = parseAnnAnchor(l);
      return !!p && p.id === id;
    });
    if (idx < 0) return null;
    const parsed = parseAnnAnchor(lines[idx]);
    if (!parsed) return null;
    const meta: AnnMeta = parsed.meta ?? {
      id,
      url: parsed.url,
      quote: unescapeLinkText(parsed.linkText),
      prefix: "",
      suffix: "",
      created: Date.now(),
      color: "yellow",
      tags: [],
    };
    const item: AnnItem = {
      id,
      // 有元数据时完全信任（页面级标注 quote 应为空串，不回落链接文本）
      quote: meta ? meta.quote : unescapeLinkText(parsed.linkText),
      prefix: meta.prefix,
      suffix: meta.suffix,
      note: "",
      created: meta.created,
      color: meta.color || "yellow",
      tags: meta.tags ?? [],
    };
    // 锚点行之后的嵌套行（4 空格起、非空）即批注正文
    let noteEnd = idx + 1;
    while (noteEnd < lines.length && /^[ \t]/.test(lines[noteEnd]) && lines[noteEnd].trim()) {
      noteEnd++;
    }
    item.note = lines
      .slice(idx + 1, noteEnd)
      .map((l) => l.replace(/^ {4}/, "").replace(/^- /, "").trimStart())
      .join("\n")
      .trim();
    const next = mutate(item, lines[idx]);
    if (!next) return item;
    lines[idx] = next.anchorLine;
    // 嵌套行替换：非空批注 = 4 空格缩进的列表项（多行续行同缩进）；空批注 = 删除
    const nestedLines = next.note
      ? next.note.split("\n").map((l, k) => (k === 0 ? "    - " + l : "    " + l))
      : [];
    const out = [...lines.slice(0, idx), next.anchorLine, ...nestedLines, ...lines.slice(noteEnd)].join("\n");
    await adapter.write(path, out);
    return item;
  }

  /** 页内小窗/浮动窗改颜色或标签 → 持久化到锚点元数据并回刷页内 */
  async applyMeta(payload: { id?: string; color?: string; tags?: string[] }): Promise<void> {
    try {
      const found = this.findItem(String(payload?.id || ""));
      if (!found) return;
      const { urlKey, item } = found;
      if (payload.color) item.color = payload.color;
      if (Array.isArray(payload.tags)) item.tags = payload.tags;
      const page = this.deps.pages()[urlKey];
      if (!page?.path) return;
      const updated = await this.updateAnnotationLines(page.path, item.id, (_item, anchorLine) => {
        const parsed = parseAnnAnchor(anchorLine);
        if (!parsed) return null;
        const meta: AnnMeta = {
          id: item.id,
          url: parsed.url,
          quote: item.quote,
          prefix: item.prefix,
          suffix: item.suffix,
          created: item.created,
          color: item.color || "yellow",
          tags: item.tags ?? [],
          kind: item.kind,
          rect: item.rect,
          shot: item.shot,
          hlOff: item.hlOff === true,
          inlineOff: item.inlineOff === true,
        };
        return { anchorLine: rebuildAnchorLine(anchorLine, meta), note: item.note };
      });
      const wv = this.webviews.get(urlKey);
      if (wv && updated) {
        wv.executeJavaScript(
          "window.__syAnnSetNotes && window.__syAnnSetNotes(" + JSON.stringify([updated]) + ");",
        ).catch(() => {});
      }
    } catch (e) {
      console.warn("[obsidian-browser] annotation applyMeta failed:", e);
    }
  }

  /** 浮动窗「在编辑器中打开」：定位到批注所在的库内笔记 */
  async openEditInVault(id: string): Promise<void> {
    const found = this.findItem(id);
    const page = found ? this.deps.pages()[found.urlKey] : null;
    if (!page?.path) return;
    try {
      await this.app.workspace.openLinkText(page.path, "");
    } catch (e) {
      console.warn("[obsidian-browser] annotation openEdit failed:", e);
    }
  }

  /** 浮动窗「简单编辑」：批注文本就地编辑，写回笔记并同步页内小字。 */
  private async saveNoteFromFloat(id: string, note: string): Promise<void> {
    const ack = (ok: boolean, text?: string) => this.floatChannel?.postMessage({ type: "noteSaved", id, ok, note: text });
    try {
      const found = this.findItem(id);
      if (!found) {
        ack(false);
        return;
      }
      const { urlKey, item } = found;
      const text = String(note || "").replace(/\r/g, "").trim();
      const page = this.deps.pages()[urlKey];
      if (!page?.path) {
        new Notice("该标注缺少笔记文件，请重新打开页面后再试");
        ack(false);
        return;
      }
      const updated = await this.updateAnnotationLines(page.path, item.id, (_item, anchorLine) => ({
        anchorLine,
        note: text,
      }));
      if (!updated) {
        ack(false);
        return;
      }
      item.note = text;
      ack(true, text);
      const wv = this.webviews.get(urlKey);
      if (wv) {
        wv.executeJavaScript(
          "window.__syAnnSetNotes && window.__syAnnSetNotes(" + JSON.stringify([item]) + ");",
        ).catch(() => {});
      }
    } catch (e) {
      console.warn("[obsidian-browser] annotation saveNote failed:", e);
      new Notice("保存批注失败：" + String((e as Error)?.message ?? e));
      ack(false);
    }
  }

  /** 点击高亮 → 轻量浮动窗（独立 OS 窗：快、可多开、可拖出 Obsidian 边界、可固定） */
  async openFloat(webview: IWebviewTag, url: string, payload: { id?: string; x?: number; y?: number; hover?: boolean }): Promise<void> {
    try {
      const urlKey = normalizeUrlKey(url);
      this.webviews.set(urlKey, webview);
      let found = this.findItem(String(payload?.id || ""));
      if (!found) {
        // 缓存缺失兜底（跨页缓存被清/页签换 URL 后的旧 id）：从笔记重拉
        const page = this.deps.pages()[urlKey];
        if (page?.path) {
          const items = await this.readAnnotations(page.path);
          this.pageCache.set(urlKey, items);
          found = this.findItem(String(payload?.id || ""));
        }
      }
      const item = found?.item;
      if (!item) return;
      // 悬浮弹窗开关（showAnnFloat=false：悬浮/点击不再弹窗，仅提示一次）
      if (this.getSettings().showAnnFloat === false) {
        if (!payload?.hover) new Notice("批注悬浮弹窗已在设置中关闭", 2500);
        return;
      }
      const data: Record<string, unknown> = {
        id: item.id,
        quote: item.quote,
        note: item.note,
        color: item.color || "yellow",
        tags: item.tags || [],
        url,
        hover: !!payload?.hover,
        kind: item.kind || "text",
        // 浮窗「取消标注/取消小字」按钮按当前状态置灰（2026-11-28 对齐思源 099a09b）
        hlOff: item.hlOff === true,
        inlineOff: item.inlineOff === true,
      };
      if (item.kind === "rect" && item.shot) {
        data.shot = item.shot;
        data.shotUrl = this.shotResourceUrl(item.shot);
      }
      const popupUrl = this.deps.popupFileUrl();
      if (!popupUrl) return;
      const remote = (window as any).require?.("@electron/remote");
      if (!remote?.BrowserWindow) return;
      // 光标处屏幕坐标（guest 视口坐标 + webview 偏移 + 宿主窗口屏幕位置）
      const wr = webview.getBoundingClientRect();
      const sx = Math.max(0, Math.min(Math.round(window.screenX + wr.left + (payload?.x || 0) + 12), (window.screen.availWidth || 1920) - 390));
      const sy = Math.max(0, Math.min(Math.round(window.screenY + wr.top + (payload?.y || 0) + 12), (window.screen.availHeight || 1080) - 350));
      const exist = this.floatWins.get(item.id);
      if (exist && !exist.isDestroyed()) {
        exist.__syAutoHide = !!payload?.hover;
        this.floatChannel?.postMessage({ type: "autohide", id: item.id, value: !!payload?.hover });
        exist.setPosition(sx, sy);
        exist.show();
        exist.focus();
        return;
      }
      const win = new remote.BrowserWindow({
        width: 380,
        height: 340,
        x: sx,
        y: sy,
        frame: true,
        titleBarStyle: "hidden",
        resizable: false,
        alwaysOnTop: false,
        skipTaskbar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      win.__syAutoHide = !!payload?.hover;
      this.floatWins.set(item.id, win);
      win.on("closed", () => this.floatWins.delete(item.id));
      win.on("move", () => {
        clearTimeout(win.__syMoveT);
        win.__syMoveT = setTimeout(() => this.floatChannel?.postMessage({ type: "dragend", id: item.id }), 400);
      });
      void win.loadURL(popupUrl + "#" + encodeURIComponent(JSON.stringify(data)));
    } catch (e) {
      console.warn("[obsidian-browser] annotation openFloat failed:", e);
    }
  }

  /** 鼠标离开高亮 → 通知悬浮浮动窗（未固定且鼠标不在窗内时自动收起） */
  notifyMarkLeave(id: string): void {
    this.floatChannel?.postMessage({ type: "markleave", id });
  }

  /** 地址栏 ✎ 菜单「本页标注列表」→ 轻量浮动窗列出本页全部标注（可固定、点条目跳转） */
  async openListFloat(webview: IWebviewTag, url: string): Promise<void> {
    try {
      if (!/^https?:\/\//i.test(url)) return;
      const urlKey = normalizeUrlKey(url);
      this.webviews.set(urlKey, webview);
      let items = this.pageCache.get(urlKey);
      const page = this.deps.pages()[urlKey];
      if (!items && page?.path) items = await this.readAnnotations(page.path);
      const listKey = "list:" + urlKey;
      const data = {
        mode: "list",
        url,
        listKey,
        items: (items || []).map((i) => ({ id: i.id, quote: i.quote, note: i.note, color: i.color || "yellow", tags: i.tags || [] })),
      };
      const popupUrl = this.deps.popupFileUrl();
      if (!popupUrl) return;
      const remote = (window as any).require?.("@electron/remote");
      if (!remote?.BrowserWindow) return;
      const exist = this.floatWins.get(listKey);
      if (exist && !exist.isDestroyed()) {
        exist.show();
        exist.focus();
        return;
      }
      const win = new remote.BrowserWindow({
        width: 400,
        height: 440,
        frame: true,
        titleBarStyle: "hidden",
        resizable: false,
        skipTaskbar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      this.floatWins.set(listKey, win);
      win.on("closed", () => this.floatWins.delete(listKey));
      win.on("move", () => {
        clearTimeout(win.__syMoveT);
        win.__syMoveT = setTimeout(() => this.floatChannel?.postMessage({ type: "dragend", id: listKey }), 400);
      });
      void win.loadURL(popupUrl + "#" + encodeURIComponent(JSON.stringify(data)));
    } catch (e) {
      console.warn("[obsidian-browser] annotation openListFloat failed:", e);
    }
  }

  /** 设置开关变更后回刷各页内小字显隐（show 显式传新鲜值，避免缓存 settings 滞后） */
  applyInlineVisibility(show?: boolean): void {
    const v = show === undefined ? !!this.getSettings().showAnnInline : !!show;
    for (const wv of this.webviews.values()) {
      wv.executeJavaScript("window.__syAnnSetInlineVisible && window.__syAnnSetInlineVisible(" + JSON.stringify(v) + ");").catch(() => {});
    }
  }

  /** 设置开关变更后回刷各页内「选中文字弹气泡」开关（2026-11-28 对齐思源 0e96d7b）。 */
  applyBubbleVisibility(show?: boolean): void {
    const v = show === undefined ? this.getSettings().showAnnBubble !== false : !!show;
    for (const wv of this.webviews.values()) {
      wv.executeJavaScript("window.__syAnnSetBubbleVisible && window.__syAnnSetBubbleVisible(" + JSON.stringify(v) + ");").catch(() => {});
    }
  }

  /**
   * 隐藏/显示当前页全部标注高亮（2026-11-28 对齐思源 dcc08fd）。
   * 仅显示层，不改锚点属性、不删标注笔记；页面脚本用 html.sy-ann-hl-hidden
   * 兜住动态新增的高亮，框选矩形一并隐藏。
   */
  async toggleHighlights(webview: IWebviewTag, show?: boolean): Promise<boolean> {
    const expr =
      show === undefined
        ? "(function(){var d=document.documentElement;return !!(d&&d.classList.toggle('sy-ann-hl-hidden'));})()"
        : "(function(){var d=document.documentElement;if(d)d.classList.toggle('sy-ann-hl-hidden',!" + JSON.stringify(!!show) + ");return !!" + JSON.stringify(!show) + ";})()";
    try {
      return !!(await webview.executeJavaScript(expr));
    } catch (e) {
      console.warn("[obsidian-browser] toggleHighlights failed:", e);
      return false;
    }
  }

  /** 列表浮动窗点条目 → 页内滚动到对应高亮并闪烁。
   *  页签不在/已导航到别的页面/页内定位失败时，回退整页打开 url#syann=<id>（走 onPageReady 的自动定位流程），不再静默无反应 */
  private gotoAnnotation(id: string, url: string): void {
    const urlKey = normalizeUrlKey(url);
    const wv = this.webviews.get(urlKey);
    if (wv) {
      let currentKey = "";
      try {
        currentKey = normalizeUrlKey(String((wv as any).getURL?.() || ""));
      } catch {
        /* keep empty */
      }
      // 页签不在前台(offsetParent null)时页内滚动用户看不见,同样走整页打开
      let visible = false;
      try {
        visible = (wv as any).offsetParent !== null;
      } catch {
        /* keep false */
      }
      if (currentKey === urlKey && visible) {
        try {
          wv.executeJavaScript("window.__syAnnFocused=null; (window.__syAnnFocus && window.__syAnnFocus(" + JSON.stringify(id) + ")) || false")
            .then((found: any) => {
              if (!found) this.deps.openLink(url + "#syann=" + id);
            })
            .catch(() => this.deps.openLink(url + "#syann=" + id));
          return;
        } catch {
          // guest 失效（重建竞态）走兜底
        }
      }
    }
    this.deps.openLink(url + "#syann=" + id);
  }

  /** 列表浮动窗「标注此页」→ 页面级标注 */
  private async createPageFromFloat(url: string): Promise<void> {
    const wv = this.webviews.get(normalizeUrlKey(url));
    if (!wv) return;
    const title = String((wv as any).getTitle?.() || "");
    await this.create(wv, url, title, {});
  }

  /** dom-ready 注入页内脚本并恢复本页标注高亮 */
  async onPageReady(webview: IWebviewTag, url: string, _title: string): Promise<void> {
    try {
      if (!/^https?:\/\//i.test(url)) return;
      let items: AnnItem[] = [];
      const urlKey = normalizeUrlKey(url);
      const page = this.deps.pages()[urlKey];
      if (page?.path) {
        items = await this.readAnnotations(page.path);
      }
      this.pageCache.set(urlKey, items);
      this.webviews.set(urlKey, webview);
      // guest 的 items 需要 hl/inline 布尔（取消高亮/取消小字状态回放）
      const guestItems = items.map((i) => ({
        ...i,
        hl: i.hlOff !== true,
        inline: i.inlineOff !== true,
      }));
      const script =
        __ANN_SCRIPT_SOURCE__ +
        "\nwindow.__syAnnInit(" +
        JSON.stringify(guestItems) +
        "," +
        JSON.stringify(!!this.getSettings().showAnnInline) +
        "," +
        JSON.stringify(this.getSettings().showAnnRemove !== false) +
        "," +
        JSON.stringify(this.getSettings().showAnnBubble !== false) +
        ");";
      // 样式必须先于脚本经 insertCSS 注入（不受页面 meta CSP 限制）；
      // 页内 ensureStyle 只作兜底
      try {
        await webview.insertCSS(ANN_CSS);
      } catch (e) {
        console.warn("[obsidian-browser] annotation insertCSS failed:", e);
      }
      await webview.executeJavaScript(script);
      // 回到页签（如从编辑器切回）时刷新批注文本，内联小字/小窗保持最新
      if (!(webview as any).__syAnnNoteHook) {
        (webview as any).__syAnnNoteHook = true;
        webview.addEventListener("focus", () => void this.refreshNotes(webview));
      }
      // SPA/懒加载正文晚于 dom-ready 渲染：补画几轮（已包裹的标注不会重复包裹）。
      // 慢页面/广告重的站点正文可能 10s 后才就位,给到 16s。
      for (const delay of [2000, 5000, 10000, 16000]) {
        setTimeout(() => {
          webview.executeJavaScript("window.__syAnnRender && window.__syAnnRender()").catch(() => {});
        }, delay);
      }
      // 从标注笔记链接跳转而来（url 带 #syann=<id>）：滚动到对应高亮；
      // 高亮渲染时点不定（懒加载），按间隔重试，页内脚本成功后自动置闩。
      // 全部重试后仍未定位（页面内容已变化等）→ 宿主提示,不再无声无息
      const focusId = AnnotationController.extractFocusId(url);
      if (focusId) {
        for (const delay of [600, 1600, 3200, 6500, 10000, 16000, 22000]) {
          setTimeout(() => {
            webview.executeJavaScript("window.__syAnnFocus && window.__syAnnFocus(" + JSON.stringify(focusId) + ");").catch(() => {});
          }, delay);
        }
        setTimeout(() => {
          try {
            webview
              .executeJavaScript("window.__syAnnFocused === " + JSON.stringify(focusId))
              .then((ok: any) => {
                if (!ok) new Notice("未能在页面上定位该标注（页面内容可能已变化）", 4000);
              })
              .catch(() => {});
          } catch {
            /* ignore */
          }
        }, 24500);
      }
    } catch (e) {
      console.warn("[obsidian-browser] annotation inject failed:", e);
    }
  }

  /** 重拉本页批注并刷新页内内联小字/缓存（编辑后切回页签时调用） */
  private async refreshNotes(webview: IWebviewTag): Promise<void> {
    try {
      const url = String((webview as any).getURL?.() || "");
      if (!/^https?:\/\//i.test(url)) return;
      const urlKey = normalizeUrlKey(url);
      const page = this.deps.pages()[urlKey];
      if (!page?.path) return;
      const items = await this.readAnnotations(page.path);
      this.pageCache.set(urlKey, items);
      const guest = items.map((i) => ({ ...i, hl: i.hlOff !== true, inline: i.inlineOff !== true }));
      await webview.executeJavaScript("window.__syAnnSetNotes && window.__syAnnSetNotes(" + JSON.stringify(guest) + ");");
    } catch {
      /* ignore */
    }
  }

  /** 从 URL 提取标注定位片段（#syann=<标注id>） */
  static extractFocusId(url: string): string {
    const m = /#syann=([\w-]+)/.exec(url || "");
    return m ? m[1] : "";
  }

  /** 创建一条标注（quote 为空 = 页面级标注），落到库内笔记并回填页内高亮 */
  async create(webview: IWebviewTag, url: string, title: string, payload: AnnCreatePayload): Promise<void> {
    try {
      if (!/^https?:\/\//i.test(url)) return;
      const urlKey = normalizeUrlKey(url);
      const quote = String(payload?.quote || "").replace(/\s+/g, " ").trim().slice(0, 2000);
      let page: AnnotationPageInfo | null = this.deps.pages()[urlKey];
      if (!page) {
        page = await this.ensurePageNote(url, urlKey, title);
      }
      if (!page) return;

      const now = Date.now();
      const annId = "ann-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const d = new Date();
      const time = stampTime(d);
      // 标注条目 = 库内笔记里的链接：点击（配合链接接管）跳回原网页。
      // - 有选区：链接带 #syann=<id> 片段，打开网页后自动滚动到标注高亮；
      // - 无选区：页面级标注，条目即网页链接 + 时间戳。
      const annUrl = url + "#syann=" + annId;
      const anchorLine = quote
        ? "- [" + escapeLinkText(quote) + "](" + annUrl + ") <!--syann:" + b64encodeUtf8(JSON.stringify({
            id: annId,
            url: urlKey,
            quote,
            prefix: String(payload?.prefix || "").slice(0, 60),
            suffix: String(payload?.suffix || "").slice(0, 60),
            created: now,
            color: String(payload?.color || "yellow"),
            tags: [],
          })) + "-->"
        : "- [" + escapeLinkText(safeTitle(title || url)) + "](" + url + ") - " + time + " <!--syann:" + b64encodeUtf8(JSON.stringify({
            id: annId,
            url: urlKey,
            quote: "",
            prefix: "",
            suffix: "",
            created: now,
            color: "yellow",
            tags: [],
          })) + "-->";
      const adapter = this.app.vault.adapter;
      await adapter.append(page.path, "\n" + anchorLine + "\n");
      const color = String(payload?.color || "yellow");
      if (quote) {
        const item: AnnItem = {
          id: annId,
          quote,
          prefix: String(payload?.prefix || "").slice(0, 60),
          suffix: String(payload?.suffix || "").slice(0, 60),
          note: "",
          created: now,
          color,
          tags: [],
        };
        // 新建标注立即进缓存：点击高亮 → openFloat 靠 pageCache 取项，
        // 不写入会导致本会话内点击刚建的标注静默无窗（须刷新页面才恢复）
        const cached = this.pageCache.get(urlKey) || [];
        cached.push(item);
        this.pageCache.set(urlKey, cached);
        webview.executeJavaScript("window.__syAnnApply && window.__syAnnApply(" + JSON.stringify([item]) + ");").catch(() => {});
      }
      new Notice("已标注", 2000);
    } catch (e: any) {
      console.warn("[obsidian-browser] annotation create failed:", e);
      new Notice("标注失败：" + (e?.message || e), 4000);
    }
  }

  /** 打开当前页面的标注笔记 */
  async openDoc(url: string): Promise<void> {
    const page = this.deps.pages()[normalizeUrlKey(url)];
    if (!page?.path) {
      new Notice("当前页面还没有标注笔记", 3000);
      return;
    }
    try {
      await this.app.workspace.openLinkText(page.path, "");
    } catch (e) {
      console.warn("[obsidian-browser] open annotation doc failed:", e);
    }
  }

  /** 定位页内高亮 → 原生独立窗口流程已并入 openFloat（OS 浮窗直接编辑） */
  async showDialog(webview: IWebviewTag, url: string, payload: { id?: string; x?: number; y?: number }): Promise<void> {
    await this.openFloat(webview, url, { ...payload, hover: false });
  }

  // ---------------- 取消高亮/取消小字（b8b26f2 对齐） ----------------

  /** 设置开关变更后回刷页内「取消」按钮显隐（气泡内按钮族）。 */
  applyRemoveVisibility(showRemove?: boolean): void {
    const v = showRemove === undefined ? this.getSettings().showAnnRemove !== false : !!showRemove;
    for (const wv of this.webviews.values()) {
      wv.executeJavaScript("window.__syAnnSetRemoveVisible && window.__syAnnSetRemoveVisible(" + JSON.stringify(v) + ");").catch(() => {});
    }
  }

  /**
   * 取消标注（页内显示层面，笔记与元数据保留）：kind=hl 取消高亮 / inline 取消
   * 批注小字。取消高亮时小字随高亮一起隐藏（页内无载体）；状态持久化在锚点
   * 元数据 hlOff/inlineOff，重开页面不再恢复对应显示。
   */
  async setDisplayOff(
    _webview: IWebviewTag,
    _url: string,
    payload: { kind?: string; id?: string; quote?: string; prefix?: string; suffix?: string },
  ): Promise<void> {
    try {
      const found = this.findItem(String(payload?.id || ""));
      if (!found) return;
      const { urlKey, item } = found;
      const page = this.deps.pages()[urlKey];
      if (!page?.path) return;
      const unHl = payload?.kind !== "inline";
      // 取消高亮：hlOff=true；取消小字：inlineOff=true（已有状态保持）
      const newHlOff = unHl ? true : item.hlOff === true;
      const newInlineOff = unHl ? item.inlineOff === true : true;
      item.hlOff = newHlOff;
      item.inlineOff = newInlineOff;
      const updated = await this.updateAnnotationLines(page.path, item.id, (_it, anchorLine) => {
        const parsed = parseAnnAnchor(anchorLine);
        if (!parsed) return null;
        const meta: AnnMeta = {
          id: item.id,
          url: parsed.url,
          quote: item.quote,
          prefix: item.prefix,
          suffix: item.suffix,
          created: item.created,
          color: item.color || "yellow",
          tags: item.tags ?? [],
          kind: item.kind,
          rect: item.rect,
          shot: item.shot,
          hlOff: newHlOff,
          inlineOff: newInlineOff,
        };
        return { anchorLine: rebuildAnchorLine(anchorLine, meta), note: item.note };
      });
      if (!updated) return;
      const wv = this.webviews.get(urlKey);
      if (wv) {
        const call = unHl
          ? "window.__syAnnSetMark && window.__syAnnSetMark(" + JSON.stringify(item.id) + ");"
          : "window.__syAnnSetInlineOff && window.__syAnnSetInlineOff(" + JSON.stringify(item.id) + ");";
        wv.executeJavaScript(call).catch(() => {});
      }
    } catch (e) {
      console.warn("[obsidian-browser] annotation setDisplayOff failed:", e);
    }
  }

  // ---------------- 框选截图标注（35ae788 对齐） ----------------

  /** 框选截图资产目录：<标注保存目录>/assets/<域名>/ */
  private shotAssetDir(domain: string): string {
    const folder = (this.getSettings().annotationsFolder || "Browser/Annotations").replace(/^\/+|\/+$/g, "");
    return folder + "/assets/" + (domain || "未分类");
  }

  /** 框选截图 → vault 落盘（PNG dataURL → 二进制），返回 vault 相对路径。 */
  private async saveShot(dataUrl: string, domain: string): Promise<string> {
    const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dir = this.shotAssetDir(domain);
    const d = new Date();
    const name =
      "annot-" +
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      "-" +
      Date.now().toString(36) +
      ".png";
    const path = dir + "/" + name;
    const adapter = this.app.vault.adapter;
    await adapter.mkdir(dir).catch(() => {});
    await adapter.writeBinary(path, bytes.buffer as ArrayBuffer);
    return path;
  }

  /** vault 相对路径 → 浮窗 <img> 可用的资源 URL。 */
  private shotResourceUrl(path: string): string {
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f) return this.app.vault.getResourcePath(f as TFile);
    } catch {
      /* ignore */
    }
    return "";
  }

  /** 開始框选：页内遮罩拖拽取框（reanchorId 非空 = 框选改锚模式，替换既有截图）。 */
  beginCapture(webview: IWebviewTag, _url: string, reanchorId?: string): void {
    void webview
      .executeJavaScript("window.__syAnnCaptureStart && window.__syAnnCaptureStart(" + JSON.stringify(reanchorId || null) + ");")
      .catch(() => {});
  }

  /** 框选改锚模式：下一次选区的气泡出「改锚」按钮（换锚点文字，批注不动）。 */
  beginReanchor(webview: IWebviewTag, id: string): void {
    void webview.executeJavaScript("window.__syAnnReanchorPending = " + JSON.stringify(id) + ";").catch(() => {});
    new Notice("请选中新的文字，气泡里点「改锚」", 4000);
  }

  /** 框选完成（页内遮罩上报文档坐标 + 视口坐标）→ 截屏落盘 → 创建/更新框选标注。 */
  async onRectCaptured(
    webview: IWebviewTag,
    url: string,
    title: string,
    payload: { id?: string; rect?: { x: number; y: number; w: number; h: number }; vrect?: { x: number; y: number; w: number; h: number } },
  ): Promise<void> {
    try {
      if (!/^https?:\/\//i.test(url)) return;
      const rect = payload?.rect;
      const vrect = payload?.vrect;
      if (!rect || rect.w < 10 || rect.h < 10) return;
      // 截屏（视口坐标）——遮罩已先移除，不会拍进图里
      const wc = webContentsFromId(webview.getWebContentsId?.() ?? -1);
      if (!wc?.capturePage) return;
      const vr = {
        x: Math.max(0, Math.round(vrect?.x ?? rect.x)),
        y: Math.max(0, Math.round(vrect?.y ?? rect.y)),
        width: Math.max(10, Math.round(vrect?.w ?? rect.w)),
        height: Math.max(10, Math.round(vrect?.h ?? rect.h)),
      };
      const img: any = await wc.capturePage(vr);
      const dataUrl = String(img?.toDataURL?.() ?? "");
      if (!dataUrl.startsWith("data:image/png")) throw new Error("capturePage 返回非 PNG");

      const urlKey = normalizeUrlKey(url);
      const domain = getDomain(url);
      const shotPath = await this.saveShot(dataUrl, domain);
      const now = Date.now();
      const reId = String(payload?.id || "");
      // 改框选（重新框选）：更新既有锚点的截图与坐标，批注保持对应
      if (reId) {
        const found = this.findItem(reId);
        if (!found) return;
        const { urlKey: k0, item } = found;
        const oldShot = String(item.shot || "");
        const page = this.deps.pages()[k0];
        if (!page?.path) return;
        item.rect = rect;
        item.shot = shotPath;
        await this.updateAnnotationLines(page.path, item.id, (_it, anchorLine) => {
          const parsed = parseAnnAnchor(anchorLine);
          if (!parsed) return null;
          const meta: AnnMeta = {
            id: item.id, url: parsed.url, quote: item.quote, prefix: item.prefix,
            suffix: item.suffix, created: item.created, color: item.color || "yellow",
            tags: item.tags ?? [], kind: "rect", rect, shot: shotPath,
            hlOff: item.hlOff === true, inlineOff: item.inlineOff === true,
          };
          return { anchorLine: rebuildAnchorLine(anchorLine, meta), note: item.note };
        });
        // 旧截图清理（同笔记其它框选还在引用则保留）
        if (oldShot && oldShot !== shotPath) {
          const stillUsed = Object.values(this.deps.pages()).some((p) => {
            void p;
            return false;
          });
          void stillUsed;
        }
        this.pageCache.set(urlKey, await this.readAnnotations(page.path));
        const guest = this.pageCache.get(urlKey)!.map((i) => ({ ...i, hl: i.hlOff !== true, inline: i.inlineOff !== true }));
        webview.executeJavaScript("window.__syAnnReanchorDone && window.__syAnnReanchorDone(" + JSON.stringify(guest) + ");").catch(() => {});
        new Notice("已重新框选", 2000);
        return;
      }
      // 新建框选标注
      let page: AnnotationPageInfo | null = this.deps.pages()[urlKey];
      if (!page) page = await this.ensurePageNote(url, urlKey, title);
      if (!page) return;
      const annId = "ann-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const anchorLine =
        "- [" + escapeLinkText("框选") + "](" + url + "#syann=" + annId + ") <!--syann:" +
        b64encodeUtf8(JSON.stringify({
          id: annId, url: urlKey, quote: "", prefix: "", suffix: "", created: now,
          color: "yellow", tags: [], kind: "rect", rect, shot: shotPath,
          hlOff: false, inlineOff: false,
        })) + "-->";
      const adapter = this.app.vault.adapter;
      await adapter.append(page.path, "\n" + anchorLine + "\n    ![" + "[" + shotPath + "]]\n");
      const item: AnnItem = {
        id: annId, quote: "", prefix: "", suffix: "", note: "", created: now,
        color: "yellow", tags: [], kind: "rect", rect, shot: shotPath,
      };
      const cached = this.pageCache.get(urlKey) || [];
      cached.push(item);
      this.pageCache.set(urlKey, cached);
      webview.executeJavaScript("window.__syAnnApply && window.__syAnnApply(" + JSON.stringify([item]) + ");").catch(() => {});
      new Notice("已框选标注", 2000);
    } catch (e: any) {
      console.warn("[obsidian-browser] rect capture failed:", e);
      new Notice("框选标注失败：" + (e?.message || e), 4000);
    }
  }

  /** 文字改锚：换锚点文字与高亮位置，批注保持对应。 */
  async reanchorText(
    webview: IWebviewTag,
    _url: string,
    payload: { id?: string; quote?: string; prefix?: string; suffix?: string },
  ): Promise<void> {
    try {
      const found = this.findItem(String(payload?.id || ""));
      if (!found) return;
      const { urlKey, item } = found;
      const quote = String(payload?.quote || "").replace(/\s+/g, " ").trim().slice(0, 2000);
      if (!quote) return;
      const page = this.deps.pages()[urlKey];
      if (!page?.path) return;
      item.quote = quote;
      item.prefix = String(payload?.prefix || "").slice(0, 60);
      item.suffix = String(payload?.suffix || "").slice(0, 60);
      item.hlOff = false;
      const updated = await this.updateAnnotationLines(page.path, item.id, (_it, anchorLine) => {
        const parsed = parseAnnAnchor(anchorLine);
        if (!parsed) return null;
        const meta: AnnMeta = {
          id: item.id, url: parsed.url, quote: item.quote, prefix: item.prefix,
          suffix: item.suffix, created: item.created, color: item.color || "yellow",
          tags: item.tags ?? [], kind: item.kind, rect: item.rect, shot: item.shot,
          hlOff: false, inlineOff: item.inlineOff === true,
        };
        return { anchorLine: rebuildAnchorLine(anchorLine, meta), note: item.note };
      });
      const guest = updated ? { ...updated, hl: updated.hlOff !== true, inline: updated.inlineOff !== true } : null;
      if (guest) {
        webview.executeJavaScript(
          "window.__syAnnReanchorDone && window.__syAnnReanchorDone(" + JSON.stringify(guest) + ");",
        ).catch(() => {});
      }
      new Notice("已改锚", 2000);
    } catch (e: any) {
      console.warn("[obsidian-browser] annotation reanchor failed:", e);
      new Notice("改锚失败：" + (e?.message || e), 4000);
    }
  }
}
