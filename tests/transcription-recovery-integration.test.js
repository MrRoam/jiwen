import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import WebSocket from 'ws';
import ffmpeg from 'ffmpeg-static';
import {createAccountFetch} from './legal-fixture.js';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('缺段自动补转写，重试不重复扣额、失败保留原文，旧对话冻结且账号隔离',{timeout:30000},async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-recovery-api-')),port=await freePort(),base=`http://127.0.0.1:${port}`;
  const fetch=createAccountFetch(directory);
  const streams=new Map();let mode='ok',requests=0,tailPending=false,child,db,logs='';
  const mock=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/health')return res.end(JSON.stringify({ready:true,streaming:true,chunkSeconds:.6}));
    if(req.method==='DELETE'){streams.delete(req.url.split('/').at(-1));return res.end('{}');}
    let length=0;for await(const bytes of req)length+=bytes.length;requests++;
    if(mode==='fail'){res.writeHead(503);return res.end(JSON.stringify({error:'inference_failed'}));}
    const key=req.headers['x-asr-stream'],previous=streams.get(key)||0,end=previous+length/32000;
    streams.set(key,end);
    if(mode==='delay-final'&&req.headers['x-asr-final']==='1'){tailPending=true;await delay(300);}
    res.end(JSON.stringify({timeline:'stream',segments:[{start:previous,end,text:req.headers['x-asr-final']==='1'?'完整尾字':'补齐课堂内容'}]}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const request=(route,{cookie,method='GET',body}={})=>fetch(base+'/api'+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  async function register(email){const response=await request('/auth/register',{method:'POST',body:{email,password:'recovery-test123'}});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
  async function state(rid,cookie){return (await request(`/recordings/${rid}`,{cookie})).json();}
  async function waitState(rid,cookie,expected){for(let i=0;i<250;i++){const row=await state(rid,cookie);if(row.transcription_status===expected)return row;await delay(20);}assert.fail(`补转写没有进入 ${expected}`);}
  async function startApp(){
    child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,JIWEN_MODE:'hosted',DATA_DIR:directory,PORT:String(port),HOST:'127.0.0.1',SECURE_COOKIE:'false',ADMIN_EMAIL:'',ASR_PROVIDER:'local',LOCAL_ASR_URL:`http://127.0.0.1:${mock.address().port}`,LLM_API_KEY:'',DASHSCOPE_API_KEY:'',OPENROUTER_API_KEY:'',JEV_ENABLED:'false',MONTHLY_AUDIO_SECONDS:'30',GLOBAL_DAILY_ASR_SECONDS:'30',MIN_FREE_DISK_BYTES:'1'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',value=>logs+=value);child.stderr.on('data',value=>logs+=value);
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/me')).ok){ready=true;break;}}catch{}await delay(30);}assert.ok(ready,logs);
  }
  try{
    await startApp();
    const cookie=await register('recovery-owner@example.test'),other=await register('recovery-other@example.test');
    const lesson=await(await request('/lessons',{cookie,method:'POST',body:{title:'补转写测试'}})).json();
    const rec=await(await request(`/lessons/${lesson.id}/recordings`,{cookie,method:'POST',body:{mime:'audio/webm'}})).json();
    db=new DatabaseSync(path.join(directory,'classroom.sqlite'));db.exec('PRAGMA foreign_keys=ON');
    db.prepare('INSERT INTO segments VALUES(?,?,?,?,?,?,?)').run('original',lesson.id,rec.id,0,600,'原来的部分文字',1);
    const conversation=await(await request(`/lessons/${lesson.id}/conversations`,{cookie,method:'POST',body:{anchorMs:0,selectedId:'original'}})).json();
    await new Promise((resolve,reject)=>{
      const socket=new WebSocket(`ws://127.0.0.1:${port}/api/asr?recordingId=${rec.id}`,{headers:{Cookie:cookie,Origin:base}});
      socket.on('error',reject);socket.on('message',raw=>{const event=JSON.parse(raw);if(event.type==='ready')socket.send(Buffer.alloc(38400));if(event.type==='segment')socket.close();});socket.on('close',resolve);
    });
    const chargedBefore=(await(await request('/usage',{cookie})).json()).asr.usedSeconds;assert.equal(chargedBefore,2);
    const audioFile=path.join(directory,'sample.webm');
    const generator=spawn(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','libopus',audioFile],{windowsHide:true,stdio:'ignore'});assert.equal((await once(generator,'exit'))[0],0);
    const upload=await fetch(`${base}/api/recordings/${rec.id}/chunks/0`,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/octet-stream','X-Duration-Ms':'2000','X-Needs-Transcription':'true'},body:readFileSync(audioFile)});assert.equal(upload.status,200);
    const finish=await request(`/recordings/${rec.id}/finish`,{cookie,method:'POST',body:{chunks:1,needsTranscription:true}});assert.equal(finish.status,200);
    const complete=await waitState(rec.id,cookie,'completed');assert.equal(complete.transcription_needed,0);
    const segments=db.prepare('SELECT * FROM segments WHERE recording_id=? ORDER BY start_ms').all(rec.id);assert.ok(segments.length);assert.ok(segments.every(s=>s.id!=='original'));assert.ok(segments.at(-1).text.includes('完整尾字'));
    assert.equal(db.prepare('SELECT snapshot FROM conversations WHERE id=?').get(conversation.id).snapshot,JSON.stringify(conversation.snapshot));
    const used=(await(await request('/usage',{cookie})).json()).asr.usedSeconds;assert.equal(used,Math.ceil(complete.transcription_processed_ms/1000));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM asr_usage').get().n,2,'实时与后台各一条用量记录，不逐秒新增行');
    assert.equal((await request(`/recordings/${rec.id}/transcribe`,{cookie:other,method:'POST'})).status,404);
    const beforeFailure=JSON.stringify(segments);mode='fail';
    assert.equal((await request(`/recordings/${rec.id}/transcribe`,{cookie,method:'POST'})).status,202);
    const failed=await waitState(rec.id,cookie,'failed');assert.match(failed.transcription_error,/已有转写已保留/);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM segments WHERE recording_id=? ORDER BY start_ms').all(rec.id)),beforeFailure);
    assert.equal((await(await request('/usage',{cookie})).json()).asr.usedSeconds,used);
    mode='ok';assert.equal((await request(`/recordings/${rec.id}/transcribe`,{cookie,method:'POST'})).status,202);await waitState(rec.id,cookie,'completed');
    assert.equal((await(await request('/usage',{cookie})).json()).asr.usedSeconds,used);assert.ok(requests>4);
    const normal=await(await request(`/lessons/${lesson.id}/recordings`,{cookie,method:'POST',body:{mime:'audio/webm'}})).json();
    assert.equal((await fetch(`${base}/api/recordings/${normal.id}/chunks/0`,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/octet-stream','X-Duration-Ms':'2000'},body:readFileSync(audioFile)})).status,200);
    mode='delay-final';
    const socket=new WebSocket(`ws://127.0.0.1:${port}/api/asr?recordingId=${normal.id}`,{headers:{Cookie:cookie,Origin:base}}),ended=once(socket,'close');
    socket.on('message',raw=>{if(JSON.parse(raw).type==='ready'){socket.send(Buffer.alloc(64000));socket.send(JSON.stringify({type:'finish'}));}});
    for(let i=0;i<100&&!tailPending;i++)await delay(10);assert.ok(tailPending,'模拟GPU最后定稿仍在处理中');
    assert.equal((await request(`/recordings/${normal.id}/interrupt`,{cookie,method:'POST',body:{chunks:1}})).status,200);
    assert.equal((await request(`/recordings/${normal.id}/finish`,{cookie,method:'POST',body:{chunks:1}})).status,200);await ended;
    const normalState=await state(normal.id,cookie);assert.equal(normalState.transcription_needed,0);assert.equal(normalState.transcription_status,'idle','正常尾段不会因HTTP停止而截断并误触发全课重转');
    assert.ok(db.prepare('SELECT text FROM segments WHERE recording_id=?').all(normal.id).some(s=>s.text==='完整尾字'));
    mode='ok';
    const limited=await(await request(`/lessons/${lesson.id}/recordings`,{cookie,method:'POST',body:{mime:'audio/webm'}})).json();
    db.prepare('UPDATE asr_global_usage SET seconds=30 WHERE day=?').run(new Date().toISOString().slice(0,10));
    assert.equal((await fetch(`${base}/api/recordings/${limited.id}/chunks/0`,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/octet-stream','X-Duration-Ms':'2000'},body:readFileSync(audioFile)})).status,200);
    assert.equal((await request(`/recordings/${limited.id}/finish`,{cookie,method:'POST',body:{chunks:1}})).status,200);
    const blocked=await waitState(limited.id,cookie,'blocked');assert.ok(Date.parse(blocked.transcription_retry_at)>Date.now());assert.equal(blocked.transcription_charged_ms,0);
    // 模拟跨日额度恢复及服务重启；保存的待补任务不能只留在内存。
    const yesterday=new Date(Date.now()-86400000).toISOString();
    db.prepare('UPDATE asr_usage SET created_at=?').run(yesterday);db.prepare('UPDATE asr_global_usage SET seconds=0 WHERE day=?').run(new Date().toISOString().slice(0,10));
    db.prepare('UPDATE recordings SET transcription_retry_at=? WHERE id=?').run(yesterday,limited.id);
    const stopped=once(child,'exit');child.kill();await stopped;await startApp();
    const resumed=await waitState(limited.id,cookie,'completed');assert.equal(resumed.transcription_needed,0);
    assert.equal((await request(`/lessons/${lesson.id}`,{cookie,method:'DELETE'})).status,200);
  }finally{
    if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
    db?.close();await new Promise(resolve=>mock.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));rmSync(directory,{recursive:true,force:true});
  }
});
