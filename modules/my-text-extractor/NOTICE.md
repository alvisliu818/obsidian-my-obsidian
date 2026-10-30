# NOTICE — my-text-extractor

- **上游**：Text Extractor v0.7.0（Simon Cambier / scambier，GPL-3.0，见本
  目录 `LICENSE`）https://github.com/scambier/obsidian-text-extractor
  本目录的快照为 **v0.7.0 源码 + 一组本地增强**（右键菜单提取/提取到新笔记/
  系统原生 OCR 开关/缓存位置 centralized|adjacent——原版 0.7.0 无这些，快照
  来自用户本地维护的 fork，manifest 版本号未变）。`lib/` 是其配套核心库
  `obsidian-text-extract`（Rust→wasm 的 PDF 提取 + tesseract.js OCR 的
  rollup 打包产物，wasm 已 base64 内嵌在 `lib/dist/index.js`，无 sidecar）。
- **收编方式**：源码快照（本地 `E:\HOME\Code\obsidian\obsidian-text-extractor`，
  无 git 历史）。收编时上游 git 仓库网络不可达，**未能按 git subtree 拼接
  上游提交历史**——版本与出处以本文件与上游 CHANGELOG 为准。
- **功能**：给 Omnisearch 提供图片 OCR / PDF / Office 文本提取
  （`Omnisearch → getTextExtractor`），另有右键菜单与两条提取命令。
- **构建**：`plugin/src/main.ts` 由宿主根 esbuild 直接打包；
  `obsidian-text-extract` 以根 package.json 的
  `"obsidian-text-extract": "file:modules/my-text-extractor/lib"` 落进依赖
  （打包 `lib/dist`，无 wasm sidecar）。`LangSelector.svelte` 是 svelte 3
  class 组件，由 esbuild.mjs 里模块级的 esbuild-svelte（createRequire 自
  `plugin/` 下嵌套 node_modules，含 svelte@3 + esbuild-svelte@0.7.4 +
  svelte-preprocess@5 + svelte-multiselect@8）编译——momentum 的 svelte@4
  同款先例。根 svelte@5 不动。
- **对上游源码的修改**：`LangSelector.svelte` 的 `import ... from
  'src/settings'` 改为相对路径 `../settings`——上游 baseUrl 约定与宿主
  tsconfig 的 `src/*` 别名（指向 my-obsidian-git）冲突，esbuild 按 tsconfig
  paths 解析会错拿。另加 `plugin/src/svelte-shims.d.ts`（tsc 的 .svelte
  导入垫片）。
- **数据迁移**：独立版设置（`ocrLanguages/rightClickMenu/useSystemOCR/
  cacheLocation`）由宿主 `migrateFrom` 一次性导入（读
  `.obsidian/plugins/text-extractor/data.json`，仅当模块数据片为空）。
  提取缓存按 cacheLocation 落盘/IndexedDB，旧缓存不迁移（与上游改设置时
  的语义一致，缺了会按需重提取）。
- **宿主注册**：模块 id `text-extractor`，插件表别名 `my-text-extractor`
  （manifest.id 覆盖为同值、version 覆盖 0.7.0——PluginSettingTab 按
  manifest.id 建键，不覆盖会与宿主设置页撞车）。Omnisearch 的提取查找已
  指向该别名。
