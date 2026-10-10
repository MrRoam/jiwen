export const sourceUrl='https://github.com/MrRoam/jiwen';
export function deploymentPrompt(language='zh-CN'){
  return language==='en'?`Help me deploy Jiwen: ${sourceUrl}
First ask whether I use Windows, macOS or Linux and whether I need access from other devices.
Read the downloaded README, package.json, .env.example and deploy/README.md. Start on my own computer using Git, Node.js 24+ and npm. Do not ask me to buy a server first.
Clone the repository, run npm ci and npm run setup, configure SMTP in .env, then run npm run dev and open http://localhost:4317. Do not overwrite .env, delete data or run two services on the same database.
Explain each SMTP setting and confirm I receive the verification email. Help me register my administrator account using the email verification code, then open the account menu at the bottom of the sidebar → API configuration. I will enter my own keys; do not request or display keys, mail authorization codes or passwords.
Explain cloud API costs and usage limits. Test both connections, then guide me through a 30-second recording, saving, transcription, a question and playback. Diagnose specific errors without deleting data.
Only configure HTTPS or a server when I need phone or remote access. My trial account and classes will not transfer automatically.`:`请协助我部署即问：${sourceUrl}
先问我用 Windows、macOS 还是 Linux，以及是否需要手机或远程访问。
阅读实际下载版本的 README、package.json、.env.example 和 deploy/README.md。优先在自己的电脑运行，使用 Git、Node.js 24 或更新版本及 npm，不先购买服务器。
下载仓库，执行 npm ci、npm run setup，配置 .env 中的 SMTP，再执行 npm run dev，打开 http://localhost:4317。不覆盖已有 .env，不删除 data、数据库或录音，不并行启动使用同一数据库的服务。
解释 SMTP 每项配置，并确认能够收到验证码邮件。通过邮箱验证码注册管理员，再打开“侧栏底部账号 → API 配置”。由我在自己的实例填写密钥，不向我索取或回显密钥、邮件授权码、密码。
解释云 API 费用和用量限制。分别测试转写与问答，再完成 30 秒真实录音、暂停保存、查看转写、提问和回放。出错时按具体错误定位，不清空数据。
只有需要手机或远程访问时，再配置 HTTPS 或服务器。说明体验站账号和课堂不会自动迁移。`;
}
