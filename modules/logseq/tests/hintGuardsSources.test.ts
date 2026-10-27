/**
 * wikiLink/tag 源挂守卫后的行为钉子（假 CompletionContext，2026-10-26）：
 * 守卫不得误伤正常触发（e2e S6 的 CM 激活时序与源逻辑无关，源级在这里验）。
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { blockRefSource, tagSource, wikiLinkSource } from '../src/features/links';
import type { BlockRenderHost } from '../src/blocks/renderHost';

/** 假 CompletionContext：只实现源用到面（matchBefore/state/sliceDoc/pos）。 */
function ctxOf(text: string, pos = text.length): CompletionContext {
  const state = EditorState.create({ doc: text });
  return {
    state,
    pos,
    matchBefore(re: RegExp): { from: number; to: number; text: string } | null {
      const prefix = state.sliceDoc(0, pos);
      const m = re.exec(prefix);
      if (!m) return null;
      return { from: m.index, to: pos, text: m[0] };
    },
  } as unknown as CompletionContext;
}

const hostStub = {
  app: { vault: { getMarkdownFiles: () => [{ basename: 'absolutely', path: 'absolutely.md' }] } },
  plugin: { blockIndex: { allTags: () => ['e2etag'], withIds: () => [{ text: 'abc block', blockId: 'abc123', path: 'p.md' }] } },
} as unknown as BlockRenderHost;

describe('wikiLinkSource 挂守卫后', () => {
  it('normal [[ still returns options', () => {
    const src = wikiLinkSource(hostStub);
    // CompletionSource may return a Promise — this source is sync, narrow it.
    const r = src(ctxOf('see [[ab', 8)) as CompletionResult | null;
    expect(r).not.toBeNull();
    expect(r!.from).toBe(6);
  });

  it('inside inline code returns null', () => {
    const src = wikiLinkSource(hostStub);
    expect(src(ctxOf('x `[[ab` y', 7))).toBeNull();
  });

  it('leading-space query is rejected (思源 isBlockHintQueryAtCaret)', () => {
    const src = wikiLinkSource(hostStub);
    expect(src(ctxOf('[[ foo', 6))).toBeNull();
  });
});

describe('tagSource 挂守卫后', () => {
  it('normal #tag still returns options', () => {
    const src = tagSource(hostStub);
    const r = src(ctxOf('a #e2e', 6));
    expect(r).not.toBeNull();
  });

  it('inside a heading prefix returns null (issue 7933)', () => {
    const src = tagSource(hostStub);
    expect(src(ctxOf('## head', 2))).toBeNull();
  });

  it('yields to an unfinished block hint', () => {
    const src = tagSource(hostStub);
    expect(src(ctxOf('see [[que#', 10))).toBeNull();
  });
});

describe('blockRefSource 挂守卫后', () => {
  it('normal (( still returns options', () => {
    const src = blockRefSource(hostStub);
    const r = src(ctxOf('see ((ab', 8));
    expect(r).not.toBeNull();
  });

  it('inside inline code returns null', () => {
    const src = blockRefSource(hostStub);
    expect(src(ctxOf('x `((ab` y', 7))).toBeNull();
  });
});
