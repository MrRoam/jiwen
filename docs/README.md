# 更多说明

## 使用与配置

- [在自己的电脑使用即问](自行部署与AI协助.md)
- [转写和问答配置](API配置.md)
- [本机转写模型](本地转写.md)
- [可选问答路由](OpenRouter优先路由.md)
- [课堂上下文与时间轴](课堂上下文与时间轴.md)

## 开发

前端使用 React + Vite，后端使用 Express + WebSocket + SQLite，音频处理使用 FFmpeg。项目需要 Node.js 24 或更新版本。

常用命令：`npm run dev` 启动，`npm run build` 构建，`npm start` 运行构建后的应用，`npm test` 运行 JavaScript 测试。

发布前运行 `npm run check:release`。该命令扫描当前 Git 跟踪文件中的私有文件和常见凭据；历史记录和媒体需另行核对。不要提交 `.env`、`data/`、密钥、录音或备份。
