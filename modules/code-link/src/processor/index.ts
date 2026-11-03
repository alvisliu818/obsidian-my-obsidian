import { MarkdownPostProcessor } from "obsidian";
import CodeLinkPlugin from "../main";

export abstract class PostProcessor {
	constructor(protected _plugin: CodeLinkPlugin) {}

	abstract process: MarkdownPostProcessor;
}
