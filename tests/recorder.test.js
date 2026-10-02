import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomRecorder} from '../src/recorder.js';

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
