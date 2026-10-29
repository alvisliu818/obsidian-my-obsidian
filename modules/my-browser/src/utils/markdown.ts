import TurndownService from "turndown";

export interface MarkdownOptions {
  /** Drop link markup but keep the text (used when images failed to download). */
  stripLinks?: boolean;
}

let cached: TurndownService | null = null;

function service(): TurndownService {
  if (cached) return cached;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });

  // Tables: Turndown core has none, and clipped pages are full of them.
  const cell = (content: string) => " " + content.trim().replace(/\s*\|\s*/g, " \\| ").replace(/\n+/g, " ") + " |";
  td.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content) => cell(content),
  });
  td.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const isHeader = el.parentElement?.tagName === "THEAD";
      let out = "|" + content.replace(/\|\s*$/, "|");
      if (isHeader || (!el.parentElement?.parentElement?.querySelector("thead") && el === el.parentElement?.firstElementChild)) {
        const cells = Array.from(el.children).length || 1;
        out += "\n|" + Array(cells).fill(" --- ").join("|") + "|";
      }
      return out + "\n";
    },
  });
  td.addRule("table", {
    filter: "table",
    replacement: (content) => "\n\n" + content.replace(/\n{3,}/g, "\n\n") + "\n",
  });

  // Keep the language hint from <pre data-language>.
  td.addRule("fencedCodeBlock", {
    filter: (node) =>
      node.nodeName === "PRE" && !!node.firstElementChild && node.firstElementChild.nodeName === "CODE",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const code = el.firstElementChild as HTMLElement;
      const m = (el.getAttribute("data-language") || code.className || "").match(/language-([\w+#.-]+)/);
      const lang = el.getAttribute("data-language") || (m ? m[1] : "");
      const text = code.textContent ?? "";
      const fence = "```";
      return "\n\n" + fence + (lang || "") + "\n" + text.replace(/\n$/, "") + "\n" + fence + "\n\n";
    },
  });

  // Markdown has no strike-through in Turndown core.
  td.addRule("strikethrough", {
    filter: ["del", "s"],
    replacement: (content) => (content.trim() ? "~~" + content + "~~" : ""),
  });

  cached = td;
  return td;
}

export function htmlToMarkdown(html: string, _opts: MarkdownOptions = {}): string {
  const md = service().turndown(html || "");
  return md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
    // A link whose text equals its target is noise in a clipped note.
    .replace(/\[(https?:\/\/[^\]]+)\]\(\1\)/g, "$1");
}
