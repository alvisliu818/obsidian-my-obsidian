/**
 * 把 modules/llm-hub/styles.css 并入根 styles.css（2026-11-24 llm-hub 并入时新增）。
 *
 * 为什么需要这一步：llm-hub 是「整仓嵌套 + 取上游已构建产物 main.js」的方式并入的
 * （见 src/main.ts 的 require 桥注释），它的样式由上游自己的构建链生成在
 * modules/llm-hub/styles.css；Obsidian 一个插件只加载一份 styles.css，所以必须并进
 * 根 styles.css，否则聊天界面、设置页、工作流面板全是裸 HTML。
 *
 * 用法（llm-hub 侧改过样式/重新 build 之后跑一次）：
 *   node scripts/merge-llm-hub-styles.mjs
 *
 * 幂等：脚本按 MARKER 切掉旧段落再追加，重复跑不会叠加。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOST_STYLES = path.join(ROOT, "styles.css");
const MODULE_STYLES = path.join(ROOT, "modules/llm-hub/styles.css");
const MARKER = "/* ==================== LLM Hub (modules/llm-hub) ==================== */";

const moduleCss = fs.readFileSync(MODULE_STYLES, "utf8");
let host = fs.readFileSync(HOST_STYLES, "utf8");

const at = host.indexOf(MARKER);
if (at !== -1) {
	host = host.slice(0, at).replace(/\s*$/, "\n");
	console.log(`[styles] 移除旧 LLM Hub 段落（原起点 ${at}）`);
}

const block = [
	MARKER,
	"/* 上游 takeshy（MIT）整仓嵌套在 modules/llm-hub，本段是它的 styles.css 原文。",
	"   不要手改这里：改 modules/llm-hub/styles.source.css 后在上游仓 npm run build，",
	"   再跑 node scripts/merge-llm-hub-styles.mjs 重新合并。 */",
	moduleCss.trim(),
	"",
].join("\n");

fs.writeFileSync(HOST_STYLES, `${host.trimEnd()}\n\n${block}`, "utf8");
console.log(
	`[styles] 已并入 LLM Hub：${moduleCss.length} 字节 → styles.css ${fs.statSync(HOST_STYLES).size} 字节`,
);
