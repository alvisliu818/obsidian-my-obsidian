export type PluginLanguage = 'auto' | 'zh-CN' | 'en';
export type ResolvedLanguage = 'zh-CN' | 'en';

export function resolvePluginLanguage(
	language: PluginLanguage,
	obsidianLocale: string,
): ResolvedLanguage {
	if (language !== 'auto') return language;
	return obsidianLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
