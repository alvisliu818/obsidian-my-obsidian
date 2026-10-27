/**
 * GFM 任务列表 marker 纯函数（思源 wysiwyg/taskListMarker.ts 1:1 移植，批次 23）。
 *
 * 思源四态：`[ ]` 未完成 / `[/]` 进行中 / `[X]` 完成 / `[-]` 取消；任意其他
 * 单字符是自定义状态。点击切换（nextTaskListMarker）是两态 toggle：未完成类
 * → 完成态 'X'，完成/取消/自定义 → 未完成 ' '；四态循环（nextTaskListStatus）
 * 是键盘/菜单入口。与块模型上 `task` 字段（单字符）配合：undefined = 非任务。
 */

interface ITaskListMarker {
  contentStartIndex: number;
  marker: string;
}

export const nextTaskListMarker = (marker: string | null): string =>
  marker === null || marker === ' ' || marker === '/' ? 'X' : ' ';

export const nextTaskListStatus = (marker: string | null): string => {
  const states = [' ', '/', 'X', '-'];
  return states[(states.indexOf(marker?.toUpperCase() ?? '') + 1) % states.length];
};

export const isTaskListMarker = (marker: string): boolean =>
  marker.length === 1 && getTaskListMarker(`[${marker}]`, false)?.marker === marker;

export const getTaskListMarker = (
  html: string,
  enableFullWidth: boolean,
): ITaskListMarker | undefined => {
  const dataTask = html
    .substring(0, 3)
    .match(
      enableFullWidth
        ? /^[\[【]([^\x80-\uffff\[\]【】])[\]】]$/
        : /^\[([^\x80-\uffff\[\]])\]$/,
    );
  if (dataTask) {
    return {
      contentStartIndex: 3,
      marker: dataTask[1],
    };
  }
  if (html.startsWith('[]') || (enableFullWidth && html.startsWith('【】'))) {
    return {
      contentStartIndex: 2,
      marker: ' ',
    };
  }
};

/** 渲染 class 映射：' '/'X'/'/'/'-' → empty/x/slash/dash（'/' 不能进 class）。 */
export const taskStatusClass = (t: string): string =>
  t === ' ' ? 'empty' : t === '/' ? 'slash' : t === '-' ? 'dash' : t.toLowerCase();
