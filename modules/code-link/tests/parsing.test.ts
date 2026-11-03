import { describe, it, expect, beforeEach } from 'vitest';
import { TagTree } from '../src/lang/tree';
import * as TreeSitter from 'web-tree-sitter';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// 聚合适配（PnP）：`Parser.init()` 不带参数时会按胶水文件相对路径取
// web-tree-sitter.wasm，在 vitest（jsdom 环境）里取不到。unplugged 的
// web-tree-sitter 是实目录，exports 暴露了 ./web-tree-sitter.wasm 子路径，
// resolve 出来读成 wasmBinary 传入，取件分支被短路（同 src/lang/loader.ts
// 的运行时内嵌思路，只是测试从磁盘读）。
const nodeRequire = createRequire(import.meta.url);

describe('TagTree Parsing Tests', () => {
    let parser: TreeSitter.Parser;
    let pythonLang: TreeSitter.Language;

    // python wasm fixture：上游 .gitignore 排除 tree-sitter*，从不入库——
    // 作者本地以 TREE_SITTER_PYTHON_WASM 环境变量或 tests/fixtures 提供。
    // 显式指定 env 却找不到 = 用户意图错误，抛错；否则缺席即跳过该用例。
    const pythonWasmPath = process.env.TREE_SITTER_PYTHON_WASM
        ? path.resolve(process.cwd(), process.env.TREE_SITTER_PYTHON_WASM)
        : path.resolve(__dirname, 'fixtures', 'tree-sitter-python.wasm');
    if (process.env.TREE_SITTER_PYTHON_WASM && !fs.existsSync(pythonWasmPath)) {
        throw new Error(
            `TREE_SITTER_PYTHON_WASM is set but file not found: ${pythonWasmPath}`
        );
    }
    const hasPythonWasm = fs.existsSync(pythonWasmPath);

    beforeEach(async () => {
        const coreWasmPath = nodeRequire.resolve('web-tree-sitter/web-tree-sitter.wasm');
        await TreeSitter.Parser.init({ wasmBinary: fs.readFileSync(coreWasmPath) });
        parser = new TreeSitter.Parser();
        if (hasPythonWasm) {
            pythonLang = await TreeSitter.Language.load(pythonWasmPath);
            parser.setLanguage(pythonLang);
        }
    });

    it.runIf(hasPythonWasm)('should correctly parse python code and find tags', async () => {
        const code = `
def hello_world():
    print("hello")

class MyClass:
    def method(self):
        pass
`;
        const scm = `
(function_definition
  name: (identifier) @name) @function

(class_definition
  name: (identifier) @name) @class
`;
        const query = new TreeSitter.Query(pythonLang, scm);
        const tree = parser.parse(code);
        if (!tree) throw new Error('Failed to parse');
        const tagTree = new TagTree(tree, query);

        const nodes = tagTree.dfs;
        expect(nodes.length).toBe(3);
        expect(nodes.map(n => n.name)).toContain('hello_world');
        expect(nodes.map(n => n.name)).toContain('MyClass');
        expect(nodes.map(n => n.name)).toContain('method');
    });
});
