/**
 * A fence with NO language still gets a clickable language label.
 *
 * Reported bug: a plain ``` fence (no language, no prefix) under a heading —
 * e.g. `定义数据模型` in a FastAPI note — rendered a code toolbar with no
 * language target, so there was no way to open source mode and therefore no
 * way to set the language.
 *
 * The label had been gated on `lang || isMixed` in the reading view and on
 * `info.lang || info.prefix` in the code editor. Both are gone: the label is
 * the ONLY entry into source mode, and source mode is the ONLY way to set a
 * language, so "no language" must not mean "no entry point".
 *
 * These assertions are on the DECISION, extracted as a pure function so it can
 * be tested without a DOM. The wiring is covered by e2e.
 */
import { describe, expect, it } from 'vitest';
import { parseCodeFence } from '../src/blocks/codeFence';

describe('code fence language label', () => {
  it('a fence with no language and no prefix is the reported case', () => {
    // Exactly the shape from the FastAPI note: `- ``` ` then indented code.
    const text = '```\nfrom pydantic import BaseModel\n\nclass Item(BaseModel):\n    name: str\n```';
    const info = parseCodeFence(text);
    expect(info).not.toBeNull();
    expect(info!.lang).toBe('');
    expect(info!.prefix).toBe('');
    // Both gate conditions were false — this is precisely what used to hide
    // the label.
    expect(!!(info!.lang || info!.prefix)).toBe(false);
  });

  it('a tilde fence with no language is the same case', () => {
    const info = parseCodeFence('~~~\nplain\n~~~');
    expect(info).not.toBeNull();
    expect(info!.lang).toBe('');
    expect(info!.prefix).toBe('');
  });

  it('still parses a language when one is present', () => {
    const info = parseCodeFence('```python\nprint(1)\n```');
    expect(info!.lang).toBe('python');
  });

  it('trims trailing whitespace after the fence as an empty language', () => {
    const info = parseCodeFence('```   \nx = 1\n```');
    expect(info!.lang).toBe('');
    expect(info!.openLine).toBe('```   ');
  });

  it('clicking the label puts the caret right after the fence line', () => {
    // Same arithmetic the label handler uses, and the offset is valid in BOTH
    // coordinate systems here because a pure block's text starts at the fence.
    const text = '```\nx = 1\n```';
    const info = parseCodeFence(text)!;
    const openPos = (info.prefix ? info.prefix.length + 1 : 0) + info.openLine.length;
    expect(openPos).toBe(3);
    expect(text[openPos]).toBe('\n');
    const sourceDoc = `${info.openLine}\n${info.content}\n${info.fence}`;
    expect(sourceDoc[openPos]).toBe('\n');
  });

  it('a four-backtick fence with no language is also label-worthy', () => {
    const info = parseCodeFence('````\nplain\n````');
    expect(info).not.toBeNull();
    expect(info!.lang).toBe('');
    expect(info!.fence).toBe('````');
  });
});
