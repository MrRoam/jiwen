import {copyFileSync,existsSync,constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('请先安装 Node.js 24 或更新版本。');
const target=path.join(root,'.env');
if(existsSync(target))console.log('已有 .env，保留原配置。');
else{copyFileSync(path.join(root,'.env.example'),target,constants.COPYFILE_EXCL);console.log('已创建本机 .env。');}
console.log('运行 npm run dev，打开 http://localhost:4317，注册后进入侧栏「API 配置」。');
console.log('首次注册的邮箱账号是实例管理员；公开部署可用 ADMIN_EMAIL 预先指定管理员邮箱。');
