import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WebSocket} from 'ws';
import ffmpeg from 'ffmpeg-static';
import {openDatabase} from '../server/db.js';
import {initAccounts} from '../server/accounts.js';
import {runtimeMode,personalOwner,assertPersonalDirectory,assertHostedDirectory} from '../server/personal.js';
import {requestBudget} from '../server/limits.js';
import {audioBudget} from '../server/audio-budget.js';
import {createLifecycle} from '../server/lifecycle.js';
import {createStorageBudget} from '../server/storage-budget.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-personal-')),db=openDatabase(directory);
  initAccounts(db);const owner=personalOwner(db);
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});return {directory,db,owner};
}
test('默认个人使用，仅允许回环监听，身份稳定且不含邮箱',t=>{
  assert.equal(runtimeMode({}),'personal');assert.equal(runtimeMode({JIWEN_MODE:'hosted',HOST:'0.0.0.0'}),'hosted');
  assert.throws(()=>runtimeMode({HOST:'0.0.0.0'}),/本机/);assert.throws(()=>runtimeMode({JIWEN_MODE:'invalid'}),/JIWEN_MODE/);
  const {db,owner,directory}=fixture(t);assert.equal(owner.email,null);assert.equal(personalOwner(db).id,owner.id);assert.doesNotThrow(()=>assertPersonalDirectory(directory));assert.throws(()=>assertHostedDirectory(directory),/个人资料/);
});
test('个人模式不允许接管已有站点账号数据',t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-old-account-')),db=openDatabase(directory);initAccounts(db);
  db.prepare('INSERT INTO users(id,username,password,created_at,email) VALUES(?,?,?,?,?)').run('old','old','unused','2020-01-01','old@example.test');db.close();
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'classroom.sqlite'),before=readFileSync(file);assert.throws(()=>assertPersonalDirectory(directory),/旧账号资料/);assert.deepEqual(readFileSync(file),before);
});
test('取消站点额度后继续统计真实问答和音频用量',t=>{
  const {db,owner}=fixture(t),request=requestBudget(db,{perUser:1,daily:1,perMinute:1,unlimited:true});
  for(let i=0;i<5;i++)assert.equal(request(owner.id),null);
  assert.equal(request.usage(owner.id).requests,5);assert.equal(request.usage(owner.id).limit,null);
  const audio=audioBudget(db,{perUser:1,globalDaily:1,unlimited:true}),permit=audio.open(owner.id);let sent=0;
  for(let i=0;i<3;i++)assert.equal(permit.send(Buffer.alloc(32000),()=>{sent++;return true;}).accepted,true);
  assert.equal(sent,3);assert.equal(audio.usage(owner.id).usedSeconds,3);assert.equal(audio.usage(owner.id).limitSeconds,null);
});
test('个人资料不会因旧到期字段或时间推进而被自动删除',async t=>{
  const {db,owner}=fixture(t);db.prepare('INSERT INTO lessons(id,user_id,title,created_at) VALUES(?,?,?,?)').run('lesson',owner.id,'课堂','2000-01-01');
  const deleted=[],lifecycle=createLifecycle(db,{days:null,now:()=>Date.parse('2100-01-01'),deleteLesson:l=>deleted.push(l.id)});
  assert.equal(db.prepare('SELECT expires_at FROM lessons').get().expires_at,null);
  db.prepare("UPDATE lessons SET expires_at='2000-01-01'").run();await lifecycle.run();assert.deepEqual(deleted,[]);assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n,1);
});
test('取消账号存储上限后仍拒绝实际磁盘不足',t=>{
  const {directory,db,owner}=fixture(t);let free=2*1024**3;
  const budget=createStorageBudget(db,{dataDir:directory,accountBytes:null,globalBytes:null,minFreeBytes:0,statfs:()=>({bavail:free,bsize:1})});
  assert.doesNotThrow(()=>budget.preflightText(owner.id,600*1024**2));assert.equal(budget.usage(owner.id).limitBytes,null);
  free=1024;assert.throws(()=>budget.preflightText(owner.id,1024),/空间不足/);
});

test('个人启动免邮件、免注册，服务配置、课堂、导出与会话隔离可用',{timeout:30000},async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-personal-app-'));
  const portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  let calls=0;const mock=createServer(async(req,res)=>{for await(const chunk of req){}calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"连接成功"}}]}\n\ndata: [DONE]\n\n');});
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const env={...process.env,JIWEN_MODE:'',DATA_DIR:directory,PORT:String(port),HOST:'127.0.0.1',SMTP_USER:'',SMTP_PASS:'',DASHSCOPE_API_KEY:'',LLM_API_KEY:'',OPENROUTER_API_KEY:'',ASR_PROVIDER:'remote',JEV_ENABLED:'false',LLM_ROUTING:'qwen-only',ASR_QUOTA_MODE:'trial',API_CONFIG_ENABLED:'false',SECURE_COOKIE:'true',CONSOLE_PORT:'0',DAILY_QUESTIONS:'1',GLOBAL_DAILY_QUESTIONS:'1',GLOBAL_REQUESTS_PER_MINUTE:'1'};
  let child,logs='';const base=`http://127.0.0.1:${port}`;
  async function start(){child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);for(let i=0;i<100;i++){try{const r=await fetch(base+'/api/me');if(r.ok)return r;}catch{}if(child.exitCode!==null)break;await pause(50);}assert.fail('启动失败 '+logs);}
  async function stop(){if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}}
  t.after(async()=>{await stop();await new Promise(resolve=>mock.close(resolve));rmSync(directory,{recursive:true,force:true});});
  let boot=await start(),cookie=boot.headers.get('set-cookie').split(';')[0],data=await boot.json();const uid=data.user.id;
  assert.equal(data.config.mode,'personal');assert.equal(data.user.email,null);assert.equal(data.config.registrationOpen,false);assert.equal(data.config.mailReady,false);assert.equal(data.config.legal,null);assert.ok(!cookie.includes('Secure'));
  const request=(route,{method='GET',body,headers={}}={})=>fetch(base+'/api'+route,{method,headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/lessons')).status,401);
  assert.equal((await request('/auth/register',{method:'POST',body:{email:'x@example.test',password:'testpass123'}})).status,404);
  assert.equal((await request('/account',{method:'DELETE',body:{}})).status,404);assert.equal((await request('/payment-interest')).status,404);
  assert.equal((await request('/me',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/me',{headers:{'X-Forwarded-For':'203.0.113.1'}})).status,403);
  const forged=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/me',{headers:{Host:`evil.example:${port}`}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(forged,403);
  const socket=new WebSocket(base.replace('http:','ws:')+'/ws/presence',{headers:{Cookie:cookie},origin:'https://evil.example'});const rejected=await new Promise(resolve=>{socket.on('unexpected-response',(req,res)=>{res.resume();socket.terminate();resolve(res.statusCode);});socket.on('error',()=>{});});assert.equal(rejected,403);
  assert.equal((await request('/services/config',{method:'PUT',body:{LLM_API_KEY:'personal-test-only',LLM_BASE_URL:`http://127.0.0.1:${mock.address().port}/v1`,LLM_MODEL:'fixture',LLM_USE_ASR_KEY:'false'}})).status,200);
  const config=await(await request('/services/config')).json();assert.ok(!JSON.stringify(config).includes('personal-test-only'));
  for(let i=0;i<3;i++){const result=await request('/services/test',{method:'POST',body:{service:'llm'}});assert.equal(result.status,200,await result.clone().text());assert.equal((await result.json()).ok,true);}assert.equal(calls,3);
  const lesson=await(await request('/lessons',{method:'POST',body:{title:'我的课堂'}})).json();assert.equal((await(await request(`/lessons/${lesson.id}`)).json()).expires_at,null);
  const recording=await(await request(`/lessons/${lesson.id}/recordings`,{method:'POST',body:{mime:'audio/webm'}})).json();assert.ok(recording.id);assert.equal(recording.asrReady,false);
  assert.equal((await request('/services/config',{method:'PUT',body:{LLM_MODEL:'busy'}})).status,409);assert.equal((await request(`/recordings/${recording.id}/cancel`,{method:'POST',body:{}})).status,200);
  const savedRecording=await(await request(`/lessons/${lesson.id}/recordings`,{method:'POST',body:{mime:'audio/webm'}})).json();
  const audioFile=path.join(directory,'fixture.webm'),generator=spawn(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libopus',audioFile],{windowsHide:true,stdio:'ignore'});assert.equal((await once(generator,'exit'))[0],0);
  const upload=await fetch(`${base}/api/recordings/${savedRecording.id}/chunks/0`,{method:'PUT',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/octet-stream','X-Duration-Ms':'1000'},body:readFileSync(audioFile)});assert.equal(upload.status,200);
  assert.equal((await request(`/recordings/${savedRecording.id}/finish`,{method:'POST',body:{chunks:1}})).status,200);
  const playback=await request(`/recordings/${savedRecording.id}/audio`,{headers:{Range:'bytes=0-99'}});assert.equal(playback.status,206);assert.equal((await playback.arrayBuffer()).byteLength,100);
  const conversation=await(await request(`/lessons/${lesson.id}/conversations`,{method:'POST',body:{title:'问题',anchorMs:0}})).json();
  const answer=await request(`/conversations/${conversation.id}/messages`,{method:'POST',body:{content:'解释一下电路'}});assert.equal(answer.status,200);assert.match(await answer.text(),/连接成功/);assert.equal(calls,4);
  const exported=await(await request('/account/export')).json();assert.equal(exported.lessons[0].title,'我的课堂');
  await stop();boot=await start();cookie=boot.headers.get('set-cookie').split(';')[0];data=await boot.json();assert.equal(data.user.id,uid);
  assert.equal((await(await request(`/lessons/${lesson.id}`)).json()).title,'我的课堂');assert.equal((await(await request('/services/config')).json()).LLM_API_KEY_CONFIGURED,true);
});
