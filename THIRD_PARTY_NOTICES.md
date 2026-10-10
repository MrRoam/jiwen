# 第三方依赖

项目自身代码使用 MIT 许可证，第三方组件保留各自许可证。公开源码不包含 `node_modules/`、FFmpeg 二进制、模型权重或用户数据；安装依赖时由 npm 或相应工具取得。

| 组件 | 用途 | 许可与来源 |
| --- | --- | --- |
| React、Vite、Express、ws | 界面、构建、服务端 | 各项目 MIT 许可，详见安装包 LICENSE |
| react-markdown、remark、rehype、KaTeX | Markdown 和公式 | 各组件保留其 MIT 等许可 |
| lucide-react | 界面图标 | ISC，详见安装包 LICENSE |
| Noto Serif SC | 首页标题的固定 SVG 字形 | SIL Open Font License 1.1，见 `public/brand/NotoSerifSC-OFL.txt`；仅保留标题轮廓，无需加载字体文件 |
| nodemailer | 邮件找回密码 | MIT-0，详见安装包 LICENSE |
| ffmpeg-static | 安装平台对应 FFmpeg、音频转码 | 包标记为 GPL-3.0-or-later；[项目及构建来源](https://github.com/eugeneware/ffmpeg-static) |
| faster-whisper（可选） | 本地语音识别 | MIT；模型权重遵循其各自许可 |

如分发包含 FFmpeg 的镜像或二进制，需同时核对所包含版本的许可、构建来源和源码提供要求；不能把项目 MIT 声明当成第三方二进制的统一许可。当前仓库只发布源码和 Docker 构建文件。
