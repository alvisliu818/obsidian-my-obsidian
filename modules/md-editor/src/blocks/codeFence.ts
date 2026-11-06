// 代码围栏解析(从 codeBlockEdit.ts 抽出的纯逻辑):
// 独立成模块让单测不必拉起 Monaco(块编辑器现在内嵌 Monaco,import 很重)。

export interface CodeFenceInfo {
  /** Lines BEFORE the opening fence (mixed blocks: image/prose + fence). */
  prefix: string;
  /** Language from the opening fence ('' when absent). */
  lang: string;
  /** The code content between the fences. */
  content: string;
  /** The exact opening fence run (``` / ~~~ / longer). */
  fence: string;
  /** The full opening fence LINE (fence + language) — commit re-wraps with it. */
  openLine: string;
  /** Whether the block text carried a closing fence. */
  closed: boolean;
}

const FENCE_LINE_RE = /^(`{3,}|~{3,})([^\n`]*)$/;

/**
 * Parse a block whose text ends in a code fence: [prefix lines +] opening
 * fence → content → closing fence (or unterminated). The prefix (an image,
 * prose) stays rendered statically while the fence gets the dedicated code
 * editor. Returns null when the text has no fence line, or when non-blank
 * content follows the closing fence — the generic outline editor must keep
 * those blocks so no text is ever dropped on commit.
 */
export function parseCodeFence(text: string): CodeFenceInfo | null {
  const lines = text.split('\n');
  // The opening fence may sit at any line — mixed blocks carry a prefix.
  let openIdx = -1;
  let open: RegExpExecArray | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_LINE_RE.exec(lines[i]);
    if (m) {
      openIdx = i;
      open = m;
      break;
    }
  }
  if (openIdx < 0 || !open) return null;
  const fence = open[1];
  const lang = open[2].trim();
  let closed = false;
  let end = lines.length;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (new RegExp('^' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) {
      // A code block ENDS at its closing fence. Non-blank content after it
      // (a second fence, trailing prose) means this block has a tail the code
      // editor cannot represent: mounting it would commit only up to the
      // FIRST closing fence and silently drop the rest.
      if (lines.slice(i + 1).some((l) => l.trim() !== '')) return null;
      closed = true;
      end = i;
      break;
    }
  }
  return {
    prefix: lines.slice(0, openIdx).join('\n'),
    lang,
    content: lines.slice(openIdx + 1, closed ? end : lines.length).join('\n'),
    fence,
    openLine: lines[openIdx],
    closed,
  }
}