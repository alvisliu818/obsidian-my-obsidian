/**
 * 斜杠 LaTeX（\(…\) / \[…\]）编辑态渲染——收集器单测。
 * 纯函数：文档文本 + 可见范围 + 选区 + 跳过区 → 命中列表。
 * 覆盖：开关、光标规则（区间内退生文本）、跳过区（代码/$ 数学）、
 * 转义分隔符、跨行不渲染、多命中有序。
 */
import { describe, expect, it } from 'vitest';
import { collectSlashMath } from '../src/editor/livePreview';

const R = (from: number, to: number) => ({ from, to });

const doc = 'a \\(x\\) b \\[y\\] c `\\(z\\)` d $\\(w\\)$ e \\\\(p\\\\) f';

describe('collectSlashMath', () => {
  const full = [R(0, doc.length)];
  const noSkip: Array<{ from: number; to: number }> = [];
  const selNone: Array<{ from: number; to: number }> = [];

  it('enabled=false 时一律空', () => {
    expect(collectSlashMath(doc, full, selNone, noSkip, false)).toEqual([]);
  });

  it('基础命中：收集器不管跳过区,四个全收、按序', () => {
    const got = collectSlashMath(doc, full, selNone, noSkip, true);
    expect(got.map((m) => m.body)).toEqual(['x', 'y', 'z', 'w']);
    expect(got[0].display).toBe(false);
    expect(got[1].display).toBe(true);
  });

  it('坐标落在原始文档上（from/to 是绝对位置）', () => {
    const got = collectSlashMath(doc, full, selNone, noSkip, true);
    expect(doc.slice(got[0].from, got[0].to)).toBe('\\(x\\)');
    expect(doc.slice(got[1].from, got[1].to)).toBe('\\[y\\]');
  });

  it('光标进入区间 → 跳过（生文本留给编辑/latex-suite）', () => {
    // \(x\) 的绝对区间
    const open = doc.indexOf('\\(x\\)');
    const inside = [R(open + 1, open + 2)];
    expect(collectSlashMath(doc, full, inside, noSkip, true).map((m) => m.body)).not.toContain('x');
    // 边缘触碰（from 端）也算重叠
    const touch = [R(open, open)];
    expect(collectSlashMath(doc, full, touch, noSkip, true).map((m) => m.body)).not.toContain('x');
  });

  it('光标在区间外 → 正常渲染', () => {
    const far = [R(doc.length - 2, doc.length)];
    const got = collectSlashMath(doc, full, far, noSkip, true);
    expect(got.length).toBeGreaterThanOrEqual(2);
  });

  it('跳过区：行内代码里的 \\(z\\) 不渲染', () => {
    // `\(z\)` 行内代码的绝对区间
    const tick = doc.indexOf('`\\(z\\)`');
    const zone = [R(tick, tick + 7)];
    const got = collectSlashMath(doc, full, selNone, zone, true);
    expect(got.map((m) => m.body)).not.toContain('z');
    expect(got.map((m) => m.body)).toContain('x'); // 其余不受影响
  });

  it('跳过区：$ 数学区里的 \\(w\\) 不渲染', () => {
    const dollar = doc.indexOf('$\\(w\\)$');
    const zone = [R(dollar, dollar + 7)];
    const got = collectSlashMath(doc, full, selNone, zone, true);
    expect(got.map((m) => m.body)).not.toContain('w');
  });

  it('跳过区端点判定：to 端落在区内也跳过', () => {
    // 构造：match 的 to 恰好落在跳过区内
    const text = 'pre \\(q\\) post';
    // 跳过区覆盖 match 的右端
    const zone = [R(text.indexOf('q\\)') + 1, text.length)];
    const got = collectSlashMath(text, [R(0, text.length)], selNone, zone, true);
    expect(got.map((m) => m.body)).not.toContain('q');
  });

  it('转义分隔符 \\(（前面是双反斜杠）不识别', () => {
    // 字面文本：\\(p\\) —— 反斜杠自身被转义,不是数学分隔符
    const text = 'x \\\\(p\\\\) y';
    const got = collectSlashMath(text, [R(0, text.length)], selNone, noSkip, true);
    expect(got.map((m) => m.body)).not.toContain('p');
  });

  it('跨行 \\[…\\] 编辑态不渲染（静态面已覆盖）', () => {
    const text = 'a \\[y\nz\\] b';
    const got = collectSlashMath(text, [R(0, text.length)], selNone, noSkip, true);
    expect(got).toEqual([]);
  });

  it('可见范围外的命中不收集', () => {
    // 只给第二行的可见范围,第一行的 \(x\) 不收集
    const second = doc.indexOf('\\[y\\]');
    const got = collectSlashMath(doc, [R(second - 4, second + 8)], selNone, noSkip, true);
    expect(got.map((m) => m.body)).toEqual(['y']);
  });

  it('空 body 不产出', () => {
    const text = 'a \\(\\) b';
    const got = collectSlashMath(text, [R(0, text.length)], selNone, noSkip, true);
    expect(got).toEqual([]);
  });
});
