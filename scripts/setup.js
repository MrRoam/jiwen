import {copyFileSync,existsSync,constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('请先安装 Node.js 24 或更新版本。');
const target=path.join(root,'.env');
if(existsSync(target))console.log('已有 .env，保留原配置。');
else{copyFileSync(path.join(root,'.env.example'),target,constants.COPYFILE_EXCL);console.log('已创建本机 .env。');}
console.log('运行 npm run dev，打开 http://localhost:4317，直接进入课堂。');
console.log('从「设置 → 转写与问答」填写自己的服务密钥，保存后测试连接。');
