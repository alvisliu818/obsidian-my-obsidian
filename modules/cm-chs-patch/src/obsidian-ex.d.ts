export {};

declare global {
  declare const __JIEBA_VERSION__: string;
  declare const __JIEBA_WASM_SHA256__: string;
  // 聚合仓适配：构建期内嵌的 jieba wasm（base64），见 wasm-cache.ts
  declare const __JIEBA_WASM_B64__: string;
  declare var CodeMirrorAdapter:
    | { Vim: import("./vim-types").VimApi }
    | undefined;
  declare var CodeMirror: typeof import("chsp-codemirror5");
}
