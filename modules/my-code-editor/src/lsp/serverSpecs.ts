// 内置 LSP 预设与生效规格解析。
//
// 内置基于 basedpyright（pyright 的社区分支：配置更细、类型分析更全）。
// 它不进 settings.lspServers（升级不丢配置），用户可用同 id 条目覆盖
// enabled 来禁用它。用户自定义条目按 languageId（文件扩展名小写）路由。

import type { LspServerSpec } from '../types';

/** 内置 basedpyright。启动细节见 lspHost 的 resolvePyrightLaunch（带三档兜底）。 */
export const BUILTIN_BASEDPYRIGHT: LspServerSpec = {
  id: 'basedpyright',
  languages: ['python', 'py'],
  launch: 'direct',
  command: 'basedpyright-langserver',
  args: ['--stdio'],
  enabled: true,
  builtin: true,
};

/** 走 python 专属分支的 server id：内置 basedpyright + 用户自配的 pyright 变体 */
export function isPyrightLike(spec: LspServerSpec): boolean {
  return spec.id === 'basedpyright' || spec.id === 'pyright' || /pyright/i.test(spec.command);
}

/** 合并内置预设与用户配置：内置条目的 enabled 可被用户同 id 条目覆盖 */
export function effectiveLspServers(userServers: LspServerSpec[] | undefined): LspServerSpec[] {
  const list = Array.isArray(userServers) ? userServers : [];
  const overrides = new Map(list.map((s) => [s.id, s]));
  const builtin = {
    ...BUILTIN_BASEDPYRIGHT,
    enabled: overrides.get(BUILTIN_BASEDPYRIGHT.id)?.enabled ?? BUILTIN_BASEDPYRIGHT.enabled,
  };
  return [builtin, ...list.filter((s) => !s.builtin && s.id !== BUILTIN_BASEDPYRIGHT.id)];
}

/** 按 languageId（扩展名）路由到启用的服务器；无匹配返回 null */
export function resolveLspSpec(languageId: string, userServers: LspServerSpec[] | undefined): LspServerSpec | null {
  const lid = (languageId || '').trim().toLowerCase();
  if (!lid) return null;
  return (
    effectiveLspServers(userServers).find((s) => s.enabled && s.languages.some((l) => l.trim().toLowerCase() === lid)) ?? null
  );
}
