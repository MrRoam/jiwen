import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomRecorder,transcriptionPollDelay,transcriptionRecoveryRows} from '../src/recorder.js';

test('转写额度耗尽后停止重连和缓存，录音仍保持运行',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  class Socket {static OPEN=1;static CONNECTING=0;static instances=[];readyState=1;constructor(){Socket.instances.push(this);}send(){}close(){this.onclose?.();}}
  t.mock.property(globalThis,'WebSocket',Socket);
  const previous=globalThis.location;globalThis.location={protocol:'http:',host:'localhost:4317'};
  t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
  const states=[],recorder=new ClassroomRecorder({onState:s=>states.push(s),onSegment:()=>{}});
  recorder.running=true;recorder.rec={id:'quota-test',asrReady:true};recorder.connectASR();
  const socket=recorder.ws,error='本月转写额度已用完，录音仍会继续保存。';
  recorder.asrReady=true;recorder.asrPending=[new ArrayBuffer(6400)];
  socket.onmessage({data:JSON.stringify({type:'error',code:'quota_exhausted',error})});socket.close();
  recorder.queueASR(new ArrayBuffer(6400));t.mock.timers.tick(60000);recorder.connectASR();
  assert.equal(Socket.instances.length,1);assert.equal(recorder.running,true);assert.equal(recorder.asrReady,false);
  assert.equal(recorder.asrPending.length,0);assert.equal(states.at(-1).asr,error);recorder.cleanup();
});

test('实时片段立即交给界面，服务错误不会被断线提示覆盖',t=>{
  class Socket {static OPEN=1;static CONNECTING=0;readyState=1;sent=[];send(data){this.sent.push(data);} }
  t.mock.property(globalThis,'WebSocket',Socket);
  const previous=globalThis.location;
  globalThis.location={protocol:'http:',host:'localhost:4317'};
  t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
  const states=[],segments=[];
  const recorder=new ClassroomRecorder({onState:s=>states.push(s),onSegment:s=>segments.push(s)});
  recorder.running=true;recorder.rec={id:'test'};recorder.connectASR();
  recorder.sentSamples=6400;recorder.asrPending=[new ArrayBuffer(6400)];recorder.asrPending[0].offsetMs=200;
  recorder.ws.onmessage({data:JSON.stringify({type:'ready'})});
  assert.equal(JSON.parse(recorder.ws.sent[0]).offsetMs,200);assert.equal(JSON.parse(recorder.ws.sent[1]).type,'packet');assert.equal(recorder.ws.sent[2].byteLength,6400);
  recorder.ws.onmessage({data:JSON.stringify({type:'segment',segment:{id:'1',text:'实时识别',final:0}})});
  assert.equal(segments[0].text,'实时识别');assert.equal(recorder.asrReady,true);
  recorder.ws.onmessage({data:JSON.stringify({type:'error',error:'模型权限不足'})});
  recorder.ws.onclose();assert.match(states.at(-1).asr,/模型权限不足；1 秒后自动重连/);assert.equal(recorder.asrReady,false);recorder.cleanup();
});

test('转写意外断开后自动重连并补发断线期间缓存的音频',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  class Socket {static OPEN=1;static CONNECTING=0;static CLOSED=3;static instances=[];readyState=0;sent=[];constructor(){Socket.instances.push(this);}send(data){this.sent.push(data);}close(){this.readyState=3;this.onclose?.();}}
  t.mock.property(globalThis,'WebSocket',Socket);
  const previous=globalThis.location;globalThis.location={protocol:'http:',host:'localhost:4317'};
  t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
  const states=[],recorder=new ClassroomRecorder({onState:s=>states.push(s),onSegment:()=>{}});
  recorder.running=true;recorder.rec={id:'test',asrReady:true};recorder.connectASR();
  const first=Socket.instances[0];first.readyState=1;first.onmessage({data:JSON.stringify({type:'ready'})});first.close();
  const buffered=new ArrayBuffer(6400);buffered.offsetMs=1500;recorder.queueASR(buffered);
  assert.match(states.at(-1).asr,/自动重连/);
  t.mock.timers.tick(1000);assert.equal(Socket.instances.length,2);
  const second=Socket.instances[1];second.readyState=1;second.onmessage({data:JSON.stringify({type:'ready'})});
  assert.equal(JSON.parse(second.sent[0]).offsetMs,1500);
  assert.equal(second.sent[2],buffered);
  assert.equal(recorder.asrReady,true);
  recorder.cleanup();
});

test('超过短缓存的音频缺口只通知一次，通知失败不影响继续录音',async t=>{
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,options});throw new Error('offline');});
  const recorder=new ClassroomRecorder({userId:'gap-user',onState:()=>{}});
  recorder.running=true;recorder.rec={id:'gap-recording',asrReady:true};
  for(let index=0;index<30;index++)recorder.queueASR(new ArrayBuffer(6400));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(recorder.running,true);assert.equal(recorder.needsTranscription,true);assert.equal(recorder.asrDropped,true);
  assert.ok(recorder.asrPending.reduce((total,chunk)=>total+chunk.byteLength,0)<=160000);
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/recordings/gap-recording/transcription-gap');assert.equal(requests[0].options.method,'POST');
  recorder.cleanup();
});

test('尾段尚未完成时 needed 状态持续刷新，转成 completed 后停止刷新',()=>{
  for(const status of ['needed','pending','queued','running'])assert.equal(transcriptionPollDelay([{transcription_status:status}]),2000);
  assert.equal(transcriptionPollDelay([{transcription_status:'completed'}]),null);
  assert.equal(transcriptionPollDelay([{transcription_status:'failed'}]),null);
});

test('额度阻塞等待恢复日期后刷新，到期仍阻塞最多每分钟刷新且长等待不溢出',()=>{
  const at=Date.parse('2026-10-01T12:00:00Z');
  assert.equal(transcriptionPollDelay([{transcription_status:'blocked',transcription_retry_at:'2026-10-01T14:00:00Z'}],at),2*3600000+60000);
  assert.equal(transcriptionPollDelay([{transcription_status:'blocked',transcription_retry_at:'2026-10-01T11:00:00Z'}],at),60000);
  assert.equal(transcriptionPollDelay([{transcription_status:'blocked',transcription_retry_at:'2026-11-01T00:00:00Z'}],at),2147483647);
  assert.equal(transcriptionPollDelay([{transcription_status:'blocked',transcription_retry_at:''}],at),null);
  assert.equal(transcriptionPollDelay([{transcription_status:'blocked',transcription_retry_at:'2026-11-01T00:00:00Z'},{transcription_status:'needed'}],at),2000);
});

test('旧录音缺少文字仍可手动补转写，正常录音及完成的静音录音不增加入口',()=>{
  const lesson={recordings:[{id:'healthy',status:'ready',duration_ms:60000,transcription_status:'idle'},{id:'old-empty',status:'ready',duration_ms:60000,transcription_status:'idle'},{id:'silent-completed',status:'ready',duration_ms:60000,transcription_status:'completed'},{id:'interrupted',status:'interrupted',duration_ms:60000,transcription_status:'idle'},{id:'gap',status:'ready',duration_ms:60000,transcription_status:'needed'}],segments:[{recording_id:'healthy',text:'课堂讲解'},{recording_id:'old-empty',text:'  '}]};
  assert.deepEqual(transcriptionRecoveryRows(lesson).map(row=>row.id),['old-empty','gap']);
});
