import {legalFetch as fetch} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket,{WebSocketServer} from 'ws';
import {openDatabase} from '../server/db.js';
import {initAccounts} from '../server/accounts.js';
import {createImportanceService} from '../server/importance.js';
import {createTeacherQuestionService} from '../server/teacher-questions.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
for(const featureEnabled of [false,true])test(`Jev ${featureEnabled?'启用':'暂停'} HTTP/转写链路：隔离与调用控制`, {timeout:45000},async()=>{
  const scratch=path.join(root,'output/test-tmp');mkdirSync(scratch,{recursive:true});const dir=mkdtempSync(path.join(scratch,'importance-'));
  const db=openDatabase(dir);initAccounts(db);const cookie='importance-integration-session';
  for(const uid of ['one','two'])db.prepare('INSERT INTO users(id,username,password,created_at,email) VALUES(?,?,?,?,?)').run(uid,uid,'unused','2026-01-01',`${uid}@example.test`);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(cookie).digest('hex'),'one',Date.now()+600000);
  for(const [lid,uid] of [['mine','one'],['other','two']])db.prepare('INSERT INTO lessons VALUES(?,?,?,?,0)').run(lid,uid,lid,'2026-01-01');
  for(let i=0;i<3;i++)db.prepare('INSERT INTO segments VALUES(?,?,NULL,?,?,?,1)').run('s'+i,'mine',i*30000,(i+1)*30000,'原句'+i);
  if(!featureEnabled){
    const prior=createImportanceService(db,{key:'fixture',settleMs:0});prior.setEnabled('mine',true);prior.backfill('mine');prior.close();
    const questions=createTeacherQuestionService(db,{key:'fixture',settleMs:0});
    db.prepare('INSERT INTO segments VALUES(?,?,NULL,?,?,?,1)').run('prior-question','mine',90000,91000,'请大家计算这个三角形的面积？');
    questions.enqueue({id:'prior-question',lesson_id:'mine',start_ms:90000,end_ms:91000,text:'请大家计算这个三角形的面积？',final:1});questions.close();
  }
  db.close();
  const calls=[];
  const provider=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const request=JSON.parse(body);calls.push(request);const answers=Object.fromEntries(Object.keys(request.questions).map((k,i)=>[k,{type:'noul',noul:k.startsWith('task_')?0.98:k.startsWith('sentence_')?(i===1?0.01:0.98):0.01}]));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'jev-fixture',answers}));});
  const wsServer=new WebSocketServer({server:provider});wsServer.on('connection',ws=>ws.on('message',(data,binary)=>{if(binary)return;const m=JSON.parse(data);if(m.header.action==='run-task')ws.send(JSON.stringify({header:{event:'task-started'}}));if(m.header.action==='finish-task'){ws.send(JSON.stringify({header:{event:'result-generated'},payload:{output:{sentence:{begin_time:0,end_time:1000,text:'请大家计算这个三角形的面积？',sentence_end:true}}}}));ws.send(JSON.stringify({header:{event:'task-finished'}}));}}));
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));const pp=provider.address().port,port=await freePort(),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server/index.js','--production'],{cwd:root,windowsHide:true,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',SECURE_COOKIE:'false',JEV_ENABLED:String(featureEnabled),TYPESAFE_API_KEY:'fixture-not-real',JEV_API_URL:`http://127.0.0.1:${pp}/v1/systemone`,DASHSCOPE_API_KEY:'fixture-not-real',ASR_WS_URL:`ws://127.0.0.1:${pp}`,ASR_PROVIDER:'remote'},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const request=(route,method='GET',body)=>fetch(base+route,{method,headers:{Cookie:`tingjian=${cookie}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  async function waitFor(predicate){for(let i=0;i<250;i++){if(await predicate())return;await pause(50);}assert.fail('等待结果超时 '+logs);}
  try{
    await waitFor(async()=>{try{return (await fetch(base+'/api/me')).ok;}catch{return false;}});
    assert.equal((await fetch(base+'/api/lessons/mine/importance')).status,401);
    assert.equal((await fetch(base+'/api/lessons/mine/teacher-questions')).status,401);
    assert.equal((await request('/api/lessons/other/teacher-questions')).status,404);
    for(const [method,suffix,body]of [['GET','',undefined],['PATCH','',{enabled:true}],['POST','/analyze',{}]])assert.equal((await request('/api/lessons/other/importance'+suffix,method,body)).status,404);
    const initial=await(await request('/api/lessons/mine/importance')).json();assert.equal(initial.enabled,false);assert.equal(initial.results.length,0);
    if(!featureEnabled){
      const me=await(await request('/api/me')).json();assert.equal(me.config.jevEnabled,false);assert.equal(me.config.jevReady,false);
      assert.equal((await request('/api/lessons/mine/importance','PATCH',{enabled:true})).status,503);
      assert.equal((await request('/api/lessons/mine/importance/analyze','POST',{})).status,503);
      assert.equal((await request('/api/services/test','POST',{service:'jev'})).status,503);
      assert.equal((await request('/api/lessons','POST',{importanceEnabled:true})).status,503);
      const q=await(await request('/api/lessons/mine/teacher-questions')).json();assert.equal(q.ready,false);assert.deepEqual(q.questions,[]);
      const recording=await(await request('/api/lessons/mine/recordings','POST',{mime:'audio/webm'})).json();assert.ok(recording.id);
      await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/api/asr?recordingId=${recording.id}`,{headers:{Cookie:`tingjian=${cookie}`,Origin:base}});ws.on('error',reject);ws.on('message',raw=>{const e=JSON.parse(raw);if(e.type==='ready'){ws.send(Buffer.alloc(32000));ws.send(JSON.stringify({type:'finish'}));}});ws.on('close',resolve);});
      await pause(1200);assert.equal(calls.length,0,'旧队列与新转写均不得调用 Jev');
      const stored=await(await request('/api/lessons/mine')).json();assert.ok(stored.segments.some(s=>s.recording_id===recording.id),'暂停 Jev 不影响转写保存');
      assert.deepEqual((await(await request('/api/lessons/mine/importance')).json()).results,[]);
      assert.deepEqual((await(await request('/api/lessons/mine/teacher-questions')).json()).questions,[]);return;
    }
    assert.equal((await request('/api/lessons/mine/importance','PATCH',{enabled:'true'})).status,400);
    assert.equal((await request('/api/lessons/mine/importance/analyze','POST',{})).status,409);
    const enabled=await(await request('/api/lessons/mine/importance','PATCH',{enabled:true})).json();assert.equal(enabled.enabled,true);assert.equal(enabled.pending,0);
    const pending=await(await request('/api/lessons/mine/importance/analyze','POST',{})).json();assert.equal(pending.pending,3);
    await waitFor(async()=>{const s=await(await request('/api/lessons/mine/importance')).json();return s.results.length===3;});
    const completed=await(await request('/api/lessons/mine/importance')).json();assert.equal(completed.results[1].band,'normal');assert.equal(completed.results[0].band,'high');assert.equal('summary' in completed,false);assert.equal(calls.length,1);
    assert.equal(JSON.stringify(completed).includes('fixture-not-real'),false);
    const r=await(await request('/api/lessons/mine/recordings','POST',{mime:'audio/webm'})).json();assert.ok(r.id);
    await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/api/asr?recordingId=${r.id}`,{headers:{Cookie:`tingjian=${cookie}`,Origin:base}});ws.on('error',reject);ws.on('message',raw=>{const e=JSON.parse(raw);if(e.type==='ready'){ws.send(Buffer.alloc(32000));ws.send(JSON.stringify({type:'finish'}));}});ws.on('close',resolve);});
    const live=await(await request('/api/lessons/mine/importance')).json();assert.equal(live.pending,1,'定稿回调自动排队');
    await waitFor(async()=>{const q=await(await request('/api/lessons/mine/teacher-questions')).json();return q.questions.length===1;});
    const detected=await(await request('/api/lessons/mine/teacher-questions')).json();assert.equal(detected.questions[0].question,'请大家计算这个三角形的面积？');
    const off=await(await request('/api/lessons/mine/importance','PATCH',{enabled:false})).json();assert.equal(off.pending,0);assert.equal(off.results.length,3);
    const onAgain=await(await request('/api/lessons/mine/importance','PATCH',{enabled:true})).json();assert.equal(onAgain.pending,0,'关闭期间的内容不自动补查');
    const fresh=await(await request('/api/lessons','POST',{title:'预先开启',importanceEnabled:true})).json();assert.equal((await(await request(`/api/lessons/${fresh.id}/importance`)).json()).enabled,true);
  }finally{
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    for(const client of wsServer.clients)client.terminate();wsServer.close();await new Promise(r=>provider.close(r));
    assert.ok(path.resolve(dir).startsWith(path.resolve(scratch)+path.sep));rmSync(dir,{recursive:true,force:true});
  }
});
