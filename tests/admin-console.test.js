import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {createServer,request as httpRequest} from 'node:http';
import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {createAccountFetch} from './legal-fixture.js';
import {createPresence} from '../server/console.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
async function rawStatus(url,{headers,method='GET'}={}){return new Promise((resolve,reject)=>{const req=httpRequest(url,{headers,method},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});}
const execute=promisify(execFile);
before(async()=>{await execute(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--config','vite.console.config.js'],{cwd:root,windowsHide:true});});

test('打开入口识别控制台，拒绝错误端口和旧实例，失败只显示中文说明',async()=>{
  let body={console:true,user:null};
  const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const servicePort=String(server.address().port),entry=path.join(root,'scripts/open-console.js');
  const run=consolePort=>execute(process.execPath,[entry,'--check'],{cwd:root,windowsHide:true,env:{...process.env,JIWEN_MODE:'hosted',CONSOLE_PORT:consolePort,PORT:servicePort}});
  try{
    assert.match((await run(servicePort)).stdout,/本机控制台：http/);
    body={user:null,config:{}};
    await assert.rejects(run(servicePort),error=>{assert.match(error.stderr,/运行的不是本机控制台/);assert.doesNotMatch(error.stderr,/Error:|at file:/);return true;});
    await assert.rejects(run(String(await port())),error=>{assert.match(error.stderr,/即问正在运行，但尚未启动本机控制台/);assert.doesNotMatch(error.stderr,/Error:|at file:/);return true;});
    await assert.rejects(run('0'),error=>{assert.match(error.stderr,/0 表示关闭/);assert.doesNotMatch(error.stderr,/Error:|at file:/);return true;});
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('在线连接按账号去重，失效登录和心跳超时移出统计',()=>{
  const presence=createPresence();
  function socket(){const value=new EventEmitter();value.ping=()=>{};value.terminate=()=>value.emit('close');return value;}
  const a=socket(),b=socket(),c=socket();let valid=true;
  presence.connect(a,'same');presence.connect(b,'same');presence.connect(c,'other',()=>valid);
  assert.equal(presence.users().size,2);a.emit('message',Buffer.from('{"recording":true}'));assert.equal(presence.recordingUsers().size,1);
  b.emit('close');assert.equal(presence.users().size,2);
  presence.sweep();a.emit('pong');valid=false;presence.sweep();assert.equal(presence.users().size,1);
  presence.sweep();assert.equal(presence.users().size,0);
});

test('本机独立控制台：免登录、公网隔离、实时统计和无损重启',{timeout:45000},async()=>{
  const scratch=path.join(root,'output','test-tmp');mkdirSync(scratch,{recursive:true});const directory=mkdtempSync(path.join(scratch,'console-'));
  const legalFetch=createAccountFetch(directory);
  const base=`http://127.0.0.1:${await port()}`;
  const local=`http://127.0.0.1:${await port()}`;
  const child=fork(path.join(root,'server/start.js'),['--production'],{cwd:root,execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,JIWEN_MODE:'hosted',DATA_DIR:directory,PORT:new URL(base).port,CONSOLE_PORT:new URL(local).port,HOST:'127.0.0.1',SECURE_COOKIE:'true',API_CONFIG_ENABLED:'false',ADMIN_EMAIL:'owner@example.test',DASHSCOPE_API_KEY:'',LLM_API_KEY:'',OPENROUTER_API_KEY:'',ASR_PROVIDER:'remote',JEV_ENABLED:'false',GLOBAL_DAILY_QUESTIONS:'40',GLOBAL_DAILY_ASR_SECONDS:'600',MIN_DISK_FREE_BYTES:'0'}});
  let logs='';child.stdout.on('data',value=>logs+=value);child.stderr.on('data',value=>logs+=value);
  const sockets=[];let db;
  const request=(route,{cookie,method='GET',body,headers={}}={})=>legalFetch(`${base}/api${route}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const localRequest=(route,{cookie,method='GET',body,headers={}}={})=>fetch(`${local}/api${route}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const overview=async()=>{const response=await localRequest('/admin/overview');assert.equal(response.status,200,await response.clone().text());return response.json();};
  async function eventually(predicate){for(let index=0;index<120;index++){try{if(await predicate())return;}catch{}await pause(50);}assert.fail(logs);}
  async function connect(cookie){const ws=new WebSocket(`${base.replace('http','ws')}/api/presence`,{headers:{Cookie:cookie,Origin:base}});sockets.push(ws);await once(ws,'open');return ws;}
  try{
    await eventually(async()=> (await request('/me')).ok);
    assert.equal((await request('/admin/overview')).status,404);
    assert.equal((await localRequest('/admin/overview')).status,200,'本机直接访问，不需要登录');
    assert.equal((await localRequest('/admin/overview')).headers.get('set-cookie'),null,'控制台不创建登录会话');
    assert.equal((await request('/lessons')).status,401,'即问仍需账号登录');
    const page=await fetch(`${local}/`);assert.equal(page.status,200);assert.match(await page.text(),/本机控制台/);
    for(const route of ['/console.html','/console','/admin','/src/console-main.jsx','/src/admin-console.jsx'])assert.equal((await fetch(`${base}${route}`)).status,404,route);
    async function register(email){const response=await request('/auth/register',{method:'POST',body:{email,password:'console-test-password'}});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],user:await response.json()};}
    const owner=await register('owner@example.test'),student=await register('student@example.test');
    for(const cookie of [student.cookie,owner.cookie]){
      assert.equal((await request('/admin/overview',{cookie})).status,404);
      assert.equal((await request('/admin/restart',{method:'POST',cookie,body:{confirmation:'restart'}})).status,404);
      assert.equal((await localRequest('/admin/overview',{cookie})).status,200,'本机访问不依赖即问账号身份');
    }
    assert.equal((await localRequest('/login',{method:'POST',body:{email:owner.user.email,password:'console-test-password'}})).status,404,'不再提供控制台登录接口');
    assert.equal((await localRequest('/logout',{method:'POST'})).status,404);
    for(const headers of [{Origin:base},{Host:'public.example'},{'X-Forwarded-For':'127.0.0.1'},{Forwarded:'for=127.0.0.1'},{'Sec-Fetch-Site':'cross-site'}]){
      assert.equal(await rawStatus(`${local}/api/admin/overview`,{headers}),403,JSON.stringify(headers));
      assert.equal(await rawStatus(`${local}/api/admin/restart`,{method:'POST',headers}),403);
    }
    assert.equal((await localRequest('/admin/restart',{method:'POST',body:{}})).status,400);
    const first=await overview();assert.equal(first.restart.supported,true);assert.equal(first.live.online,0);assert.equal(first.accounts.total,2);
    assert.equal((await request('/services/config',{cookie:owner.cookie})).status,403,'关闭 API 配置不应关闭控制台');
    for(const headers of [{Origin:base},{Cookie:student.cookie,Origin:'https://foreign.example'}]){
      const denied=new WebSocket(`${base.replace('http','ws')}/api/presence`,{headers});sockets.push(denied);
      await assert.rejects(once(denied,'open'),/401/);
    }
    const a=await connect(student.cookie),b=await connect(student.cookie);await eventually(async()=> (await overview()).live.online===1);
    const lesson=await(await request('/lessons',{cookie:student.cookie,method:'POST',body:{title:'监控测试'}})).json();
    const recording=await(await request(`/lessons/${lesson.id}/recordings`,{cookie:student.cookie,method:'POST',body:{mime:'audio/webm'}})).json();assert.ok(recording.id);
    a.send(JSON.stringify({recording:true}));await eventually(async()=> (await overview()).live.recording===1);
    assert.equal((await localRequest('/admin/restart',{method:'POST',body:{confirmation:'restart'}})).status,409);
    a.close();await once(a,'close');await eventually(async()=> (await overview()).live.recording===0);
    const abandoned=await overview();assert.equal(abandoned.live.online,1);assert.equal(abandoned.live.pendingRecordings,1);assert.equal(abandoned.tasks[0].type,'recovery');
    assert.equal((await request(`/recordings/${recording.id}/cancel`,{cookie:student.cookie,method:'POST'})).status,200);
    db=new DatabaseSync(path.join(directory,'classroom.sqlite'));
    const day=new Date().setUTCHours(0,0,0,0),key=new Date(day).toISOString().slice(0,10);
    for(const ms of [day-1,day,Date.now(),day+86400000])db.prepare('INSERT INTO llm_requests(user_id,created_ms,prompt_tokens,completion_tokens,usage_received) VALUES(?,?,?,?,?)').run(student.user.id,ms,10,5,1);
    db.prepare('INSERT INTO asr_global_usage(day,seconds) VALUES(?,120) ON CONFLICT(day) DO UPDATE SET seconds=120').run(key);
    db.prepare("INSERT INTO recordings(id,lesson_id,offset_ms,duration_ms,mime,status,created_at) VALUES('saved-fixture',?,0,1000,'audio/webm','interrupted',?)").run(lesson.id,new Date().toISOString());
    const audioDirectory=path.join(directory,'saved-fixture');mkdirSync(audioDirectory);const audioBytes=Buffer.from('synthetic-audio-chunk');writeFileSync(path.join(audioDirectory,'0.chunk'),audioBytes);
    db.prepare("INSERT INTO chunks VALUES('saved-fixture',0,?,'fixture')").run(audioBytes.length);
    const before=await overview();assert.equal(before.usage.llm.used,2);assert.equal(before.usage.llm.promptTokens,20);assert.equal(before.usage.asr.used,120);assert.equal(before.resetsAt,day+86400000);assert.equal(before.restart.blockers,0);
    assert.equal(before.costs.complete,false);assert.equal(before.costs.asr.unpricedSeconds,120);assert.equal(before.costs.totalCny,0,'旧混合转写用量不能套用当前云端单价');
    assert.ok(!JSON.stringify(before).includes('console-test-password'));assert.ok(!JSON.stringify(before).includes('tingjian='));
    const logout=await request('/logout',{method:'POST',cookie:student.cookie});assert.equal(logout.status,200);
    assert.equal((await request('/lessons',{cookie:student.cookie})).status,401);
    db.close();db=null;
    const accepted=await localRequest('/admin/restart',{method:'POST',body:{confirmation:'restart'}});assert.equal(accepted.status,200);
    await eventually(async()=> (await overview()).instanceId!==before.instanceId);
    const after=await overview();assert.equal(after.usage.llm.used,2);assert.equal(after.usage.asr.used,120);assert.equal(after.accounts.total,2);assert.equal(after.restart.supported,true);assert.equal(after.live.online,0);
    assert.equal((await request(`/lessons/${lesson.id}`,{cookie:owner.cookie})).status,404,'重启后仍保留账号隔离');
    const relogin=await request('/auth/login',{method:'POST',body:{email:student.user.email,password:'console-test-password'}});assert.equal(relogin.status,200);
    const studentAfter=await(await request(`/lessons/${lesson.id}`,{cookie:relogin.headers.get('set-cookie').split(';')[0]})).json();assert.equal(studentAfter.recordings[0].id,'saved-fixture');
    assert.deepEqual(readFileSync(path.join(audioDirectory,'0.chunk')),audioBytes,'重启不改变已有音频分段');
    assert.equal((await localRequest('/admin/overview')).status,200,'重启后仍可免登录查看');
    assert.equal((await request('/lessons',{cookie:owner.cookie})).status,200,'本机控制台不影响即问登录');
  }finally{
    db?.close();for(const ws of sockets)ws.terminate();
    if(child.exitCode===null){const exited=once(child,'exit');child.send({type:'shutdown'});await exited;}
    const target=path.resolve(directory);assert.ok(target.startsWith(path.resolve(scratch)+path.sep));rmSync(target,{recursive:true,force:true});rmSync(`${target}.deletions.jsonl`,{force:true});
  }
});
