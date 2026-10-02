# OpenRouter 可选路由

默认直接使用页面中填写的问答接口，推荐 Qwen。登录管理员账号，进入侧栏“API 配置 → 问答服务 → OpenRouter 路由（可选）”，选择“优先 OpenRouter 免费模型”，填写自己的 OpenRouter API Key，保存并测试。

当前优先模型由 `server/answer-router.js` 的 `NEMOTRON_FREE` 定义，使用免费版本；模型可用性以 OpenRouter 为准。优先和备用服务使用独立密钥。HELP 优先直接使用页面上方的问答接口。

服务器 `.env` 的 `OPENROUTER_FREE_DAILY_REQUESTS` 默认 1000，`OPENROUTER_FREE_RESERVE_REQUESTS` 默认 100：本实例记录的调用达到两者之差时切到备用接口。此值是本地假定上限，不是全账号实时余额；其他应用共用 Key 的调用不会被统计。

优先接口出现 402 或 429 且尚未输出正文时，最多切换一次备用服务。已经输出正文后不混接其他模型。主、备用请求分别计入使用次数，仍受账号和全站额度约束。

OpenRouter 免费保护由 `LLM_FREE_ONLY` 控制，默认开启；限定免费模型并发送零价格约束。备用服务及转写可能收费，不能把免费保护理解成全部 API 免费。

密钥仅保存服务器。页面配置立即生效；`.env` 的额度变更需要重启。可用 `npm run check:openrouter` 检查 .env 中的 OpenRouter 账号状态，该可选命令不会读取页面保存的 Key；页面用户直接使用连接测试即可。
