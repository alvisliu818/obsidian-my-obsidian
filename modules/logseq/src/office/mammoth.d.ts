/**
 * Type declaration for mammoth's pre-built browser bundle.
 *
 * The package ships no types, and we deliberately import
 * `mammoth/mammoth.browser.js` rather than the package root: the Node entry
 * (`lib/index.js`) reaches for `fs` and `path`, which a plugin bundle must not
 * do. The browser build is a self-contained browserify bundle (it even carries
 * its own JSZip), so nothing leaks out of it.
 */
declare module 'mammoth/mammoth.browser.js' {
  interface MammothMessage {
    type: string;
    message: string;
  }

  interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }

  interface MammothInput {
    arrayBuffer?: ArrayBuffer;
    buffer?: Uint8Array;
    path?: string;
  }

  interface MammothOptions {
    styleMap?: string | string[];
    includeEmbeddedStyleMap?: boolean;
    includeDefaultStyleMap?: boolean;
    convertImage?: unknown;
    ignoreEmptyParagraphs?: boolean;
    idPrefix?: string;
    transformDocument?: unknown;
  }

  const mammoth: {
    convertToHtml(input: MammothInput, options?: MammothOptions): Promise<MammothResult>;
    convertToMarkdown(input: MammothInput, options?: MammothOptions): Promise<MammothResult>;
    convert(
      input: MammothInput,
      options?: MammothOptions & { outputFormat?: string },
    ): Promise<MammothResult>;
    extractRawText(input: MammothInput): Promise<{ value: string; messages: MammothMessage[] }>;
  };

  export = mammoth;
}
