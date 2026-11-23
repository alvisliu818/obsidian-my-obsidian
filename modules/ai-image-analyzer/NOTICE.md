AI image analyzer 1.2.1
=======================

Upstream    https://github.com/Swaggeroo/ai-image-analyzer
Author      Swaggeroo
License     MIT (see LICENSE) — the aggregate plugin is GPL-3.0; MIT is
            permissive and may be redistributed inside it provided this
            notice and the upstream license travel with the code.
Version     1.2.1, minAppVersion 0.15.0

What it does
------------
右键/命令对面板中的图片做 AI 分析，产出关键词并复制到剪贴板。提供者可
选 Ollama（本地）或 Google Gemini，模型列表自动探测。

Aggregate adaptations（聚合环境适配）
-------------------------------------
1. **构造期探活移除（2026-11-23，用户报启动控制台噪声）**：上游
   OllamaProvider/GeminiProvider 的构造函数无条件探活（`ollama.list()` =
   GET /api/tags、`gemini.models.list()`），而聚合默认 provider 就是
   ollama——没跑 Ollama 的机器每次启动都吃两条 Notice + 控制台
   `GET http://127.0.0.1:11434/api/tags net::ERR_CONNECTION_REFUSED` 与
   `TypeError: Failed to fetch`。改为：构造期只建客户端（零网络）；
   探活移到 `generateSettings`（打开 AI 设置页时补一次，静默失败——
   自定义模型列表只有设置页消费）；URL / API key 变更（显式动作）保留
   失败提示（checkOllama/checkGemini 增 notify 参数）。查询路径不经探活，
   行为不变。
