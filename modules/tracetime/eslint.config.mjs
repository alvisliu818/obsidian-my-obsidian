import tsparser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		ignores: [
			"node_modules/**",
			"build/**",
			"dist/**",
			"test/**",
			"test-vault/**",
			"*.mjs",
		],
	},
	...obsidianmd.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
		rules: {
			// UI 文案为中文，sentence-case 规则不适用
			"obsidianmd/ui/sentence-case": "off",
			// minAppVersion 1.5.0，必须使用 display()
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
]);
