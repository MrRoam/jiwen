import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=/(^|\/)(data|node_modules|dist|dist-console|output|\.planning|\.playwright-cli|backups|\.venv[^/]*)\/|(^|\/)\.env($|\.(?!example$))|\.(key|pem|pfx|p12|cer|sqlite(?:-wal|-shm)?|db|log)$/i;
const internal=/^(?:deploy\/|Dockerfile$|compose\.yaml$|docs\/(?:账号与额度|实例管理|Jev重点标记)\.md$)/;
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{24,}\b/,/\bAKIA[A-Z0-9]{16}\b/,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/];
const failed=[];
for(const file of files){
  if(forbidden.test(file)||internal.test(file)){failed.push(`${file}（私有或运行文件）`);continue;}
  const buffer=readFileSync(file);
  if(buffer.includes(0))continue;
  const content=buffer.toString('utf8');
  if(patterns.some(pattern=>pattern.test(content)))failed.push(`${file}（疑似凭据，仅报告路径）`);
}
if(failed.length){console.error('发布检查失败：\n'+failed.join('\n'));process.exitCode=1;}
else console.log(`发布检查通过：${files.length} 个 Git 跟踪文件。请同时确认历史、图片、其他格式和供应商专用令牌。`);
