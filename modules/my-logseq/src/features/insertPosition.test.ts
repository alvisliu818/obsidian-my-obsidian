// 异步插入位置骨架:捕获/验活/恢复。块模型走查 + CM 桩,无真实 DOM。
import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import type { BlockRenderHost } from '../blocks/renderHost';
import { createBlock, type Block } from '../types';
import {
  capturePasteInsertPosition,
  isPasteInsertPositionAlive,
  restorePasteInsertPosition,
  type PasteInsertPosition,
} from './insertPosition';

function fakeView(connected = true, head = 3, docLen = 10): EditorView {
  return {
    dom: { isConnected: connected },
    state: { selection: { main: { head } }, doc: { length: docLen } },
  } as unknown as EditorView;
}

function fakeHost(fields: {
  focusedBlock?: Block | null;
  focusedView?: EditorView | null;
  visibleRoots?: Block[];
  focusBlock?: (b: Block, pos: number | string) => void;
  embedView?: EditorView | null;
}): BlockRenderHost {
  return {
    focusedBlock: fields.focusedBlock ?? null,
    focusedView: fields.focusedView ?? null,
    visibleRoots: fields.visibleRoots ?? [],
    focusBlock: fields.focusBlock ?? (() => {}),
    ...(fields.embedView ? { embedEdit: { view: fields.embedView } } : {}),
  } as unknown as BlockRenderHost;
}

describe('capturePasteInsertPosition(捕获)', () => {
  it('普通会话:焦点块 + 焦点 CM + 光标偏移', () => {
    const b = createBlock('hello');
    const v = fakeView(true, 3);
    const host = fakeHost({ focusedBlock: b, focusedView: v });
    const pos = capturePasteInsertPosition(host);
    expect(pos).toEqual({ block: b, offset: 3, view: v });
  });

  it('无焦点块(非 embed)→ null', () => {
    expect(capturePasteInsertPosition(fakeHost({ focusedView: fakeView() }))).toBeNull();
    expect(capturePasteInsertPosition(fakeHost({ focusedBlock: createBlock('x') }))).toBeNull();
  });

  it('embed 会话:显式传 embed 视图,焦点块为 null 也允许捕获', () => {
    const v = fakeView(true, 7);
    const host = fakeHost({ embedView: v });
    const pos = capturePasteInsertPosition(host, v);
    expect(pos).toEqual({ block: null, offset: 7, view: v });
  });
});

describe('isPasteInsertPositionAlive(验活)', () => {
  const roots = [createBlock('a'), createBlock('b')];
  (roots[0] as Block).children.push(createBlock('a1'));

  it('块在树中且 CM 连着 → true', () => {
    const pos: PasteInsertPosition = { block: roots[0].children[0], offset: 0, view: fakeView(true) };
    expect(isPasteInsertPositionAlive(fakeHost({ visibleRoots: roots }), pos)).toBe(true);
  });

  it('块被重建掉(不在树中)→ false', () => {
    const stale = createBlock('replaced');
    const pos: PasteInsertPosition = { block: stale, offset: 0, view: fakeView(true) };
    expect(isPasteInsertPositionAlive(fakeHost({ visibleRoots: roots }), pos)).toBe(false);
  });

  it('CM 已被 blur 提交链卸载(未连 DOM)→ false', () => {
    const pos: PasteInsertPosition = { block: roots[0], offset: 0, view: fakeView(false) };
    expect(isPasteInsertPositionAlive(fakeHost({ visibleRoots: roots }), pos)).toBe(false);
  });

  it('embed 会话(block null):只看 CM 连通性', () => {
    const pos: PasteInsertPosition = { block: null, offset: 0, view: fakeView(true) };
    expect(isPasteInsertPositionAlive(fakeHost({ visibleRoots: [] }), pos)).toBe(true);
    const dead: PasteInsertPosition = { block: null, offset: 0, view: fakeView(false) };
    expect(isPasteInsertPositionAlive(fakeHost({ visibleRoots: [] }), dead)).toBe(false);
  });
});

describe('restorePasteInsertPosition(恢复)', () => {
  it('验活通过:焦点落回捕获块,偏移钳到当前文档长度', () => {
    const b = createBlock('text');
    const focusBlock = vi.fn();
    const host = fakeHost({ visibleRoots: [b], focusBlock });
    const pos: PasteInsertPosition = { block: b, offset: 99, view: fakeView(true, 0, 10) };
    expect(restorePasteInsertPosition(host, pos)).toBe(true);
    expect(focusBlock).toHaveBeenCalledWith(b, 10);
  });

  it('验活失败:false,不动焦点', () => {
    const focusBlock = vi.fn();
    const host = fakeHost({ visibleRoots: [], focusBlock });
    const pos: PasteInsertPosition = { block: createBlock('x'), offset: 0, view: fakeView(true) };
    expect(restorePasteInsertPosition(host, pos)).toBe(false);
    expect(focusBlock).not.toHaveBeenCalled();
  });

  it('embed 会话(block null):恢复不支持', () => {
    const pos: PasteInsertPosition = { block: null, offset: 0, view: fakeView(true) };
    expect(restorePasteInsertPosition(fakeHost({ visibleRoots: [] }), pos)).toBe(false);
  });
});
