# NOTICE — modules/hearth

本模块是第三方插件 **Hearth**（ondreu）的**完整收编副本**，非本仓自有代码，
按其上游许可证（MIT，见同目录 LICENSE）原样保留并注明出处。

- 上游仓库: https://github.com/ondreu/Hearth
- 收编版本: v3.4.0（master 分支 tip `5d34e3793cfeaf043fc3918951df437144082349`，
  共 563 次提交历史已连合进本仓——嫁接提交的第二父提交即上游 master tip。
  注意 `git log --follow` 会在嫁接提交处断开（上游路径与仓内
  `modules/hearth/` 不同），查上游历史用 `git log 5d34e37 -- <上游路径>`；
  本仓路径下的变更从嫁接提交起）
- 收编方式: 工作区整体拷贝（`src/`、`CHANGELOG.md`、`LICENSE`、`README.md`、
  `README.zh-CN.md`、`manifest.json`、`versions.json`、`tsconfig.json`、
  `package.json`、`styles.css` 与上游 HEAD 逐文件一致），未改源码语义
- manifest id: `hearth`（聚合内 id 与 legacyId 均保持此真实上游 id）

## 功能

库首页（home screen）：全局搜索/快速切换器、仪表盘卡片（日记/任务/看板/日历/
热力图/RSS 阅读/天气/书签/最近文件/画册/启动器等）、工作区布局切换与壁纸外观，
移动端可用。全部能力见上游 README。

## 未拷贝的上游文件

`assets/`（README 截图，约 3.5MB）、`test/`、`docs/`、`scripts/`、`.github/`、
`.claude/`、`flake.*`、`eslint.config.mjs`、`esbuild.config.mjs`、
`manifest-beta.json`、`package-lock.json`、`.editorconfig`、`.gitignore`、
`.npmrc`：聚合构建不经它们。`CHANGELOG.md` 保留——`src/whatsnew.ts` 以
text loader 原样打包它（"What's new" 弹窗直接镜像上游日志）。

## 并入时的适配

源码运行时语义零改动，全部为聚合环境下的机械适配：

- **obsidian 钉版**: 上游 `"obsidian": "latest"` → `1.14.4`（与 scrolling 等
  已收编模块一致），由此产生的 API 类型差异以 `as unknown as` 断言对齐：
  `commands.listCommands()`（9 处）、`executeCommandById` 返回 boolean 的
  void→boolean 判断（约 10 处）、`viewRegistry.viewByType`（2 处）、
  `processFrontMatter` 回调参数标注（4 处）。均不改运行时行为。
- **strict 适配**（根 tsconfig `strict + noUnusedLocals + noUnusedParameters`）:
  TS2564 断言赋值（`settings!`）、未用参数 `_` 前缀（taskfilter 的 `lead`、
  tensionscene 的 `o`、grid 的 `view`、dataview 的 `card`）、删除三个
  「只写不读」的私有成员（`search.ts` 的 `rootEl`、`whatsnew.ts` 的
  `expandAllEl`、`gallerydetail.ts` 的 `plugin` 字段——构造器赋值后无任何
  读取，删除不影响行为）。
- **moment 类型**: 1.14.4 下 `import { moment }` 直接调用不可调用（TS2349），
  `cards/rss.ts` 与 `tui/cards/rss.ts` 改为上游同款局部断言
  `const moment = createMoment as unknown as (input: Date) => …`（与
  `clip.ts`/`ics.ts`/`rssreader.ts` 等既有文件模式一致）。
- **obsidian-ext.d.ts**: 删除其 `viewRegistry?:` 可选声明——与仓内既有
  media-extended / obsidian-git 的必选 `viewRegistry: ViewRegistry` ambient
  声明合并冲突（TS2687）。hearth 对 viewRegistry 的两处使用本就带
  unknown 断言，不依赖该声明。
- **依赖入根**（root package.json）: `@noble/ed25519`、`@noble/hashes`
  （签名/哈希值导入进 bundle）、`@stratejya/operon-cli`（devDependencies，
  外部 Operon 插件的类型契约）。
- **构建接线**: 根 `esbuild.mjs` loader 增加 `".md": "text"`（whatsnew 打包
  CHANGELOG.md，对应上游 esbuild.config.mjs 的同款 loader）；根 tsconfig
  include 增加 `modules/hearth/src/**/*.ts`（Hearth 全部相对导入，无需
  paths）；根 `styles.css` 追加 Hearth 分段（模块目录内的 styles.css 仅
  留档——聚合构建对 .css 按 empty 处理，不产独立产物）。
