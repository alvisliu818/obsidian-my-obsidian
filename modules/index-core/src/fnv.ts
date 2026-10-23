/**
 * 轻量内容 hash：FNV-1a 32bit + 长度。
 * 用途：索引变更门（防同步盘 mtime 抖动），不防碰撞攻击，不需要加密强度。
 * 输出 "xxxxxxxx:len"——把长度编进 hash，同前缀不同长内容不会撞同值。
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // FNV prime
  }
  return `${h.toString(16).padStart(8, "0")}:${text.length}`;
}
