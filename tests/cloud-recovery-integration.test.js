import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ffmpeg from 'ffmpeg-static';
import {createAccountFetch} from './legal-fixture.js';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test('云端实时模式保留本机缺段补写，旧政策版本不阻断补写且重试不重复扣额',{timeout:45000},async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-cloud-recovery-'));
  const legalFetch=createAccountFetch(directory);
  const port=await freePort(),base=`http://127.0.0.1:${port}`,streams=new Map();
  let child,db,logs='',recognitions=0;
  const mock=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/health')return res.end(JSON.stringify({ready:true,streaming:true,chunkSeconds:.6}));
    if(req.method==='DELETE'){streams.delete(req.url.split('/').at(-1));return res.end('{}');}
    assert.equal(req.url,'/transcribe','后台只调用本机音频接口');
    let length=0;for await(const buffer of req)length+=buffer.length;
    const stream=req.headers['x-asr-stream'],start=streams.get(stream)||0,end=start+length/32000;
    streams.set(stream,end);recognitions++;
    res.end(JSON.stringify({timeline:'stream',segments:[{start,end,text:req.headers['x-asr-final']==='1'?'后台尾字':'后台补齐文字'}]}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const request=(route,{cookie,method='GET',body}={})=>legalFetch(base+'/api'+route,{method,
    headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined});
  async function register(email){
    const response=await request('/auth/register',{method:'POST',body:{email,password:'hybrid-test123'}});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function state(recordingId,cookie){return(await request(`/recordings/${recordingId}`,{cookie})).json();}
  async function waitState(recordingId,cookie,expected){
    for(let i=0;i<300;i++){
      const row=await state(recordingId,cookie);
      if(row.transcription_status===expected)return row;
      await delay(20);
    }
    assert.fail(`补转写没有进入 ${expected}：${JSON.stringify(await state(recordingId,cookie))}`);
  }
  async function savedRecording(cookie,title,audio){
    const lessonResponse=await request('/lessons',{cookie,method:'POST',body:{title}});
    assert.equal(lessonResponse.status,200);
    const lesson=await lessonResponse.json();
    const recordingResponse=await request(`/lessons/${lesson.id}/recordings`,{cookie,method:'POST',body:{mime:'audio/webm'}});
    assert.equal(recordingResponse.status,200);
    const recording=await recordingResponse.json();
    const upload=await globalThis.fetch(`${base}/api/recordings/${recording.id}/chunks/0`,{method:'PUT',
      headers:{Cookie:cookie,'Content-Type':'application/octet-stream','X-Duration-Ms':'1200','X-Needs-Transcription':'true'},body:audio});
    assert.equal(upload.status,200);
    const finish=await request(`/recordings/${recording.id}/finish`,{cookie,method:'POST',body:{chunks:1,needsTranscription:true}});
    assert.equal(finish.status,200);
    await waitState(recording.id,cookie,'completed');
    return recording;
  }
  try{
    child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,JIWEN_MODE:'hosted',
      DATA_DIR:directory,PORT:String(port),HOST:'127.0.0.1',SECURE_COOKIE:'false',ADMIN_EMAIL:'',
      ASR_PROVIDER:'remote',ASR_MODEL:'fun-asr-realtime',ASR_WS_URL:'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      LOCAL_ASR_RECOVERY:'true',LOCAL_ASR_URL:`http://127.0.0.1:${mock.address().port}`,
      DASHSCOPE_API_KEY:'',LLM_API_KEY:'',OPENROUTER_API_KEY:'',LLM_ROUTING:'qwen-only',JEV_ENABLED:'false',
      SMTP_USER:'',SMTP_PASS:'',MONTHLY_AUDIO_SECONDS:'30',GLOBAL_DAILY_ASR_SECONDS:'30',MIN_FREE_DISK_BYTES:'1'},
      stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',value=>logs+=value);child.stderr.on('data',value=>logs+=value);
    let ready=false;
    for(let i=0;i<100;i++){try{if((await globalThis.fetch(base+'/api/me')).ok){ready=true;break;}}catch{}await delay(30);}
    assert.ok(ready,logs);
    const config=(await(await request('/me')).json()).config;
    assert.equal(config.asrProvider,'remote');
    assert.equal(config.asrModel,'fun-asr-realtime');
    assert.ok(config.legal.providers.some(provider=>provider.service==='asr'&&provider.name==='阿里云百炼'));
    assert.ok(config.legal.providers.some(provider=>provider.service==='asr'&&/本地/.test(provider.name)),'录音确认同时披露本机补写');
    const owner=await register('hybrid-owner@example.test'),other=await register('hybrid-other@example.test');
    const file=path.join(directory,'synthetic.webm');
    const generator=spawn(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=1.2','-c:a','libopus',file],{windowsHide:true,stdio:'ignore'});
    assert.equal((await once(generator,'exit'))[0],0);
    const audio=readFileSync(file);
    // 保持另一个账号录音，不结束它也必须能完成本机补写。
    const busyLesson=await(await request('/lessons',{cookie:other,method:'POST',body:{title:'持续云端录音'}})).json();
    const busyRecording=await(await request(`/lessons/${busyLesson.id}/recordings`,{cookie:other,method:'POST',body:{mime:'audio/webm'}})).json();
    assert.ok(busyRecording.id);
    const ownerRecording=await savedRecording(owner,'云实时与本机补写',audio);
    assert.equal((await state(busyRecording.id,other)).status,'recording','另一个账号仍录音时补写已完成');
    assert.equal((await request(`/recordings/${busyRecording.id}/cancel`,{cookie:other,method:'POST'})).status,200);
    const otherRecording=await savedRecording(other,'其他账号课堂',audio);
    db=new DatabaseSync(path.join(directory,'classroom.sqlite'));
    assert.ok(db.prepare('SELECT text FROM segments WHERE recording_id=?').all(ownerRecording.id).some(row=>row.text.includes('后台尾字')));
    const before=(await(await request('/usage',{cookie:owner})).json());
    assert.equal(before.estimatedAsrCost,null,'混合历史额度不能冒充实际云费用');
    assert.ok(before.asr.usedSeconds>0);
    const costsBefore=db.prepare("SELECT SUM(units) seconds,SUM(cny) cny FROM cost_usage WHERE service='asr'").get();
    assert.ok(costsBefore.seconds>0);assert.equal(costsBefore.cny,0,'云端模式下的本机补写只扣时长，不计云 API 费用');
    assert.equal((await request(`/recordings/${ownerRecording.id}/transcribe`,{cookie:owner,method:'POST'})).status,202);
    await waitState(ownerRecording.id,owner,'completed');
    assert.equal((await(await request('/usage',{cookie:owner})).json()).asr.usedSeconds,before.asr.usedSeconds,'同一段本机重试不重复扣额');
    assert.equal((await request(`/recordings/${ownerRecording.id}/transcribe`,{cookie:other,method:'POST'})).status,404);

    // 旧版本记录不再阻断自动或手动补写，也不改变账号隔离。
    db.prepare("UPDATE legal_consents SET version='previous-provider-version'").run();
    const previousRequests=recognitions;
    for(const [recording,cookie] of [[ownerRecording,owner],[otherRecording,other]]){
      assert.equal((await request(`/recordings/${recording.id}/transcription-gap`,{cookie,method:'POST'})).status,200);
      const restored=await waitState(recording.id,cookie,'completed');
      assert.equal(restored.transcription_needed,0);
    }
    assert.ok(recognitions>previousRequests,'无需重签政策即可自动补写');
    assert.equal((await request(`/recordings/${ownerRecording.id}/transcribe`,{cookie:owner,method:'POST'})).status,202);
    await waitState(ownerRecording.id,owner,'completed');
    assert.equal((await request(`/recordings/${ownerRecording.id}/transcribe`,{cookie:other,method:'POST'})).status,404);
    // 之前因政策确认停住的任务，在账号加载时恢复，不伪造新版同意记录。
    db.prepare("UPDATE recordings SET transcription_needed=1,transcription_status='blocked',transcription_retry_at='' WHERE id=?").run(ownerRecording.id);
    const me=await(await request('/me',{cookie:owner})).json();
    assert.equal(me.user.legalVersion,null);
    await waitState(ownerRecording.id,owner,'completed');
    assert.equal((await(await request('/usage',{cookie:owner})).json()).asr.usedSeconds,before.asr.usedSeconds);
    const costsAfter=db.prepare("SELECT SUM(units) seconds,SUM(cny) cny FROM cost_usage WHERE service='asr'").get();
    assert.deepEqual(costsAfter,costsBefore,'补写重试不重复增加匿名成本记录');
  }finally{
    if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
    db?.close();await new Promise(resolve=>mock.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));
    rmSync(directory,{recursive:true,force:true});
  }
});
