import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
	js.configs.recommended,
	{
		ignores: [
			"node_modules/**",
			"dist/**",
			"references/**",
			"scripts/**",
			"esbuild.config.mjs",
			"eslint.config.mjs",
			"version-bump.mjs",
			"versions.json",
			"package.json",
			"main.js",
		],
	},
	{
		files: ["main.ts", "src/**/*.ts", "src/**/*.tsx"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				Buffer: "readonly",
				global: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.mjs",
						"manifest.json",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				sourceType: "module",
				ecmaVersion: 2022,
			},
		},
		rules: {
			// TypeScript ESLint 规则
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					args: "none",
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/require-await": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/await-thenable": "error",
			"@typescript-eslint/no-base-to-string": "warn",
			"@typescript-eslint/no-this-alias": "error",
			"@typescript-eslint/no-deprecated": "warn",

			// 通用 ESLint 规则
			"no-console": ["error", { allow: ["warn", "error", "debug"] }],
			"no-case-declarations": "error",
			"no-constant-condition": "error",
			"prefer-const": "error",
			"no-var": "error",
			"no-undef": "off", // Buffer 通过 polyfill 提供
			"sort-imports": [
				"warn",
				{
					ignoreCase: true,
					ignoreDeclarationSort: true,
					ignoreMemberSort: false,
					memberSyntaxSortOrder: ["none", "all", "multiple", "single"],
				},
			],
		},
	},
	...obsidianmd.configs.recommended,
	// 为需要放宽类型安全检查的文件合并规则
	// 这些文件涉及 Node.js API 和第三方库的类型问题，类型安全警告是不可避免的
	{
		files: [
			"src/utils/polyfills/buffer.ts",
			"src/utils/audio/metadata.ts",
			"src/utils/library/coverFinder.ts",
			"src/utils/library/updater.ts",
			"src/services/LibraryService.ts",
			"src/services/ListenerService.ts",
			"src/services/ListService.ts",
		],
		rules: {
			"import/no-nodejs-modules": "off",
			// npm 包 `buffer` 与 Node 内置同名；此处仅为浏览器 polyfill，非桌面 Node API
			"obsidianmd/no-nodejs-modules": "off",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
		},
	},
);