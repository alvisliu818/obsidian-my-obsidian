// 合并进宿主后没有上游 tsconfig 的 types 数组，这里显式引入私有 API 类型
// （WorkspaceLeaf.id/tabHeaderEl、vault.setConfig 等上游插件用到的内部接口）。
/// <reference types="@obsidian-typings/obsidian-public-latest" />
