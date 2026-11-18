/**
 * 块编辑器内的第三方 EditorSuggest 驱动(Various Complements 并入,2026-11-19):
 *
 * md-editor 的自绘补全([[ # (( 源走 CM6 autocompletion;`/` `<` 走自绘命令
 * 菜单 + editorSuggest.trigger(triggerNativeSlash))。但 es.trigger 只在那
 * 两个触发符时被调用——第三方 EditorSuggest(Various Complements 的随打随
 * 补全、以及其他插件的 suggester)在块编辑器里从未被触发。
 *
 * 本模块在打字/选区移动时防抖调用 `es.trigger(适配器, 文件, 按键事件)`,
 * 把整条 editorSuggest 管线接到块编辑器:native 编辑器同款语义——每个
 * suggester 自己判定触发条件并自管守卫(VC 的最小字符数/禁用首字符/
 * IME 抑制/围栏抑制/策略开关/内部防抖全部是它自己的设置),弹层即原生
 * suggest popup(与块编辑器里已工作的原生斜杠菜单同一套框架)。
 *
 * 触发门(防双弹层/误触发):
 *  - IME 组合中不触发(VC disableSuggestionsDuringImeOn 同规,-native 同款);
 *  - 自家 CM 补全弹层 active(可见)时不触发——[[ # (( 的键面归它;
 *  - 自绘命令菜单(/ <)打开时不触发——打字在过滤菜单,不该再弹词;
 *  - 键事件陈旧(>300ms,纯鼠标移动光标)不触发——VC 按「光标前缀词」判定,
 *    陈旧键事件会让它在新词位误弹;此时取消待发,弹层交给它自身的
 *    closeOnBlur 处理。
 *
 * 方向键等移动键也走触发(native 每 keyup 都触发,VC 按 evt 里的键自行决定
 * 弹/收——光标移进词里它弹,移出它收);docChanged(打字/粘贴/删除)必触发。
 *
 * 应用建议回写走适配器 replaceRange/setCursor(textSelectionMenu.ts 的
 * createEditorAdapter)→ CM 事务 → updateListener 的 docChanged 同步块模型,
 * 全链路与原生斜杠菜单同一条路。
 */

import { completionStatus } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { BlockRenderHost } from '../blocks/renderHost';
import { isMenuOpen } from './commandMenu';
import { createEditorAdapter } from '../interactions/textSelectionMenu';

/** 合并连续击键的削峰窗口(VC 自身还有内部节流;这里只管别每键全量走管线)。 */
const TRIGGER_DEBOUNCE_MS = 120;

/** 键事件新鲜度:超过该时长的 __lastKeyEvent 视为陈旧(纯鼠标移动光标)。 */
const EVT_FRESH_MS = 300;

interface EditorSuggestHost {
  trigger(editor: unknown, file: unknown, evt: KeyboardEvent | null): void;
  isShowingSuggestion?(): boolean;
}

function esHost(): EditorSuggestHost | null {
  const es = (
    window as unknown as {
      app?: { workspace?: { editorSuggest?: EditorSuggestHost } };
    }
  ).app?.workspace?.editorSuggest;
  // typeof 守卫收窄:native 管线必带 trigger,防御第三方环境差异。
  return es && typeof es.trigger === 'function' ? es : null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: { view: EditorView; host: BlockRenderHost } | null = null;

function cancelPending(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
}

function fire(): void {
  timer = null;
  const cur = pending;
  pending = null;
  if (!cur) return;
  const { view, host } = cur;
  const es = esHost();
  if (!es) return;
  // 防抖窗口内焦点可能已走(点别的块/切面板):按 view 身份验活。
  if (host.focusedView !== view && host.embedEdit?.view !== view) return;
  // 触发前再验自家弹层:pending → active 的窗口内敲了 [[ 之类,弹层归它。
  if (completionStatus(view.state) === 'active' || isMenuOpen()) return;
  const evt = (window as unknown as { __lastKeyEvent?: KeyboardEvent }).__lastKeyEvent ?? null;
  const adapter = createEditorAdapter(view, host);
  try {
    es.trigger(adapter, host.file ?? null, evt);
  } catch {
    // 第三方 suggester 抛错不拖垮编辑(native 管线对各家本就无隔离,这里兜一层)
  }
}

/**
 * 第三方 EditorSuggest 触发入口(docChanged / 键驱动的 selectionSet 时调用,
 * 见 editor/extensions.ts 的 updateListener)。设置关闭时完全不接管。
 */
export function maybeTriggerThirdPartySuggests(view: EditorView, host: BlockRenderHost): void {
  if (host.plugin.settings.thirdPartySuggestsEnabled === false) return;
  if (view.composing) {
    cancelPending(); // IME 组合中的半截文本不算触发(VC 同规)
    return;
  }
  if (completionStatus(view.state) === 'active' || isMenuOpen()) {
    cancelPending(); // 自家弹层持有键面
    return;
  }
  // 键事件新鲜度:方向键等移动键带新鲜 evt(VC 自行决定弹/收);纯鼠标移动
  // 光标不带新键事件,陈旧 evt 会让 VC 在新词位误弹——放弃并取消待发。
  const evt = (window as unknown as { __lastKeyEvent?: KeyboardEvent }).__lastKeyEvent;
  if (!evt || performance.now() - evt.timeStamp > EVT_FRESH_MS) {
    cancelPending();
    return;
  }
  cancelPending();
  pending = { view, host };
  timer = setTimeout(fire, TRIGGER_DEBOUNCE_MS);
}
