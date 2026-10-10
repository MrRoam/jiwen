import {DatabaseSync} from 'node:sqlite';
import {createAccountFetch} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import ffmpeg from 'ffmpeg-static';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('一次性体验：最后两秒耗尽后不连接供应商，仍可新录音、保存、回放与删除，账号隔离',{timeout:30000},async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-audio-quota-')),port=await freePort(),base=`http://127.0.0.1:${port}`;
  const fetch=createAccountFetch(directory);
  let providerBytes=0,providerConnections=0,child,logs='';
  const mock=createServer(),upstream=new WebSocketServer({server:mock}),clients=new Set();
  upstream.on('connection',ws=>{
    providerConnections++;
    ws.on('message',(data,binary)=>{
      if(binary){providerBytes+=data.length;return;}
      const message=JSON.parse(data);
      if(message.header.action==='run-task')ws.send(JSON.stringify({header:{event:'task-started'}}));
      if(message.header.action==='finish-task')ws.send(JSON.stringify({header:{event:'task-finished'}}));
    });
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const request=(route,{cookie,method='GET',body}={})=>fetch(base+'/api'+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  async function register(email){const result=await request('/auth/register',{method:'POST',body:{email,password:'test-password123'}});assert.equal(result.status,200);return result.headers.get('set-cookie').split(';')[0];}
  async function createRecording(cookie){const lesson=await(await request('/lessons',{cookie,method:'POST',body:{title:'额度测试'}})).json();const response=await request(`/lessons/${lesson.id}/recordings`,{cookie,method:'POST',body:{mime:'audio/webm'}});const recording=await response.json();assert.equal(response.status,200,JSON.stringify(recording));assert.ok(recording.id);return {lesson,recording};}
  async function transcribe(cookie,rid,packets,finish=false){
    const events=[];
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(`ws://127.0.0.1:${port}/api/asr?recordingId=${rid}`,{headers:{Cookie:cookie,Origin:base}});clients.add(ws);
      ws.on('error',reject);ws.on('message',raw=>{const event=JSON.parse(raw);events.push(event);if(event.type==='ready'){for(let i=0;i<packets;i++)ws.send(Buffer.alloc(32000));if(finish)ws.send(JSON.stringify({type:'finish'}));}});ws.on('close',()=>{clients.delete(ws);resolve();});
    });
    return events;
  }
  try{
    child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,DATA_DIR:directory,PORT:String(port),HOST:'127.0.0.1',SECURE_COOKIE:'false',MIN_FREE_DISK_BYTES:'1',ADMIN_EMAIL:'',ASR_PROVIDER:'remote',ASR_MODEL:'fun-asr-realtime',ASR_WS_URL:`ws://127.0.0.1:${mock.address().port}`,DASHSCOPE_API_KEY:'quota-test-only',LLM_API_KEY:'',OPENROUTER_API_KEY:'',LLM_ROUTING:'qwen-only',JEV_ENABLED:'false',MONTHLY_AUDIO_SECONDS:'2',ASR_QUOTA_MODE:'trial',LOCAL_ASR_RECOVERY:'false'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/me')).ok){ready=true;break;}}catch{}await delay(50);}assert.ok(ready,logs);
    assert.equal((await request('/usage')).status,401);
    const a=await register('quota-a@example.test'),b=await register('quota-b@example.test');
    const seeded=new DatabaseSync(path.join(directory,'classroom.sqlite'));
    try{seeded.exec('UPDATE account_audio_allowance SET used_seconds=3598');}finally{seeded.close();}
    const config=(await(await request('/me')).json()).config;assert.equal(config.asrQuotaMode,'trial');assert.equal(config.trialAudioSeconds,3600);
    const first=await createRecording(a);
    const events=await transcribe(a,first.recording.id,3);
    assert.equal(events.filter(event=>event.code==='quota_exhausted').length,1);
    assert.equal(providerBytes,64000);assert.equal(providerConnections,1);
    const usage=await(await request('/usage',{cookie:a})).json();
    assert.equal(usage.asr.usedSeconds,3600);assert.equal(usage.asr.remainingSeconds,0);assert.equal(usage.asr.limitSeconds,3600);assert.equal(usage.asrSeconds,3600);
    assert.equal(usage.asr.resetsAt,null);assert.equal(usage.asr.period,'lifetime');assert.equal(usage.estimatedAsrCost,null,'模拟供应商不能套用百炼价格');
    const audioPath=path.join(directory,'synthetic.webm');
    const generator=spawn(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libopus',audioPath],{windowsHide:true,stdio:'ignore'});
    const [exitCode]=await once(generator,'exit');assert.equal(exitCode,0);
    const upload=await fetch(`${base}/api/recordings/${first.recording.id}/chunks/0`,{method:'PUT',headers:{Cookie:a,'Content-Type':'application/octet-stream','X-Duration-Ms':'3000'},body:readFileSync(audioPath)});assert.equal(upload.status,200);
    const saved=await request(`/recordings/${first.recording.id}/finish`,{cookie:a,method:'POST',body:{chunks:1}});assert.equal(saved.status,200,await saved.text());
    assert.equal((await request(`/recordings/${first.recording.id}/audio`,{cookie:a})).status,200);
    // 不删除已保存的录音，累计录音时长及实际转写额度都已超过月额度。
    const extra=await createRecording(a);assert.ok(extra.recording.maxSeconds>2,'新录音时长只受存储与单段限制');
    assert.equal((await request(`/recordings/${extra.recording.id}/interrupt`,{cookie:a,method:'POST',body:{chunks:0}})).status,200);
    assert.equal((await transcribe(a,extra.recording.id,1))[0].code,'quota_exhausted');
    assert.equal((await(await request(`/recordings/${extra.recording.id}`,{cookie:a})).json()).active,true,'额度耗尽也允许中断录音恢复采集');
    assert.equal(providerConnections,1,'额度耗尽后不向供应商创建新任务');
    const extraUpload=await fetch(`${base}/api/recordings/${extra.recording.id}/chunks/0`,{method:'PUT',headers:{Cookie:a,'Content-Type':'application/octet-stream','X-Duration-Ms':'1000'},body:readFileSync(audioPath)});assert.equal(extraUpload.status,200);
    assert.equal((await request(`/recordings/${extra.recording.id}/finish`,{cookie:a,method:'POST',body:{chunks:1}})).status,200);
    assert.equal((await request(`/recordings/${extra.recording.id}/audio`,{cookie:a})).status,200,'额度耗尽后新录音也能保存和回放');
    assert.equal((await request(`/lessons/${first.lesson.id}`,{cookie:a,method:'DELETE'})).status,200);
    assert.equal((await(await request('/usage',{cookie:a})).json()).asr.remainingSeconds,0);
    const next=await createRecording(a),blocked=await transcribe(a,next.recording.id,1);
    assert.equal(blocked[0].code,'quota_exhausted');assert.equal(providerConnections,1);assert.equal(providerBytes,64000);
    const other=await createRecording(b);await transcribe(b,other.recording.id,1,true);
    assert.equal(providerConnections,2);assert.equal(providerBytes,96000);
    assert.equal((await(await request('/usage',{cookie:b})).json()).asr.remainingSeconds,1);
  }finally{
    for(const ws of clients)ws.terminate();
    if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
    for(const ws of upstream.clients)ws.terminate();await new Promise(resolve=>upstream.close(resolve));await new Promise(resolve=>mock.close(resolve));
    const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep));rmSync(resolved,{recursive:true,force:true});
  }
});
