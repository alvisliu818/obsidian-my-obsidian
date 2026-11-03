# Contributing

Thanks for your interest in improving this plugin.

## Setup

```bash
npm ci
npm test
npm run lint
npm run build
```

## What to edit

- **Plugin behavior / settings** — `src/main.ts`
- **Styles** — `styles.css`
- **Icon mappings or build pipeline** — `scripts/build-icons.mjs`

Do **not** commit or hand-edit `src/icon-data.ts` or `main.js`. Regenerate them with `npm run build-icons` or `npm run build`.

## Pull requests

1. Keep changes focused on the issue you are solving.
2. Run `npm test`, `npm run lint`, and `npm run build` before opening a PR.
3. Describe how you tested the change in Obsidian (desktop and/or mobile if relevant).

## Issues

Use [GitHub Issues](https://github.com/GilbertzzzZZ/obsidian-material-icon-theme/issues) for bugs and feature requests. Include Obsidian version, plugin version, and steps to reproduce when reporting bugs.

---

## 上游版本与发布

> 维护者在升级或发布时核对上游正式版本，使用提交内的 lockfile（依赖锁文件）追溯图标来源。

### 升级上游

- 在 Bash 中输入目标正式版本，查询官方发布包和 GitHub Release（正式发布记录）：

```bash
read -r -p '上游正式版本：' UPSTREAM_VERSION
npm view "material-icon-theme@$UPSTREAM_VERSION" version gitHead dist --registry=https://registry.npmjs.org --json
gh api "repos/material-extensions/vscode-material-icon-theme/releases/tags/v$UPSTREAM_VERSION" \
  --jq '{tag_name,draft,prerelease,published_at}'
git ls-remote https://github.com/material-extensions/vscode-material-icon-theme.git \
  "refs/tags/v$UPSTREAM_VERSION" "refs/tags/v$UPSTREAM_VERSION^{}"
```

- 确认版本为稳定版本，`draft` 和 `prerelease` 均为 `false`，且 `published_at` 非空。
- 对照发布包的 `gitHead` 与上游 tag（标签）最终指向的完整提交标识。附注标签使用 `^{}` 行，轻量标签使用普通标签行。
- 来源证据缺失或不一致时停止升级。
- 核对通过后，固定版本并验证构建：

```bash
npm install --save-dev --save-exact "material-icon-theme@$UPSTREAM_VERSION" --registry=https://registry.npmjs.org
npm ci
npm test
npm run lint
npm run build
```

- 检查 `package-lock.json` 中的 `version`、`resolved`、`integrity` 与官方发布包一致。
- 同次提交依赖声明和锁文件，在提交说明中记录上游正式版本与完整提交标识。
- 图标映射的本地修改保存在 `scripts/build-icons.mjs`，与上游版本共同构成构建输入。

### 查询历史来源

- 将 `COMMIT` 替换为本仓库的提交标识或版本标签，读取该提交保存的上游版本：

```bash
git show COMMIT:package-lock.json \
  | jq '.packages["node_modules/material-icon-theme"] | {version,resolved,integrity}'
```

- 每个下游提交固定一个上游版本，多个下游提交可以使用同一上游版本。
- 发布说明保存当次核实的下游提交、上游版本、上游提交和发布包完整性值。

### 发布插件

- 发布前使 `package.json` 和 `manifest.json` 的插件版本一致，提交并推送经过验证的代码。
- 在该提交上创建并推送与插件版本相同的标签，例如 `1.4.0`。标签推送自动触发发布。
- 发布流程仅接受版本标签，核对触发提交、实际构建提交、远端标签及插件版本一致。
- 发布流程通过 `scripts/verify-release.mjs` 检查正式上游来源，然后执行锁定安装、测试、代码检查、构建和构建来源证明。
- 手动触发已推送标签的发布时，在 Bash 中执行：

```bash
read -r -p '插件发布标签：' RELEASE_TAG
bash scripts/release.sh "$RELEASE_TAG"
```

- 本地入口需要已登录的 GitHub CLI（命令行工具）及仓库工作流执行权限，打印运行链接并等待该运行结束，失败时返回非零状态。
- 本地入口只触发远端标签中的代码，不上传工作区构建文件。不传标签时从工作区 `manifest.json` 读取版本。
- 手动入口拒绝不含来源核验脚本的历史标签，旧标签不重新指向新提交。
- 远端触发与构建共用 `release.yml`，发布说明由核验结果生成，历史来源以目标提交的锁文件为准。
