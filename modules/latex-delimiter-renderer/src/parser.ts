export type MathDelimiterMatch = {
  from: number;
  to: number;
  source: string;
  display: boolean;
};

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findClosingDelimiter(text: string, from: number, close: string): number {
  for (let cursor = from; cursor <= text.length - close.length; cursor++) {
    if (text.startsWith(close, cursor) && !isEscaped(text, cursor)) return cursor;
  }
  return -1;
}

/**
 * Finds LaTeX paren/bracket math in plain text. Code spans and fenced code are
 * excluded by the caller because Reading View and Live Preview expose syntax
 * information differently.
 */
export function findMathDelimiters(text: string, offset = 0): MathDelimiterMatch[] {
  const matches: MathDelimiterMatch[] = [];

  for (let cursor = 0; cursor < text.length - 1; cursor++) {
    if (text[cursor] !== "\\" || isEscaped(text, cursor)) continue;

    const kind = text[cursor + 1];
    if (kind !== "(" && kind !== "[") continue;

    const display = kind === "[";
    const close = display ? "\\]" : "\\)";
    const closeAt = findClosingDelimiter(text, cursor + 2, close);
    if (closeAt === -1) continue;

    const source = text.slice(cursor + 2, closeAt);
    if (source.trim().length === 0 || (!display && source.includes("\n"))) continue;

    matches.push({
      from: offset + cursor,
      to: offset + closeAt + close.length,
      source,
      display
    });
    cursor = closeAt + close.length - 1;
  }

  return matches;
}

function convertPlainSegment(text: string): string {
  const matches = findMathDelimiters(text);
  if (matches.length === 0) return text;

  let converted = "";
  let cursor = 0;
  for (const match of matches) {
    converted += text.slice(cursor, match.from);
    converted += match.display ? `$$${match.source}$$` : `$${match.source}$`;
    cursor = match.to;
  }
  return converted + text.slice(cursor);
}

/** Converts only for an in-memory rendering pass; fenced and inline code stay literal. */
export function convertForObsidianRender(markdown: string): string {
  const fencedPattern = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
  const inlineCodePattern = /(`+[^`\n]*?`+)/g;

  return markdown
    .split(fencedPattern)
    .map((block) => {
      if (block.startsWith("```") || block.startsWith("~~~")) return block;
      return block
        .split(inlineCodePattern)
        .map((piece) => (piece.startsWith("`") ? piece : convertPlainSegment(piece)))
        .join("");
    })
    .join("");
}
