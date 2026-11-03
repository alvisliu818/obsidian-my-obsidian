// vitest 专用：vite 5.4 解析不了 node:sqlite（Node 22.13+ 内置），这里用原生 require 透传。
// 插件打包（esbuild）不经过此文件，node:sqlite 在 bundle 里保持 external。
module.exports = require("node:sqlite");
