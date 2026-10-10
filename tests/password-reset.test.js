import {legalFetch as fetch,createAccountFetch} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fakeSmtp,decodeBody} from './smtp-fixture.js';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('忘记密码：发码限频、错误验证码拒绝、重置后旧密码失效', {timeout:60000},async()=>{
  const scratch=path.resolve(root,'output/test-tmp');mkdirSync(scratch,{recursive:true});const directory=mkdtempSync(path.join(scratch,'reset-'));
  const fetch=createAccountFetch(directory);
  const captured=[],smtp=fakeSmtp(captured);await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
  const smtpPort=smtp.address().port,appPort=await port(),base=`http://127.0.0.1:${appPort}`;
  const child=spawn(process.execPath,['server/index.js','--production'],{cwd:root,windowsHide:true,env:{...process.env,DATA_DIR:directory,PORT:String(appPort),HOST:'127.0.0.1',SECURE_COOKIE:'false',SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtpPort),SMTP_USER:'noreply@test.local',SMTP_PASS:'x'},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const request=async(route,{cookie,method='GET',body}={})=>fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  try{
    let connected=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/me')).ok){connected=true;break;}}catch{}await delay(50);}assert.ok(connected,logs);
    const register=await request('/api/auth/register',{method:'POST',body:{email:'reset@example.test',password:'old-password-123'}});
    assert.equal(register.status,200);
    // 未注册邮箱：返回同样话术，但不发邮件。
    const unknown=await request('/api/auth/request-reset',{method:'POST',body:{email:'nobody@example.test'}});
    assert.equal(unknown.status,200);assert.deepEqual(await unknown.json(),{ok:true,message:'如果该邮箱已注册，验证码已发出，请查收（10 分钟内有效）。'});
    assert.equal(captured.length,0);
    const sent=await request('/api/auth/request-reset',{method:'POST',body:{email:'reset@example.test'}});
    assert.equal(sent.status,200);
    assert.equal(captured.length,1);
    const code=(decodeBody(captured[0]).match(/\b(\d{6})\b/)||[])[1];
    assert.ok(code,'邮件正文应包含 6 位验证码');
    assert.match(decodeBody(captured[0]),/你正在重置即问/,'未指定语言时仍发送中文邮件');
    const englishAccount=await request('/api/auth/register',{method:'POST',body:{email:'reset-en@example.test',password:'english-password'}});
    assert.equal(englishAccount.status,200);
    const englishSent=await request('/api/auth/request-reset',{method:'POST',body:{email:'reset-en@example.test',locale:'en'}});
    assert.equal(englishSent.status,200);assert.equal(captured.length,2);
    assert.match(decodeBody(captured[1]),/verification code is \d{6}/);assert.doesNotMatch(decodeBody(captured[1]),/\p{Script=Han}/u);
    // 1 分钟内重复发码被限频。
    assert.equal((await request('/api/auth/request-reset',{method:'POST',body:{email:'reset@example.test'}})).status,429);
    // 错误验证码。
    const wrong=code==='000000'?'000001':'000000';
    assert.equal((await request('/api/auth/reset-password',{method:'POST',body:{email:'reset@example.test',code:wrong,password:'new-password-123'}})).status,403);
    // 正确验证码重置成功。
    assert.equal((await request('/api/auth/reset-password',{method:'POST',body:{email:'reset@example.test',code,password:'new-password-123'}})).status,200);
    // 验证码一次性：重放失败。
    assert.equal((await request('/api/auth/reset-password',{method:'POST',body:{email:'reset@example.test',code,password:'another-pass-123'}})).status,403);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'reset@example.test',password:'old-password-123'}})).status,401);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'reset@example.test',password:'new-password-123'}})).status,200);
  }finally{child.kill();await once(child,'exit');smtp.close();rmSync(directory,{recursive:true,force:true});}
});
test('未配置邮件服务时，找回密码返回 503', {timeout:30000},async()=>{
  const scratch=path.resolve(root,'output/test-tmp');mkdirSync(scratch,{recursive:true});const directory=mkdtempSync(path.join(scratch,'nomail-'));
  const fetch=createAccountFetch(directory);
  const appPort=await port(),base=`http://127.0.0.1:${appPort}`;
  const child=spawn(process.execPath,['server/index.js','--production'],{cwd:root,windowsHide:true,env:{...process.env,DATA_DIR:directory,PORT:String(appPort),HOST:'127.0.0.1',SECURE_COOKIE:'false'},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  try{
    let connected=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/me')).ok){connected=true;break;}}catch{}await delay(50);}assert.ok(connected,logs);
    assert.equal((await request503(base)).status,503);
  }finally{child.kill();await once(child,'exit');rmSync(directory,{recursive:true,force:true});}
});
async function request503(base){return fetch(base+'/api/auth/request-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'a@example.test'})});}
