/**
 * 正则表达式模式常量
 */

export const REGEX_PATTERNS = {
	// 匹配 Markdown 链接 [text](url)
	MARKDOWN_LINK: /\[([^\]]+)\]\(([^)]+)\)/g,
	// 匹配 Markdown 图片 ![alt](url)
	MARKDOWN_IMAGE: /!\[([^\]]*)\]\(([^)]+)\)/g,
	// 匹配标签 #tag
	TAG: /#([\w-]+)/g,
	// 匹配 Wiki 链接 [[link]]
	WIKI_LINK: /\[\[([^\]]+)\]\]/g,
} as const;

