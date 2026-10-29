// @vitest-environment jsdom
// 块框选手势骨架:合成鼠标事件驱动状态机(思源 blockDragSelectionGesture
// 行为口径——未激活不认单块/Esc 取消/尾随 click 抑制/修饰键不启动)。
import { beforeEach, describe, expect, it } from 'vitest';
import { bindBlockDragSelect, type BlockDragSelectHit } from './blockDragSelect';
import type { Block } from '../types';

function mkBlock(text: string): Block {
  return { kind: 'list', marker: null, text, props: {}, children: [], parent: null };
}

/** 绑定容器(describe 内赋值;hit 把命中元素挂进去过存活校验)。 */
let el: HTMLElement;

function hit(b: Block): BlockDragSelectHit {
  // el 必须挂在**绑定容器内**:手势每次 update 都做存活校验(element.contains(el))
  const div = document.createElement('div');
  el.appendChild(div);
  return { block: b, el: div };
}

describe('bindBlockDragSelect(框选手势骨架)', () => {
  let a: Block, b: Block, c: Block;
  let canStart: boolean;
  let selectCalls: Array<[Block, Block]>;
  let finishCalls: boolean[];
  let startHit: BlockDragSelectHit | null;
  let pointHit: BlockDragSelectHit | null;
  let unbind: () => void;

  const down = (target: HTMLElement, mods: Partial<MouseEventInit> = {}) => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...mods }));
  };
  const move = (x: number, y: number, buttons = 1) => {
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons }));
  };
  const up = () => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  };

  beforeEach(() => {
    a = mkBlock('a');
    b = mkBlock('b');
    c = mkBlock('c');
    canStart = true;
    selectCalls = [];
    finishCalls = [];
    startHit = null;
    pointHit = null;
    el = document.createElement('div');
    document.body.appendChild(el);
    const inner = document.createElement('div');
    el.appendChild(inner);
    startHit = hit(a);
    unbind = bindBlockDragSelect(el, {
      canStart: () => canStart,
      getStartBlock: () => startHit,
      getBlockAtPoint: () => pointHit,
      select: (s, e) => selectCalls.push([s, e]),
      finish: (cancelled) => finishCalls.push(cancelled),
    });
  });

  it('跨块拖动:select(start, end) 逐帧重画,松手 finish(false) + click 被抑制', () => {
    down(el.firstElementChild as HTMLElement);
    pointHit = hit(b);
    move(10, 20);
    expect(selectCalls).toEqual([[a, b]]);
    up();
    expect(finishCalls).toEqual([false]);
    // 尾随 click 被抑制(块点击链不清掉刚画好的选择)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    let stopped = false;
    click.stopImmediatePropagation = () => {
      stopped = true;
    };
    el.dispatchEvent(click);
    expect(stopped).toBe(true);
  });

  it('原地微动不激活:select/finish 都不触发', () => {
    down(el.firstElementChild as HTMLElement);
    pointHit = hit(a); // 同一块
    move(10, 20);
    expect(selectCalls).toEqual([]);
    up();
    expect(finishCalls).toEqual([]);
  });

  it('连续拖动逐帧重画:换目标再 select', () => {
    down(el.firstElementChild as HTMLElement);
    pointHit = hit(b);
    move(10, 20);
    pointHit = hit(c);
    move(10, 40);
    expect(selectCalls).toEqual([
      [a, b],
      [a, c],
    ]);
    up();
  });

  it('Esc 取消:finish(true),且取消也走 finish(调用方清选择)', () => {
    down(el.firstElementChild as HTMLElement);
    pointHit = hit(b);
    move(10, 20);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(finishCalls).toEqual([true]);
  });

  it('修饰键按下不启动手势(Shift/Ctrl 选区语义归原生)', () => {
    down(el.firstElementChild as HTMLElement, { shiftKey: true });
    pointHit = hit(b);
    move(10, 20);
    expect(selectCalls).toEqual([]);
    down(el.firstElementChild as HTMLElement, { ctrlKey: true });
    move(10, 20);
    expect(selectCalls).toEqual([]);
  });

  it('双击(detail>1)不启动', () => {
    down(el.firstElementChild as HTMLElement, { detail: 2 });
    pointHit = hit(b);
    move(10, 20);
    expect(selectCalls).toEqual([]);
  });

  it('canStart=false 不启动;激活后变 false 则取消', () => {
    canStart = false;
    down(el.firstElementChild as HTMLElement);
    pointHit = hit(b);
    move(10, 20);
    expect(selectCalls).toEqual([]);
    // 激活后 canStart 翻 false(如进入编辑态)→ 下一次移动取消
    canStart = true;
    down(el.firstElementChild as HTMLElement);
    pointHit = hit(b);
    move(10, 20);
    expect(selectCalls).toEqual([[a, b]]);
    canStart = false;
    pointHit = hit(c);
    move(10, 60);
    expect(finishCalls).toEqual([true]);
  });

  it('落点出界(null)不 select;松手前松开左键(buttons=0)按结束处理', () => {
    down(el.firstElementChild as HTMLElement);
    pointHit = null;
    move(10, 20);
    expect(selectCalls).toEqual([]);
    pointHit = hit(b);
    move(10, 20);
    expect(selectCalls).toEqual([[a, b]]);
    move(10, 30, 0); // buttons=0:左键已松
    expect(finishCalls).toEqual([false]);
  });

  it('未激活时松手不走 finish(点选语义不受影响)', () => {
    down(el.firstElementChild as HTMLElement);
    up();
    expect(finishCalls).toEqual([]);
    unbind();
  });

  it('解绑后事件不再驱动手势', () => {
    unbind();
    down(el.firstElementChild as HTMLElement);
    pointHit = hit(b);
    move(10, 20);
    up();
    expect(selectCalls).toEqual([]);
    expect(finishCalls).toEqual([]);
  });
});
