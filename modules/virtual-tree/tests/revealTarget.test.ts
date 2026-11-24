/**
 * 定位多候选选择（2026-11-24 用户：优先定位已经展开文件路径的位置）。
 */
import { describe, expect, it } from 'vitest';
import { pickRevealTarget, type RevealMountState } from '../src/features/revealTarget';

const c = (mountId: string, rel: string, kind: 'vault' | 'external' = 'vault') => ({ mountId, rel, kind });
const noState = (): RevealMountState => ({ loaded: new Set(), open: new Set() });

describe('pickRevealTarget', () => {
  it('优先选父目录已加载且展开的那一份（主库 260817 场景）', () => {
    const candidates = [
      c('__vault_root__', '260817/17-尚硅谷RAG项目部署/STEP1_中间件部署总结.md'),
      c('260817', '17-尚硅谷RAG项目部署/STEP1_中间件部署总结.md', 'external'),
    ];
    const states: Record<string, RevealMountState> = {
      __vault_root__: noState(),
      '260817': {
        loaded: new Set(['', '17-尚硅谷RAG项目部署']),
        open: new Set(['', '17-尚硅谷RAG项目部署']),
      },
    };
    expect(pickRevealTarget(candidates, (id) => states[id])?.mountId).toBe('260817');
  });

  it('只有祖先展开而父目录没加载时也优先（一路点进来的那棵子树）', () => {
    const candidates = [c('vault', '260817/17/STEP1.md'), c('ext', '17/STEP1.md', 'external')];
    const ext: RevealMountState = { loaded: new Set(['', '17']), open: new Set(['', '17']) };
    expect(pickRevealTarget(candidates, (id) => (id === 'ext' ? ext : noState()))?.mountId).toBe('ext');
  });

  it('都没展开时按调用方顺序（更具体的挂载在前）兜底', () => {
    const candidates = [c('vault', '260817/17/STEP1.md'), c('ext', '17/STEP1.md', 'external')];
    expect(pickRevealTarget(candidates, () => noState())?.mountId).toBe('vault');
  });

  it('可配置为固定优先库内/库外（忽略展开状态）', () => {
    const candidates = [c('vault', '260817/17/STEP1.md'), c('ext', '17/STEP1.md', 'external')];
    const extOnly: Record<string, ReturnType<typeof noState>> = {
      vault: noState(),
      ext: { loaded: new Set(['', '17']), open: new Set(['', '17']) },
    };
    expect(pickRevealTarget(candidates, (id) => extOnly[id], 'expanded')?.mountId).toBe('ext');
    expect(pickRevealTarget(candidates, (id) => extOnly[id], 'vault')?.mountId).toBe('vault');
    expect(pickRevealTarget(candidates, (id) => extOnly[id], 'external')?.mountId).toBe('ext');
  });

  it('两份都展开时保持原顺序；空候选返回 undefined', () => {
    const candidates = [c('vault', 'a/b.md'), c('ext', 'b.md', 'external')];
    const both: RevealMountState = { loaded: new Set(['a', '']), open: new Set(['a', '']) };
    expect(pickRevealTarget(candidates, () => both)?.mountId).toBe('vault');
    expect(pickRevealTarget([], () => both)).toBeUndefined();
  });
});
