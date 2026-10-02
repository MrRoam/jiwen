import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('修改密码：未登录拒绝、需验证旧密码、改后旧密码失效', {timeout:30000},async()=>{
  const scratch=path.resolve(root,'output/test-tmp');mkdirSync(scratch,{recursive:true});const directory=mkdtempSync(path.join(scratch,'password-'));
  const email='password@example.test';
  const appPort=await port(),base=`http://127.0.0.1:${appPort}`;
  const child=spawn(process.execPath,['server/index.js'],{cwd:root,windowsHide:true,env:{...process.env,DATA_DIR:directory,PORT:String(appPort),HOST:'127.0.0.1',SECURE_COOKIE:'false'},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const request=async(route,{cookie,method='GET',body}={})=>fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  try{
    let connected=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/me')).ok){connected=true;break;}}catch{}await delay(50);}assert.ok(connected,logs);
    assert.equal((await request('/api/auth/change-password',{method:'POST',body:{oldPassword:'legacy-password',newPassword:'new-password-123'}})).status,401);
    const login=await request('/api/auth/register',{method:'POST',body:{email:email,password:'legacy-password'}});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/auth/change-password',{cookie,method:'POST',body:{oldPassword:'wrong-password',newPassword:'new-password-123'}})).status,401);
    assert.equal((await request('/api/auth/change-password',{cookie,method:'POST',body:{oldPassword:'legacy-password',newPassword:'short'}})).status,400);
    assert.equal((await request('/api/auth/change-password',{cookie,method:'POST',body:{oldPassword:'legacy-password',newPassword:'new-password-123'}})).status,200);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:email,password:'legacy-password'}})).status,401);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:email,password:'new-password-123'}})).status,200);
  }finally{child.kill();await once(child,'exit');rmSync(directory,{recursive:true,force:true});}
});
