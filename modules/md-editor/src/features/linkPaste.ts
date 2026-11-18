/**
 * 链接粘贴与插入(og html-link-format! / SilverBullet pasteLinkExtension 对齐,
 * 2026-11-19):
 *
 *  - 粘贴分派的 URL 分支:粘贴文本是 URL 且有非空选区 → 选区包成
 *    `[选区](url)`;反向,粘贴文本非 URL 而选区是 URL → `[粘贴文本](选区URL)`。
 *    URL 覆盖 URL 不接管(等价于默认替换,og replace-text-f 同果)。
 *    参考语义:og handler/paste.cljs 的 text-url?/selection-url? cond 分支
 *    (html-link-format! 路径)+ SilverBullet client/codemirror/editing/
 *    editor_paste.ts 的 pasteLinkExtension(有选区时 URL 替换为
 *    `[selection](url)`)——两参考行为一致,这里取并集。
 *  - Mod+L 插入链接(og modules/shortcut/config.cljs :editor/insert-link,
 *    mod+l → editor-handler/html-link-format!):空选区插 `[]()` 光标落
 *    label 位(og config/get-empty-link-and-forward-pos markdown 分支
 *    `["[]()" 1]`);有选区包成 `[选区]()` 光标落 URL 位(og
 *    config/with-default-label:`[label]()` 前向位 = 3 + label.length = 串尾)。
 *
 * URL 判定取 SilverBullet 的 urlRegexp 口径(锚定 http/https、不含空白);
 * og 的 gp-util/url? 更宽,但「含空白的文本不算 URL」两边一致,这里从严——
 * 误判 URL 会吞掉普通粘贴,从严副作用小。
 *
 * 决策是纯函数(单测直测);CM6 命令只做 view.dispatch。
 */

import { EditorView } from '@codemirror/view';

/** 锚定 URL:整段就是 http(s) 链接、无空白(SilverBullet urlRegexp 同款口径)。 */
const URL_RE = /^https?:\/\/[-a-zA-Z0-9@:%._+~#=]{1,256}([-a-zA-Z0-9()@:%_+.~#?&//=]*)$/;

export function isBareUrl(s: string): boolean {
  return URL_RE.test(s);
}

export interface LinkPasteDecision {
  /** 替换选区写入的 markdown 链接 */
  insert: string;
}

/**
 * URL 粘贴决策(纯函数):
 *  - 粘贴 URL + 非 URL 选区 → `[选区](url)`
 *  - 粘贴非 URL 单行文本 + URL 选区 → `[文本](选区url)`(og「粘贴文本覆盖
 *    选中的链接」;多行文本不作 label,落默认粘贴)
 *  - 其余(URL↔URL、空选区、双方都不是 URL)→ null 落默认粘贴
 */
export function linkPasteDecision(pasted: string, selected: string): LinkPasteDecision | null {
  if (!pasted) return null;
  if (isBareUrl(pasted)) {
    if (!selected || isBareUrl(selected)) return null;
    return { insert: `[${selected}](${pasted})` };
  }
  if (selected && isBareUrl(selected) && !pasted.includes('\n')) {
    return { insert: `[${pasted}](${selected})` };
  }
  return null;
}

/**
 * Mod+L 插入链接(og html-link-format! 的 markdown 分支):空选区 `[]()`
 * 光标进 label;有选区 `[选区]()` 光标进 URL 位。多光标只处理主选区。
 */
export function insertLinkCommand(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const insert = sel.empty ? '[]()' : `[${selected}]()`;
  const caret = sel.empty ? sel.from + 1 : sel.from + insert.length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: caret },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}
