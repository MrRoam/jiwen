import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createTranscriptionRecovery,decodeRecordingPCM} from '../server/transcription-recovery.js';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE lessons(id TEXT PRIMARY KEY,user_id TEXT NOT NULL);
    CREATE TABLE recordings(id TEXT PRIMARY KEY,lesson_id TEXT REFERENCES lessons(id),offset_ms INTEGER,duration_ms INTEGER,status TEXT);
    CREATE TABLE segments(id TEXT PRIMARY KEY,lesson_id TEXT REFERENCES lessons(id),recording_id TEXT REFERENCES recordings(id),start_ms INTEGER,end_ms INTEGER,text TEXT,final INTEGER);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,snapshot TEXT);
    INSERT INTO lessons VALUES('lesson','owner');
    INSERT INTO recordings VALUES('first','lesson',12000,1300,'ready'),('second','lesson',13300,1300,'ready');
    INSERT INTO segments VALUES('old-first','lesson','first',12000,13300,'已有课堂文字',1),('old-second','lesson','second',13300,14600,'另一次录音',1);
    INSERT INTO conversations VALUES('frozen','{"segments":[{"id":"old-first","text":"已有课堂文字"}]}');`);
  return db;
}
function mockService({respond,streaming=true}={}){
  const calls=[],released=[],offsets=new Map();
  return {calls,released,request:async(url,options={})=>{
    if(url.endsWith('/health'))return Response.json({ready:true,streaming,chunkSeconds:.6});
    if(options.method==='DELETE'){released.push(url);return Response.json({});}
    const stream=options.headers['X-ASR-Stream'],sequence=Number(options.headers['X-ASR-Sequence']),start=offsets.get(stream)||0;
    const end=start+options.body.length/32000;offsets.set(stream,end);
    const call={stream,sequence,bytes:options.body.length,final:options.headers['X-ASR-Final'],start,end,signal:options.signal};calls.push(call);
    if(respond)return await respond(call);
    return Response.json({timeline:'stream',segments:call.bytes?[{start,end,text:`恢复文字${sequence}`}]:[]});
  }};
}
async function* pcm(_file,{signal}){for(let left=41600;left>0;left-=4000){signal.throwIfAborted();yield Buffer.alloc(Math.min(left,4000));}}
function make(db,service,options={}){return createTranscriptionRecovery({db,dataDir:tmpdir(),getUrl:()=> 'http://127.0.0.1:9999',decode:pcm,request:service.request,pollMs:10000,...options});}
async function until(check){for(let i=0;i<200&&!check();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(check(),'预期状态未出现');}
function texts(db,rid){return db.prepare('SELECT text FROM segments WHERE recording_id=? ORDER BY start_ms').all(rid).map(row=>row.text);}

test('完整录音补转写包含尾段，保留课堂 offset、另一段录音和冻结对话，提交时申请保存预算',async()=>{
  const db=fixture(),service=mockService(),charges=[],reservations=[];let releases=0;
  const queue=make(db,service,{chargeThrough:(row,ms)=>charges.push([row.id,ms]),reserveText:(row,bytes)=>{reservations.push({id:row.id,bytes});return {release(){releases++;}};}});
  const snapshot=db.prepare('SELECT snapshot FROM conversations').get().snapshot;
  try{
    queue.enqueue('first');await queue.idle();
    assert.equal(queue.status('first').state,'completed');
    assert.deepEqual(service.calls.map(call=>[call.bytes,call.final]),[[19200,'0'],[19200,'0'],[3200,'1']]);
    assert.deepEqual(service.calls.map(call=>call.sequence),[0,1,2]);assert.equal(new Set(service.calls.map(call=>call.stream)).size,1);
    assert.deepEqual(charges,[['first',600],['first',1200],['first',1300]]);
    assert.deepEqual(db.prepare('SELECT start_ms,end_ms FROM segments WHERE recording_id=? ORDER BY start_ms').all('first').map(row=>[row.start_ms,row.end_ms]),[[12000,12600],[12600,13200],[13200,13300]]);
    assert.deepEqual(texts(db,'second'),['另一次录音']);assert.equal(db.prepare('SELECT snapshot FROM conversations').get().snapshot,snapshot);
    assert.equal(service.released.length,1);assert.equal(reservations.length,1);assert.ok(reservations[0].bytes>3*128);assert.equal(releases,1);
  }finally{await queue.close();db.close();}
});

test('FIFO 去重，两个任务使用独立缓存；完成任务只在显式强制时重跑',async()=>{
  const db=fixture(),service=mockService(),order=[];let runAllowed=false;
  const queue=make(db,service,{canRun:()=>runAllowed,onState:(id,state)=>{if(state.state==='completed')order.push(id);}});
  try{
    queue.enqueue('first');queue.enqueue('first');queue.enqueue('second');assert.equal(service.calls.length,0);
    runAllowed=true;queue.notify();await queue.idle();assert.deepEqual(order,['first','second']);
    assert.equal(new Set(service.calls.map(call=>call.stream)).size,2);
    queue.enqueue('first');await queue.idle();assert.equal(service.calls.length,6);
    queue.enqueue('first',{force:true});await queue.idle();assert.equal(service.calls.length,9);
  }finally{await queue.close();db.close();}
});

test('等待队列达到上限明确返回503，已有任务去重不占新位置，取消后释放位置',async()=>{
  const db=fixture(),service=mockService();
  const queue=make(db,service,{canRun:()=>false,maxQueued:2,maxStates:2});
  try{
    queue.enqueue('first');queue.enqueue('second');assert.equal(queue.enqueue('first').state,'queued');
    assert.throws(()=>queue.enqueue('third'),error=>error.status===503&&error.code==='recovery_queue_full');assert.equal(queue.status('third'),null);
    queue.cancel('second');assert.equal(queue.enqueue('third').state,'queued');assert.equal(service.calls.length,0);
  }finally{await queue.close();db.close();}
});

test('终态缓存有界，淘汰后仍通过持久状态去重已完成录音',async()=>{
  const db=fixture(),service=mockService();
  db.exec("ALTER TABLE recordings ADD COLUMN transcription_status TEXT DEFAULT 'idle'; ALTER TABLE recordings ADD COLUMN transcription_needed INTEGER DEFAULT 0; ALTER TABLE recordings ADD COLUMN transcription_processed_ms INTEGER DEFAULT 0; ALTER TABLE recordings ADD COLUMN transcription_error TEXT DEFAULT '';");
  const queue=make(db,service,{maxQueued:2,maxStates:2,onState:(id,state)=>db.prepare('UPDATE recordings SET transcription_status=?,transcription_processed_ms=? WHERE id=?').run(state.state,state.processedMs||0,id)});
  try{
    queue.enqueue('first');await queue.idle();queue.enqueue('second');await queue.idle();
    for(let i=0;i<8;i++){queue.enqueue(`absent-${i}`);await queue.idle();}
    assert.equal(queue.status('first'),null);assert.equal(queue.status('second'),null);
    assert.equal(queue.status('absent-0'),null);assert.equal(queue.status('absent-7').state,'failed');assert.equal(queue.status('absent-6').state,'failed');
    const count=service.calls.length;assert.equal(queue.enqueue('first').state,'completed');await queue.idle();assert.equal(service.calls.length,count);
  }finally{await queue.close();db.close();}
});

test('本地服务中途故障保留旧文字和旧对话，不提交部分识别结果',async()=>{
  const db=fixture(),service=mockService({respond:call=>{if(call.sequence===1)throw Error('service stopped');return Response.json({timeline:'stream',segments:[{start:0,end:.6,text:'尚未完整的结果'}]});}});
  const queue=make(db,service);
  try{queue.enqueue('first');await queue.idle();assert.equal(queue.status('first').state,'failed');assert.deepEqual(texts(db,'first'),['已有课堂文字']);assert.equal(service.released.length,1);}
  finally{await queue.close();db.close();}
});

test('本地处理超时会结束任务并关闭独立缓存，不把旧文换成半段文字',async()=>{
  const db=fixture(),service=mockService({respond:call=>new Promise((_resolve,reject)=>call.signal.addEventListener('abort',()=>reject(call.signal.reason),{once:true}))});
  const queue=make(db,service,{requestTimeoutMs:20});
  // AbortSignal.timeout 的计时器不维持进程，此等待也覆盖真实后台状态完成。
  try{queue.enqueue('first');await until(()=>queue.status('first')?.state==='failed');assert.match(queue.status('first').error,/处理超时/);assert.equal(service.released.length,1);assert.deepEqual(texts(db,'first'),['已有课堂文字']);}
  finally{await queue.close();db.close();}
});

test('额度阻断不发送超额音频，重试按累计处理位置记账，不重复扣已经处理的时长',async()=>{
  const db=fixture(),service=mockService();let credited=0,quota=600;
  const queue=make(db,service,{chargeThrough:(_row,end)=>{const delta=Math.max(0,end-credited);if(delta>quota)throw Object.assign(Error('全站今日转写额度已用完。'),{code:'quota_exhausted',status:429});quota-=delta;credited=Math.max(credited,end);}});
  try{
    queue.enqueue('first');await queue.idle();assert.equal(queue.status('first').state,'blocked');assert.equal(service.calls.length,1);assert.equal(credited,600);assert.deepEqual(texts(db,'first'),['已有课堂文字']);
    quota=700;queue.enqueue('first');await queue.idle();assert.equal(queue.status('first').state,'completed');assert.equal(credited,1300);assert.equal(quota,0);
  }finally{await queue.close();db.close();}
});

test('实时采集抢占后台任务，关闭请求和解码流，随后从队首恢复且旧文在完成前不改变',async()=>{
  const db=fixture();let realtime=false,firstRequest=true,decoderClosed=0;
  const service=mockService({respond:call=>{
    if(firstRequest){firstRequest=false;return new Promise((_resolve,reject)=>call.signal.addEventListener('abort',()=>reject(call.signal.reason),{once:true}));}
    return Response.json({timeline:'stream',segments:call.bytes?[{start:call.start,end:call.end,text:'补回内容'}]:[]});
  }});
  async function* cancellable(file,options){try{yield* pcm(file,options);}finally{decoderClosed++;}}
  const queue=make(db,service,{decode:cancellable,canRun:()=>!realtime});
  try{
    queue.enqueue('first');queue.enqueue('second');await until(()=>service.calls.length===1);realtime=true;queue.notify();await until(()=>!queue.busy());
    assert.equal(queue.status('first').state,'queued');assert.deepEqual(texts(db,'first'),['已有课堂文字']);assert.equal(decoderClosed,1);assert.equal(service.released.length,1);
    realtime=false;queue.notify();await queue.idle();assert.equal(queue.status('first').state,'completed');assert.equal(queue.status('second').state,'completed');
    assert.equal(service.calls[1].sequence,0);assert.notEqual(service.calls[1].stream,service.calls[0].stream);
  }finally{await queue.close();db.close();}
});

test('取消排队任务不识别；关闭服务保留排队状态，等待运行请求释放',async()=>{
  const db=fixture(),service=mockService({respond:call=>new Promise((_resolve,reject)=>call.signal.addEventListener('abort',()=>reject(call.signal.reason),{once:true}))});
  const queue=make(db,service);
  try{queue.enqueue('first');queue.enqueue('second');queue.cancel('second');await until(()=>service.calls.length===1);await queue.close();assert.equal(queue.status('first').state,'queued');assert.equal(queue.status('second'),null);assert.equal(service.calls.length,1);assert.equal(service.released.length,1);assert.deepEqual(texts(db,'first'),['已有课堂文字']);}
  finally{await queue.close();db.close();}
});

test('保存预算不足、重叠结果及事务失败都保留已有文字',async t=>{
  for(const kind of ['storage','overlap','transaction'])await t.test(kind,async()=>{
    const db=fixture();const service=mockService(kind==='overlap'?{respond:call=>Response.json({timeline:'stream',segments:call.bytes?[{start:0,end:call.end,text:`不同文字${call.sequence}`}]:[]})}:{});
    const queue=make(db,service,kind==='storage'?{reserveText:()=>{throw Object.assign(Error('保存空间不足。'),{code:'storage_limit'});}}:kind==='transaction'?{onComplete:()=>{throw Error('transaction failed');}}:{});
    try{queue.enqueue('first');await queue.idle();assert.equal(queue.status('first').state,kind==='storage'?'blocked':'failed');assert.deepEqual(texts(db,'first'),['已有课堂文字']);}
    finally{await queue.close();db.close();}
  });
});

test('完成状态写入失败会与文字替换一起回滚，避免结果与持久任务状态分离',async()=>{
  const db=fixture(),service=mockService();db.exec("ALTER TABLE recordings ADD COLUMN transcription_status TEXT DEFAULT 'idle'");
  const queue=make(db,service,{onState:(id,state)=>{db.prepare('UPDATE recordings SET transcription_status=? WHERE id=?').run(state.state,id);if(state.state==='completed')throw Error('completion state failed');}});
  try{queue.enqueue('first');await queue.idle();assert.deepEqual(texts(db,'first'),['已有课堂文字']);assert.equal(db.prepare('SELECT transcription_status FROM recordings WHERE id=?').get('first').transcription_status,'failed');assert.equal(queue.status('first').state,'failed');}
  finally{await queue.close();db.close();}
});

test('静音结果不能清空旧文；整段对齐仍提交空 final 尾段',async()=>{
  const db=fixture();db.prepare('UPDATE recordings SET duration_ms=1200 WHERE id=?').run('first');
  const service=mockService({respond:()=>Response.json({segments:[]})});
  async function* exact(){yield Buffer.alloc(38400);}
  const queue=make(db,service,{decode:exact});
  try{queue.enqueue('first');await queue.idle();assert.equal(queue.status('first').state,'failed');assert.deepEqual(service.calls.map(call=>[call.bytes,call.final]),[[19200,'0'],[19200,'0'],[0,'1']]);assert.deepEqual(texts(db,'first'),['已有课堂文字']);}
  finally{await queue.close();db.close();}
});

test('FFmpeg 实际解码 WAV 为 16 kHz 单声道 PCM，并拒绝损坏录音',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'jiwen-recovery-')),file=path.join(dir,'sample.wav');
  const header=Buffer.alloc(44),samples=16000;
  header.write('RIFF',0);header.writeUInt32LE(36+samples*2,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(samples*2,40);
  writeFileSync(file,Buffer.concat([header,Buffer.alloc(samples*2)]));
  try{
    let bytes=0;for await(const buffer of decodeRecordingPCM(file,{signal:new AbortController().signal}))bytes+=buffer.length;assert.equal(bytes,32000);
    writeFileSync(file,'broken');await assert.rejects(async()=>{for await(const _ of decodeRecordingPCM(file,{signal:new AbortController().signal})){}},/解码失败/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
