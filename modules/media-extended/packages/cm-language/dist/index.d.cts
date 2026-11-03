import { Input, Parser, TreeFragment, SyntaxNode, Tree, NodeProp, NodeType } from '@lezer/common';
import { LRParser, ParserConfig } from '@lezer/lr';
import * as _codemirror_state from '@codemirror/state';
import { Text, Facet, Extension, EditorState, StateField, Range } from '@codemirror/state';
import { EditorView, Command, BlockInfo, ViewUpdate, KeyBinding, DecorationSet, Decoration } from '@codemirror/view';
import { Highlighter, Tag } from '@lezer/highlight';
import { StyleModule, StyleSpec } from 'style-mod';

declare const languageDataProp: NodeProp<Facet<{
    [name: string]: any;
}, readonly {
    [name: string]: any;
}[]>>;
declare function defineLanguageFacet(baseData?: {
    [name: string]: any;
}): Facet<{
    [name: string]: any;
}, readonly {
    [name: string]: any;
}[]>;
interface Sublanguage {
    type?: "replace" | "extend";
    test: (node: SyntaxNode, state: EditorState) => boolean;
    facet: Facet<{
        [name: string]: any;
    }>;
}
declare const sublanguageProp: NodeProp<Sublanguage[]>;
declare class Language {
    readonly data: Facet<{
        [name: string]: any;
    }>;
    readonly name: string;
    readonly extension: Extension;
    parser: Parser;
    constructor(data: Facet<{
        [name: string]: any;
    }>, parser: Parser, extraExtensions?: Extension[], name?: string);
    isActiveAt(state: EditorState, pos: number, side?: -1 | 0 | 1): boolean;
    findRegions(state: EditorState): {
        from: number;
        to: number;
    }[];
    get allowsNesting(): boolean;
}
declare class LRLanguage extends Language {
    readonly parser: LRParser;
    private constructor();
    static define(spec: {
        name?: string;
        parser: LRParser;
        languageData?: {
            [name: string]: any;
        };
    }): LRLanguage;
    configure(options: ParserConfig, name?: string): LRLanguage;
    get allowsNesting(): boolean;
}
declare function syntaxTree(state: EditorState): Tree;
declare function ensureSyntaxTree(state: EditorState, upto: number, timeout?: number): Tree | null;
declare function syntaxTreeAvailable(state: EditorState, upto?: number): boolean;
declare function forceParsing(view: EditorView, upto?: number, timeout?: number): boolean;
declare function syntaxParserRunning(view: EditorView): boolean;
declare class DocInput implements Input {
    readonly doc: Text;
    private cursor;
    private cursorPos;
    private string;
    constructor(doc: Text);
    get length(): number;
    private syncTo;
    chunk(pos: number): string;
    get lineChunks(): boolean;
    read(from: number, to: number): string;
}
declare class ParseContext {
    private parser;
    readonly state: EditorState;
    fragments: readonly TreeFragment[];
    viewport: {
        from: number;
        to: number;
    };
    private parse;
    private constructor();
    private startParse;
    private withContext;
    private withoutTempSkipped;
    skipUntilInView(from: number, to: number): void;
    static getSkippingParser(until?: Promise<unknown>): Parser;
    static get(): ParseContext | null;
}
declare const language: Facet<Language, Language | null>;
declare class LanguageSupport {
    readonly language: Language;
    readonly support: Extension;
    extension: Extension;
    constructor(language: Language, support?: Extension);
}
declare class LanguageDescription {
    readonly name: string;
    readonly alias: readonly string[];
    readonly extensions: readonly string[];
    readonly filename: RegExp | undefined;
    private loadFunc;
    support: LanguageSupport | undefined;
    private loading;
    private constructor();
    load(): Promise<LanguageSupport>;
    static of(spec: {
        name: string;
        alias?: readonly string[];
        extensions?: readonly string[];
        filename?: RegExp;
        load?: () => Promise<LanguageSupport>;
        support?: LanguageSupport;
    }): LanguageDescription;
    static matchFilename(descs: readonly LanguageDescription[], filename: string): LanguageDescription | null;
    static matchLanguageName(descs: readonly LanguageDescription[], name: string, fuzzy?: boolean): LanguageDescription | null;
}

declare const indentService: Facet<(context: IndentContext, pos: number) => number | null | undefined, readonly ((context: IndentContext, pos: number) => number | null | undefined)[]>;
declare const indentUnit: Facet<string, string>;
declare function getIndentUnit(state: EditorState): number;
declare function indentString(state: EditorState, cols: number): string;
declare function getIndentation(context: IndentContext | EditorState, pos: number): number | null;
declare function indentRange(state: EditorState, from: number, to: number): _codemirror_state.ChangeSet;
declare class IndentContext {
    readonly state: EditorState;
    unit: number;
    constructor(state: EditorState, options?: {
        overrideIndentation?: (pos: number) => number;
        simulateBreak?: number;
        simulateDoubleBreak?: boolean;
    });
    lineAt(pos: number, bias?: -1 | 1): {
        text: string;
        from: number;
    };
    textAfterPos(pos: number, bias?: -1 | 1): string;
    column(pos: number, bias?: -1 | 1): number;
    countColumn(line: string, pos?: number): number;
    lineIndent(pos: number, bias?: -1 | 1): number;
    get simulatedBreak(): number | null;
}
declare const indentNodeProp: NodeProp<(context: TreeIndentContext) => number | null>;
declare class TreeIndentContext extends IndentContext {
    private base;
    readonly pos: number;
    private constructor();
    get node(): SyntaxNode;
    get textAfter(): string;
    get baseIndent(): number;
    baseIndentFor(node: SyntaxNode): number;
    continue(): number | null;
}
declare function delimitedIndent({ closing, align, units }: {
    closing: string;
    align?: boolean;
    units?: number;
}): (context: TreeIndentContext) => number;
declare const flatIndent: (context: TreeIndentContext) => number;
declare function continuedIndent({ except, units }?: {
    except?: RegExp;
    units?: number;
}): (context: TreeIndentContext) => number;
declare function indentOnInput(): Extension;

declare const foldService: Facet<(state: EditorState, lineStart: number, lineEnd: number) => ({
    from: number;
    to: number;
} | null), readonly ((state: EditorState, lineStart: number, lineEnd: number) => ({
    from: number;
    to: number;
} | null))[]>;
declare const foldNodeProp: NodeProp<(node: SyntaxNode, state: EditorState) => ({
    from: number;
    to: number;
} | null)>;
declare function foldInside(node: SyntaxNode): {
    from: number;
    to: number;
} | null;
declare function foldable(state: EditorState, lineStart: number, lineEnd: number): {
    from: number;
    to: number;
} | null;
type DocRange = {
    from: number;
    to: number;
};
declare const foldEffect: _codemirror_state.StateEffectType<DocRange>;
declare const unfoldEffect: _codemirror_state.StateEffectType<DocRange>;
declare const foldState: StateField<DecorationSet>;
declare function foldedRanges(state: EditorState): DecorationSet;
declare const foldCode: Command;
declare const unfoldCode: Command;
declare const foldAll: Command;
declare const unfoldAll: Command;
declare const toggleFold: Command;
declare const foldKeymap: readonly KeyBinding[];
interface FoldConfig {
    placeholderDOM?: ((view: EditorView, onclick: (event: Event) => void, prepared: any) => HTMLElement) | null;
    placeholderText?: string;
    preparePlaceholder?: (state: EditorState, range: {
        from: number;
        to: number;
    }) => any;
}
declare function codeFolding(config?: FoldConfig): Extension;
type Handlers = {
    [event: string]: (view: EditorView, line: BlockInfo, event: Event) => boolean;
};
interface FoldGutterConfig {
    markerDOM?: ((open: boolean) => HTMLElement) | null;
    openText?: string;
    closedText?: string;
    domEventHandlers?: Handlers;
    foldingChanged?: (update: ViewUpdate) => boolean;
}
declare function foldGutter(config?: FoldGutterConfig): Extension;

declare class HighlightStyle implements Highlighter {
    readonly specs: readonly TagStyle[];
    readonly module: StyleModule | null;
    readonly style: (tags: readonly Tag[]) => string | null;
    readonly scope: ((type: NodeType) => boolean) | undefined;
    private constructor();
    static define(specs: readonly TagStyle[], options?: {
        scope?: Language | NodeType;
        all?: string | StyleSpec;
        themeType?: "dark" | "light";
    }): HighlightStyle;
}
declare function syntaxHighlighting(highlighter: Highlighter, options?: {
    fallback: boolean;
}): Extension;
declare function highlightingFor(state: EditorState, tags: readonly Tag[], scope?: NodeType): string | null;
interface TagStyle {
    tag: Tag | readonly Tag[];
    class?: string;
    [styleProperty: string]: any;
}
declare const defaultHighlightStyle: HighlightStyle;

interface Config {
    afterCursor?: boolean;
    brackets?: string;
    maxScanDistance?: number;
    renderMatch?: (match: MatchResult, state: EditorState) => readonly Range<Decoration>[];
}
declare function bracketMatching(config?: Config): Extension;
declare const bracketMatchingHandle: NodeProp<(node: SyntaxNode) => SyntaxNode | null>;
interface MatchResult {
    start: {
        from: number;
        to: number;
    };
    end?: {
        from: number;
        to: number;
    };
    matched: boolean;
}
declare function matchBrackets(state: EditorState, pos: number, dir: -1 | 1, config?: Config): MatchResult | null;

declare class StringStream {
    string: string;
    private tabSize;
    indentUnit: number;
    lookAhead: (n: number) => string;
    private overrideIndent?;
    pos: number;
    start: number;
    private lastColumnPos;
    private lastColumnValue;
    constructor(string: string, tabSize: number, indentUnit: number, lookAhead: (n: number) => string, overrideIndent?: number | undefined);
    eol(): boolean;
    sol(): boolean;
    peek(): string | undefined;
    next(): string | void;
    eat(match: string | RegExp | ((ch: string) => boolean)): string | void;
    eatWhile(match: string | RegExp | ((ch: string) => boolean)): boolean;
    eatSpace(): boolean;
    skipToEnd(): void;
    skipTo(ch: string): boolean | void;
    backUp(n: number): void;
    column(): number;
    indentation(): number;
    match(pattern: string | RegExp, consume?: boolean, caseInsensitive?: boolean): boolean | RegExpMatchArray | null;
    current(): string;
}

interface StreamParser<State> {
    name?: string;
    startState?(indentUnit: number): State;
    token(stream: StringStream, state: State): string | null;
    blankLine?(state: State, indentUnit: number): string | null;
    copyState?(state: State): State;
    indent?(state: State, textAfter: string, context: IndentContext): number | null;
    languageData?: {
        [name: string]: any;
    };
}
declare class StreamLanguage<State> extends Language {
    private constructor();
    static define<State>(spec: StreamParser<State>): StreamLanguage<State>;
    private getIndent;
    get allowsNesting(): boolean;
}
declare const tokenClassNodeProp: NodeProp<string>;
declare const lineClassNodeProp: NodeProp<string>;
declare const lineHighlighter: _codemirror_state.Extension;
declare const ignoreSpellcheckToken: Facet<string, string[]>;

declare function bidiIsolates(options?: {
    alwaysIsolate?: boolean;
}): Extension;

export { DocInput, HighlightStyle, IndentContext, LRLanguage, Language, LanguageDescription, LanguageSupport, ParseContext, StreamLanguage, StringStream, TreeIndentContext, bidiIsolates, bracketMatching, bracketMatchingHandle, codeFolding, continuedIndent, defaultHighlightStyle, defineLanguageFacet, delimitedIndent, ensureSyntaxTree, flatIndent, foldAll, foldCode, foldEffect, foldGutter, foldInside, foldKeymap, foldNodeProp, foldService, foldState, foldable, foldedRanges, forceParsing, getIndentUnit, getIndentation, highlightingFor, ignoreSpellcheckToken, indentNodeProp, indentOnInput, indentRange, indentService, indentString, indentUnit, language, languageDataProp, lineClassNodeProp, lineHighlighter, matchBrackets, sublanguageProp, syntaxHighlighting, syntaxParserRunning, syntaxTree, syntaxTreeAvailable, toggleFold, tokenClassNodeProp, unfoldAll, unfoldCode, unfoldEffect };
export type { Config, MatchResult, StreamParser, Sublanguage, TagStyle };
