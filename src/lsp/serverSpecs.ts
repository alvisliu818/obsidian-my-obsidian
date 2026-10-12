// 内置 LSP 预设与生效规格解析。
//
// 内置 pyright 不进 settings.lspServers（升级不丢配置），用户可用同 id 条目
// 覆盖 enabled 来禁用它。用户自定义条目按 languageId（文件扩展名小写）路由。

import type { LspServerSpec } from '../types';

/** 内置 pyright：随插件部署（dist/pyright），环境联动在 lspHost 的 kind 分支处理 */
export const BUILTIN_PYRIGHT: LspServerSpec = {
  id: 'pyright',
  languages: ['python', 'py'],
  launch: 'node',
  command: 'pyright/dist/pyright-langserver.js',
  args: ['--stdio'],
  enabled: true,
  builtin: true,
};

/** 合并内置预设与用户配置：内置条目的 enabled 可被用户同 id 条目覆盖 */
export function effectiveLspServers(userServers: LspServerSpec[] | undefined): LspServerSpec[] {
  const list = Array.isArray(userServers) ? userServers : [];
  const overrides = new Map(list.map((s) => [s.id, s]));
  const builtin = { ...BUILTIN_PYRIGHT, enabled: overrides.get(BUILTIN_PYRIGHT.id)?.enabled ?? BUILTIN_PYRIGHT.enabled };
  return [builtin, ...list.filter((s) => !s.builtin && s.id !== BUILTIN_PYRIGHT.id)];
}

/** 按 languageId（扩展名）路由到启用的服务器；无匹配返回 null */
export function resolveLspSpec(languageId: string, userServers: LspServerSpec[] | undefined): LspServerSpec | null {
  const lid = (languageId || '').trim().toLowerCase();
  if (!lid) return null;
  return (
    effectiveLspServers(userServers).find((s) => s.enabled && s.languages.some((l) => l.trim().toLowerCase() === lid)) ?? null
  );
}
