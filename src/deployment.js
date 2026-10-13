export const sourceUrl='https://github.com/MrRoam/jiwen';
export function deploymentPrompt(language='zh-CN'){
  return language==='en'?`Help me use Jiwen on my computer: ${sourceUrl}
First confirm whether I use Windows, macOS or Linux.
Read the downloaded README and package.json. Install Node.js 24+ and npm, download the project and start it. Open http://localhost:4317.
Personal use opens the classroom directly without registration or mail setup. On Windows use 启动.cmd; otherwise run npm ci and npm run dev.
Help me open Settings → Transcription and answers and configure my own services. I will enter the keys in the app; do not request or display them.
Test both connections, then guide me through a 30-second recording, saving, transcription, a question and playback.
Do not overwrite existing settings, delete data or start two apps on the same data directory. Diagnose the actual error if a step fails.`:`请帮我在自己的电脑使用即问：${sourceUrl}
先确认我的系统是 Windows、macOS 还是 Linux。
阅读下载版本的 README 和 package.json。安装 Node.js 24 或更新版本及 npm，下载项目并启动，打开 http://localhost:4317。
个人使用直接进入课堂，无需注册或邮件配置。Windows 可使用启动.cmd；其他系统执行 npm ci 和 npm run dev。
带我进入“设置 → 转写与问答”，配置自己的服务。由我在页面填写密钥，不索取或回显密钥。
分别测试连接，再完成 30 秒录音、暂停保存、查看转写、提问和回放。
不覆盖已有配置，不删除资料，不同时启动使用同一数据目录的应用。出错时按具体错误定位。`;
}
