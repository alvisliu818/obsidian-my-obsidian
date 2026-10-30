# NOTICE — my-cm-chs-patch

- **上游**：cm-chs-patch v1.14.0（AidenLx，MIT，见本目录 `LICENSE`）
  https://github.com/AidenLx/cm-chs-patch
- **收编方式**：源码快照（upstream tag `1.14.0` tarball）。因收编时上游
  git 仓库网络不可达（github.com 直连超时，仅 codeload/api 通），**未能按
  git subtree 拼接上游提交历史**——与本仓其他 subtree 收编的模块不同，
  `git log --follow` 到不了上游。版本与出处以本文件与上游 CHANGELOG 为准。
- **功能**：Obsidian 编辑器中文分词（双击选词/w word 动词/拼音模式切换），
  并作为 Omnisearch 的分词软依赖（`Omnisearch → getChsSegmenter`）。
- **构建**：不跑上游 vite 管线；`src/` 由宿主根 esbuild 直接打包
  （`@codemirror/*` external、`jieba-wasm/web` 与 `idb` 走根依赖）。
  上游 `patches/jieba-wasm@2.4.0.patch`（去掉 wasm 胶水里的隐式
  `new URL(..., import.meta.url)`，防打包器内联 wasm 资产）移植为根
  esbuild.mjs 的 `jiebaPatchPlugin`（onLoad 文本替换，与 dexie-patch 同款）。
- **对上游源码的修改（功能性）**：
  1. `src/wasm-cache.ts`：IndexedDB 无用户导入的 jieba 组件时，回落到构建
     期内嵌的 wasm（根 esbuild 以 `__JIEBA_WASM_B64__` 注入，版本哈希与
     `__JIEBA_WASM_SHA256__` 同源）。上游需要用户手动下载导入组件，聚合后
     装上即用；手动导入路径保留且优先级不变。
  2. `src/obsidian-ex.d.ts`：补 `__JIEBA_WASM_B64__` 全局声明。
  3. `__JIEBA_VERSION__` / `__JIEBA_WASM_SHA256__` 两个 vite define 由根
     esbuild 等价提供（读 `jieba-wasm` 包版本 + 对 wasm 文件做 sha256）。
- **数据迁移**：独立版的数据（`useJieba/hmm/dict`）由宿主 `migrateFrom`
  一次性导入（读 `.obsidian/plugins/cm-chs-patch/data.json`，仅当模块数据
  片为空）。jieba wasm 本体存 IndexedDB（库名固定
  `cm-chs-patch-jieba`），跨插件实例自动复用，无需迁移。
- **宿主注册**：模块 id `chs-patch`，插件表别名 `my-cm-chs-patch`
  （manifest.id 覆盖为同值——PluginSettingTab 按 manifest.id 建键，不覆盖
  会与宿主设置页撞车）。Omnisearch 的分词查找已指向该别名。
