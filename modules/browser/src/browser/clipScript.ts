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
(window as any).__obsidianClipRun = function (cfg: any): string {
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
