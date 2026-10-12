/**
 * Code editor for a file INSIDE the vault.
 *
 * Obsidian has no view for `.py`, `.sh`, `.rs`, … — opening one lands on the
 * "empty" placeholder, and the only way to run it was to leave the app. This
 * view owns those extensions: CodeMirror for editing (the same substrate the
 * block editor uses), vault read/write for saving, and a ▶ Run button that
 * dispatches on the extension.
 *
 * Markdown is deliberately NOT here — notes must keep opening in the editors
 * the user chose for them.
 */
import { Notice, TFile, TextFileView, WorkspaceLeaf } from "obsidian";
import { EditorState, type Extension } from "cm-bundle:@codemirror/state";
import {
	EditorView,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
	type KeyBinding,
} from "cm-bundle:@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "cm-bundle:@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "cm-bundle:@codemirror/search";
import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
} from "cm-bundle:@codemirror/autocomplete";
import {
	HighlightStyle,
	StreamLanguage,
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	indentUnit,
	syntaxHighlighting,
} from "cm-bundle:@codemirror/language";
import { tags as t } from "cm-bundle:@lezer/highlight";
import { javascript } from "cm-bundle:@codemirror/lang-javascript";
import { html as htmlLang } from "cm-bundle:@codemirror/lang-html";
import { css as cssLang } from "cm-bundle:@codemirror/lang-css";
import { cpp, csharp, dart, java, kotlin, scala } from "cm-bundle:@codemirror/legacy-modes/mode/clike";
import { erlang } from "cm-bundle:@codemirror/legacy-modes/mode/erlang";
import { go } from "cm-bundle:@codemirror/legacy-modes/mode/go";
import { haskell } from "cm-bundle:@codemirror/legacy-modes/mode/haskell";
import { julia } from "cm-bundle:@codemirror/legacy-modes/mode/julia";
import { lua } from "cm-bundle:@codemirror/legacy-modes/mode/lua";
import { perl } from "cm-bundle:@codemirror/legacy-modes/mode/perl";
import { powerShell } from "cm-bundle:@codemirror/legacy-modes/mode/powershell";
import { properties } from "cm-bundle:@codemirror/legacy-modes/mode/properties";
import { python } from "cm-bundle:@codemirror/legacy-modes/mode/python";
import { r } from "cm-bundle:@codemirror/legacy-modes/mode/r";
import { ruby } from "cm-bundle:@codemirror/legacy-modes/mode/ruby";
import { rust } from "cm-bundle:@codemirror/legacy-modes/mode/rust";
import { shell } from "cm-bundle:@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "cm-bundle:@codemirror/legacy-modes/mode/sql";
import { swift } from "cm-bundle:@codemirror/legacy-modes/mode/swift";
import { toml } from "cm-bundle:@codemirror/legacy-modes/mode/toml";
import { xml } from "cm-bundle:@codemirror/legacy-modes/mode/xml";
import { yaml } from "cm-bundle:@codemirror/legacy-modes/mode/yaml";
import { runFile, langFromExt } from "../modules/logseq/src/exec/runner";
import type { RunHandle } from "../modules/logseq/src/exec/pythonRunner";

export const VIEW_TYPE_CODE_FILE = "lgp-code-file";

/**
 * Extensions this view takes over.
 *
 * Editable in the settings — the point of this list is that Obsidian has no
 * view for these files at all, so claiming them costs nothing; but a user who
 * wants `.json` handled elsewhere can drop it. Markdown is never included.
 */
export const DEFAULT_CODE_EXTENSIONS = [
	"py", "js", "mjs", "cjs", "jsx", "ts", "tsx",
	"sh", "bash", "zsh", "ps1", "bat", "cmd",
	"rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "rb", "lua", "pl", "r",
	"jl", "swift", "kt", "scala", "dart", "erl", "hs",
	"sql", "css", "scss", "less", "html", "xml", "yaml", "yml", "toml", "ini",
];





/**
 * Colours for the language modes.
 *
 * Tokens get CM's own ͼNNN classes, but nothing paints them unless a highlight
 * style is registered. `defaultHighlightStyle` was measured NOT to reach the
 * DOM here (its rules live in a style module that never gets inserted), so the
 * style is defined locally — same approach as logseq's own code view. Colours
 * come from Obsidian's CSS vars so the view follows the active theme.
 */
const highlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: "var(--code-accent, #c792ea)" },
	{ tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "var(--text-normal)" },
	{ tag: [t.function(t.variableName), t.labelName], color: "var(--color-blue, #82aaff)" },
	{ tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--color-orange, #ffcb6b)" },
	{ tag: [t.definition(t.name), t.separator], color: "var(--text-normal)" },
	{
		tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace],
		color: "var(--color-cyan, #f78c6c)",
	},
	{
		tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
		color: "var(--text-muted)",
	},
	{ tag: [t.string, t.inserted], color: "var(--color-green, #c3e88d)" },
	{ tag: t.comment, color: "var(--text-faint)", fontStyle: "italic" },
	{ tag: [t.bool, t.null], color: "var(--color-orange, #ffcb6b)" },
	{ tag: t.variableName, color: "var(--text-normal)" },
	{ tag: t.invalid, color: "var(--text-error)" },
]);

/** ext -> CodeMirror language support. */
function languageFor(ext: string): Extension[] {
	switch (ext) {
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
		case "ts":
		case "tsx":
			return [javascript({ typescript: ext.startsWith("ts"), jsx: ext.endsWith("x") })];
		case "html":
			return [htmlLang()];
		case "css":
		case "scss":
		case "less":
			return [cssLang()];
		case "py":
			return [StreamLanguage.define(python)];
		case "sh":
		case "bash":
		case "zsh":
			return [StreamLanguage.define(shell)];
		case "ps1":
			return [StreamLanguage.define(powerShell)];
		case "rs":
			return [StreamLanguage.define(rust)];
		case "go":
			return [StreamLanguage.define(go)];
		case "java":
			return [StreamLanguage.define(java)];
		case "c":
		case "h":
		case "cpp":
		case "hpp":
			return [StreamLanguage.define(cpp)];
		case "cs":
			return [StreamLanguage.define(csharp)];
		case "rb":
			return [StreamLanguage.define(ruby)];
		case "lua":
			return [StreamLanguage.define(lua)];
		case "pl":
			return [StreamLanguage.define(perl)];
		case "r":
			return [StreamLanguage.define(r)];
		case "swift":
			return [StreamLanguage.define(swift)];
		case "kt":
			return [StreamLanguage.define(kotlin)];
		case "scala":
			return [StreamLanguage.define(scala)];
		case "dart":
			return [StreamLanguage.define(dart)];
		case "erl":
			return [StreamLanguage.define(erlang)];
		case "hs":
			return [StreamLanguage.define(haskell)];
		case "jl":
			return [StreamLanguage.define(julia)];
		case "sql":
			return [StreamLanguage.define(standardSQL)];
		case "xml":
			return [StreamLanguage.define(xml)];
		case "yaml":
		case "yml":
			return [StreamLanguage.define(yaml)];
		case "toml":
			return [StreamLanguage.define(toml)];
		case "ini":
			return [StreamLanguage.define(properties)];
		default:
			// Extensions we claim but have no mode for (bat/cmd — legacy-modes
			// has no DOS batch parser) stay editable and uncoloured. The list in
			// DEFAULT_CODE_EXTENSIONS is the promise; keep the two in sync.
			return [];
	}
}

export class CodeFileView extends TextFileView {
	editor: EditorView | null = null;
	private hostEl: HTMLElement | null = null;
	private barEl: HTMLElement | null = null;
	private outEl: HTMLPreElement | null = null;
	private runHandle: RunHandle | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CODE_FILE;
	}

	getIcon(): string {
		return "file-code";
	}

	getDisplayText(): string {
		return this.file?.name ?? "代码文件";
	}

	// ------------------------------------------------------------------
	// TextFileView contract
	// ------------------------------------------------------------------

	getViewData(): string {
		return this.editor?.state.doc.toString() ?? "";
	}

	setViewData(data: string, _clear: boolean): void {
		this.buildEditor(data);
	}

	clear(): void {
		this.buildEditor("");
	}

	async onOpen(): Promise<void> {
		// Content arrives through setViewData (TextFileView calls it once the
		// file is loaded), so nothing to build here.
	}

	async onClose(): Promise<void> {
		this.runHandle?.interrupt();
		this.runHandle = null;
		this.editor?.destroy();
		this.editor = null;
	}

	// ------------------------------------------------------------------

	private buildEditor(data: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("lgp-code-file-view");

		this.barEl = contentEl.createDiv({ cls: "lgp-code-file-bar" });
		this.barEl.createSpan({ cls: "lgp-code-file-name", text: this.file?.name ?? "" });

		const lang = langFromExt(this.file?.name ?? "");
		if (lang) {
			const runBtn = this.barEl.createEl("button", { cls: "lgp-code-file-run", text: "▶ 运行" });
			runBtn.setAttribute("title", `运行 ${this.file?.name ?? ""}（先保存）`);
			runBtn.addEventListener("click", () => void this.runCurrentFile());
			const stopBtn = this.barEl.createEl("button", { cls: "lgp-code-file-run", text: "■ 停止" });
			stopBtn.addEventListener("click", () => {
				this.runHandle?.interrupt();
				this.runHandle = null;
			});
		}

		this.hostEl = contentEl.createDiv({ cls: "lgp-code-file-host" });
		const ext = (this.file?.extension ?? "").toLowerCase();

		this.editor = new EditorView({
			state: EditorState.create({
				doc: data,
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightSpecialChars(),
					history(),
					foldGutter(),
					drawSelection(),
					dropCursor(),
					EditorState.allowMultipleSelections.of(true),
					indentOnInput(),
					indentUnit.of("  "),
					bracketMatching(),
					closeBrackets(),
					autocompletion(),
					rectangularSelection(),
					highlightActiveLine(),
					highlightSelectionMatches(),
					search(),
					syntaxHighlighting(highlightStyle, { fallback: true }),
					
					EditorView.lineWrapping,
					// The ambient declarations type these keymaps as unknown[];
					// the runtime values are KeyBinding[] (same workaround the
					// logseq editor uses).
					keymap.of([
						{ key: "Mod-s", run: () => { void this.save(); return true; } },
						...closeBracketsKeymap,
						...defaultKeymap,
						...searchKeymap,
						...historyKeymap,
						...foldKeymap,
						...completionKeymap,
						indentWithTab,
					] as readonly KeyBinding[]),
					...languageFor(ext),

				],
			}),
			parent: this.hostEl,
		});

		this.outEl = contentEl.createEl("pre", { cls: "lgp-code-file-output" });
		this.outEl.style.display = "none";
	}

	/** Write the buffer back, then run the file by its extension. */
	async runCurrentFile(): Promise<void> {
		const file = this.file;
		if (!file) return;
		const lang = langFromExt(file.name);
		if (!lang) {
			new Notice(`${file.name} 不是可运行的类型（py / js / sh …）`);
			return;
		}
		// The interpreter reads the file from disk, so save first — otherwise
		// it runs the version before your last edit.
		await this.save();

		const abs = this.realPath(file);
		if (!abs) {
			new Notice("拿不到文件的真实路径，无法运行");
			return;
		}
		const out = this.outEl;
		if (!out) return;
		out.textContent = "";
		out.style.display = "block";
		this.runHandle?.interrupt();
		this.runHandle = runFile(
			abs,
			lang,
			abs.replace(/[\\/][^\\/]+$/, ""),
			(chunk) => {
				out.textContent += chunk;
				out.scrollTop = out.scrollHeight;
			},
			(code) => {
				out.textContent += `\n[退出码 ${code}]\n`;
				this.runHandle = null;
			},
		);
	}

	/** `file.path` is vault-relative; the interpreter needs an OS path. */
	private realPath(file: TFile): string {
		const adapter = this.app.vault.adapter as unknown as {
			getFullPath?: (p: string) => string;
			basePath?: string;
		};
		if (typeof adapter.getFullPath === "function") {
			try {
				return adapter.getFullPath(file.path);
			} catch {
				/* fall through */
			}
		}
		const base = adapter.basePath ?? "";
		return base ? `${base.replace(/[\\/]+$/, "")}/${file.path}` : file.path;
	}

}
