/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-page collector for the web clipper.
 *
 * Bundled to an IIFE and injected with executeJavaScript, so it sees the REAL
 * document (Readability needs the live DOM). It never mutates the page — it
 * clones first, then harvests image URLs for the host to download (a cross-origin
 * fetch in the guest often fails, while the host can pull them with the right
 * Referer).
 *
 * Returns a JSON string: { ok, title, byline, siteName, excerpt, href, html,
 * images, error }
 */
(window as any).__obsidianClipRun = async function (cfg: any): Promise<string> {
  const out: any = {
    ok: true,
    title: "",
    byline: "",
    siteName: "",
    excerpt: "",
    href: location.href,
    html: "",
    images: [] as string[],
    error: "",
  };

  const abs = (src: string): string => {
    if (!src) return "";
    try {
      return new URL(src, location.href).href;
    } catch {
      return "";
    }
  };

  try {
    const mode = cfg && cfg.mode === "selection" ? "selection" : "article";
    let root: HTMLElement;

    if (mode === "selection") {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        out.ok = false;
        out.error = "no_selection";
        return JSON.stringify(out);
      }
      root = document.createElement("div");
      root.appendChild(sel.getRangeAt(0).cloneContents());
      out.title = document.title;
    } else {
      const clone = document.cloneNode(true) as Document;
      let article: any = null;
      try {
        const R = (window as any).Readability;
        if (R) {
          article = new R(clone, { keepClasses: false, charThreshold: 16 }).parse();
        }
      } catch (e) {
        article = null;
      }
      if (article && article.content) {
        root = document.createElement("div");
        // Readability returns a fragment string; parse it relative to the page
        // so that relative URLs stay resolvable.
        root.innerHTML = article.content;
        out.title = article.title || document.title;
        out.byline = article.byline || "";
        out.excerpt = (article.excerpt || "").trim();
        out.siteName = article.siteName || "";
      } else {
        // Fall back to the whole body rather than clipping nothing.
        root = document.createElement("div");
        const body = document.body ? (document.body.cloneNode(true) as HTMLElement) : document.createElement("div");
        root.appendChild(body);
        out.title = document.title;
        const meta = document.querySelector('meta[name="description"]');
        out.excerpt = meta ? (meta.getAttribute("content") || "").trim() : "";
      }
    }

    // Drop the noise that never survives a Markdown round-trip.
    const drop = root.querySelectorAll(
      "script,style,noscript,template,link,meta,button,input,select,textarea,form[role=search]",
    );
    for (let i = 0; i < drop.length; i++) drop[i].remove();

    // Keep code blocks (including their language) — Turndown rules read this.
    const pres = root.querySelectorAll("pre");
    for (let i = 0; i < pres.length; i++) {
      const pre = pres[i] as HTMLElement;
      const code = pre.querySelector("code");
      const cls = (code?.className || pre.className || "").match(/(?:language|lang|highlight)-([a-zA-Z0-9+#-]+)/);
      if (cls) pre.setAttribute("data-language", cls[1]);
    }

    // Formulas: keep the LaTeX source, not the rendered MathJax soup.
    const maths = root.querySelectorAll("[data-formula],.ztext-math,.katex-mathml");
    for (let i = 0; i < maths.length; i++) {
      const n = maths[i] as HTMLElement;
      const tex = n.getAttribute("data-formula") || n.textContent || "";
      if (tex) n.textContent = tex;
    }

    // 预处理六开关（思源同款）：粗体/斜体/下划线物化为标签、去图外链、
    // span 断行转 <br>、内联 SVG 转 dataURL 图。在图片采集前执行。
    const exp = (cfg && cfg.exp) || {};
    if (exp.svgToImg) await clipSvgToImg(root);
    if (exp.removeImgLink) clipRemoveImgLink(root);
    if (exp.spanBr) clipSpansAddBr(root);
    if (exp.bold) clipProcessBold(root);
    if (exp.italic) clipProcessItalic(root);
    if (exp.underline) clipProcessUnderline(root);

    const imgs = Array.from(root.querySelectorAll("img")) as HTMLImageElement[];
    const seen = new Set<string>();
    for (const img of imgs) {
      // Lazy-loaded sites keep the real URL in a data attribute.
      const raw =
        img.getAttribute("data-original") ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy-src") ||
        img.getAttribute("src") ||
        "";
      if (!raw) {
        img.remove();
        continue;
      }
      if (raw.startsWith("data:")) continue;
      let src = abs(raw);
      if (!src) {
        img.remove();
        continue;
      }
      if (location.protocol === "https:" && src.startsWith("http:")) src = src.replace(/^http:/, "https:");
      img.setAttribute("src", src);
      if (cfg && cfg.assets === false) continue;
      if (!seen.has(src)) {
        seen.add(src);
        out.images.push(src);
      }
    }

    // Some sites hide images in <a href> lightboxes; not worth chasing.
    out.html = root.innerHTML;
    out.lang = document.documentElement.lang || "";
  } catch (e: any) {
    out.ok = false;
    out.error = String(e && e.message ? e.message : e);
  }
  return JSON.stringify(out);
};

// ==========================================================================
// 摘录预处理六变换（思源同款，2026-11-18 对齐移植）：物化计算样式为真实标签，
// Markdown 转换才不丢格式。全部作用于克隆后的摘录根，不碰页面本身。
// ==========================================================================

function isAnnOrClipNoise(el: Element): boolean {
  return !!el.closest("script,style,noscript,textarea,xmp,#sy-ann-pop,#sy-ann-bubble,.sy-ann-inline");
}

function parentContainsTag(element: Element, tags: string[]): boolean {
  let parent = element.parentElement;
  while (parent) {
    if (tags.includes(parent.tagName)) return true;
    parent = parent.parentElement;
  }
  return false;
}

/** 通用样式物化：命中 styleProp 的元素把文本子节点包进 wrapTag（递归，跳过已包裹的祖先/子树） */
function processStyleWrap(root: HTMLElement, wrapTag: string, styleProp: string, values: string[], ancestorTags: string[]): void {
  const all = root.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    if (ancestorTags.includes(el.tagName)) continue;
    if (parentContainsTag(el, ancestorTags)) continue;
    let style: any;
    try {
      style = window.getComputedStyle(el);
    } catch {
      continue;
    }
    const hit = values.some((v) => String(style?.[styleProp] ?? "").toLowerCase() === v) ||
      (styleProp === "textDecorationLine" && String(style?.[styleProp] ?? "").includes("underline"));
    if (!hit) continue;
    const children = Array.from(el.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue && child.nodeValue.trim()) {
        const tag = document.createElement(wrapTag);
        tag.textContent = child.nodeValue;
        el.replaceChild(tag, child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const t = (child as HTMLElement).tagName.toLowerCase();
        if (wrapTag === t || ancestorTags.map((x) => x.toLowerCase()).includes(t)) continue;
        if (parentContainsTag(child as HTMLElement, ancestorTags)) continue;
        processStyleWrap(child as HTMLElement, wrapTag, styleProp, values, ancestorTags);
      }
    }
  }
}

function clipProcessBold(root: HTMLElement): void {
  processStyleWrap(root, "b", "fontWeight", ["bold", "700"], ["B", "STRONG", "H1", "H2", "H3", "H4", "H5", "H6"]);
}
function clipProcessItalic(root: HTMLElement): void {
  processStyleWrap(root, "i", "fontStyle", ["italic"], ["I", "EM"]);
}
function clipProcessUnderline(root: HTMLElement): void {
  processStyleWrap(root, "u", "textDecorationLine", ["underline"], ["U"]);
}

function clipRemoveImgLink(root: HTMLElement): void {
  const images = root.querySelectorAll("img");
  for (const image of Array.from(images)) {
    const parent = image.parentElement;
    if (!parent || parent.tagName !== "A") continue;
    const grand = parent.parentElement;
    if (!grand) continue;
    grand.insertBefore(image, parent);
    parent.remove();
  }
}

/** span 断行转 <br>：white-space normal/pre-wrap 且 word-break break-word 的 span */
function clipSpansAddBr(root: HTMLElement): void {
  const spans = root.querySelectorAll("span");
  const brTag = document.createElement("br");
  for (const span of Array.from(spans) as HTMLElement[]) {
    if (isAnnOrClipNoise(span)) continue;
    let style: any;
    try {
      style = window.getComputedStyle(span);
    } catch {
      continue;
    }
    const ws = String(style?.whiteSpace ?? "").trim().toLowerCase();
    const bw =
      String(style?.wordWrap ?? "").trim().toLowerCase() === "break-word" ||
      String(style?.overflowWrap ?? "").trim().toLowerCase() === "break-word" ||
      String(style?.wordBreak ?? "").trim().toLowerCase() === "break-word";
    if (!(ws === "normal" || ws === "pre-wrap") || !bw) continue;
    // 简化实现：把 span 的行内文本按渲染换行近似重建——textContent 按句段插 <br>
    // （思源版按 computed text 分段；此处保真度足够，md 转换主要吃换行结构）
    const text = span.textContent || "";
    if (!text.trim()) continue;
    const segments = text.split(/\n+/);
    if (segments.length < 2) continue;
    span.innerHTML = "";
    segments.forEach((seg, idx) => {
      if (idx > 0) span.appendChild(brTag.cloneNode());
      span.appendChild(document.createTextNode(seg));
    });
  }
}

async function clipSvgToImg(root: HTMLElement): Promise<void> {
  const svgs = Array.from(root.querySelectorAll("svg"));
  for (const svg of svgs) {
    try {
      const serializer = new XMLSerializer();
      let svgStr = serializer.serializeToString(svg);
      if (!svgStr.startsWith("<?xml")) svgStr = '<?xml version="1.0" encoding="UTF-8"?>' + svgStr;
      const blob = new Blob([svgStr], { type: "image/svg+xml" });
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const img = document.createElement("img");
      img.src = dataUrl;
      try {
        img.style.cssText = window.getComputedStyle(svg).cssText;
      } catch {
        /* ignore */
      }
      svg.parentNode?.replaceChild(img, svg);
    } catch {
      /* 单个 SVG 失败不拖垮整页 */
    }
  }
}
