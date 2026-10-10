import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {paraformer,streamAnswer,testService} from '../server/providers.js';
import {createASRStartQueue} from '../server/asr-start-queue.js';

test('取消排队中的连接测试不创建云任务，也不会占住启动队列',async()=>{
  const queue=createASRStartQueue({startsPerSecond:1});
  queue.create(()=>({send:()=>true,finish(){},close(){}}),assert.fail);
  const controller=new AbortController();let created=0;
  const result=testService({service:'asr',key:'test-only',signal:controller.signal,createASR:options=>queue.create(()=>{created++;return paraformer(options);},options.onError)});
  controller.abort();const checked=await result;assert.equal(checked.ok,false);assert.match(checked.message,/取消/);assert.equal(created,0);queue.close();
});

test('Paraformer 遵循启动、音频、结束协议，并等待最后一句',async()=>{
  const server=createServer(),wss=new WebSocketServer({server});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`ws://127.0.0.1:${server.address().port}`;let run,finish,binary;
  wss.on('connection',(ws,req)=>{assert.equal(req.headers.authorization,'Bearer test-only');ws.on('message',(data,isBinary)=>{if(isBinary){binary=data;return;}const message=JSON.parse(data);if(message.header.action==='run-task'){run=message;ws.send(JSON.stringify({header:{event:'task-started'}}));}if(message.header.action==='finish-task'){finish=message;ws.send(JSON.stringify({header:{event:'result-generated'},payload:{output:{sentence:{begin_time:0,end_time:200,text:'最后一句',sentence_end:true}},usage:{duration:1}}}));ws.send(JSON.stringify({header:{event:'task-finished'}}));}});});
  const sentences=[];
  try{await new Promise((resolve,reject)=>{const provider=paraformer({key:'test-only',url,model:'paraformer-realtime-v2',onReady:()=>{provider.send(Buffer.alloc(6400));provider.finish();},onSentence:s=>sentences.push(s),onUsage:()=>{},onError:reject,onFinish:resolve});});assert.equal(run.payload.parameters.sample_rate,16000);assert.equal(run.payload.parameters.format,'pcm');assert.equal(run.payload.parameters.heartbeat,true);assert.equal(run.header.task_id,finish.header.task_id);assert.equal(binary.length,6400);assert.equal(sentences[0].text,'最后一句');}finally{wss.clients.forEach(c=>c.terminate());await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});

test('Fun-ASR 静音心跳默认开启，断连时保留关闭码用于诊断',async()=>{
  const server=createServer(),wss=new WebSocketServer({server});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let parameters,diagnostic;
  wss.on('connection',ws=>ws.on('message',(data,isBinary)=>{if(isBinary)return;const message=JSON.parse(data);parameters=message.payload.parameters;ws.send(JSON.stringify({header:{event:'task-started'}}));ws.close(4001,'upstream-test');}));
  try{await new Promise(resolve=>{paraformer({key:'test-only',url:`ws://127.0.0.1:${server.address().port}`,model:'fun-asr-realtime',onReady:()=>{},onSentence:()=>{},onUsage:()=>{},onError:(_message,detail)=>{diagnostic=detail;resolve();},onFinish:()=>{}});});assert.equal(parameters.heartbeat,true);assert.deepEqual(diagnostic,{event:'socket-close',code:4001,reason:'upstream-test'});}
  finally{wss.clients.forEach(c=>c.terminate());await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});

test('问答读取跨网络分块的 SSE 并保留中文',async()=>{
  let request;const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;request=JSON.parse(raw);res.setHeader('Content-Type','text/event-stream');const data=Buffer.from('data: {"choices":[{"delta":{"content":"课堂回答"}}]}\n\ndata: [DONE]\n\n');res.write(data.subarray(0,49));setTimeout(()=>res.end(data.subarray(49)),10);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let result='';try{await streamAnswer({key:'test-only',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'mock',messages:[{role:'user',content:'测试'}],signal:AbortSignal.timeout(3000),onText:t=>result+=t});assert.equal(result,'课堂回答');assert.equal(request.stream,true);assert.equal(request.enable_thinking,false);}finally{await new Promise(r=>server.close(r));}
});

test('流式回答未收到结束标记时报告中断，不伪装完整回答',async()=>{
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"半截回答"}}]}\n\n');});await new Promise(r=>server.listen(0,'127.0.0.1',r));let partial='';try{await assert.rejects(streamAnswer({key:'test',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'mock',messages:[],signal:AbortSignal.timeout(3000),onText:t=>partial+=t}),/提前断开/);assert.equal(partial,'半截回答');}finally{await new Promise(r=>server.close(r));}
});

test('上游在结束块报告 token 用量时能够记录，未返回时不伪造',async()=>{
 const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"回答"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":22,"completion_tokens":8}}\n\ndata: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let usage;
 try{await streamAnswer({key:'test',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'mock',messages:[],onText:()=>{},onUsage:value=>usage=value});assert.deepEqual(usage,{prompt_tokens:22,completion_tokens:8});}finally{await new Promise(r=>server.close(r));}
});

test('限额错误保留状态码供路由判断，HTTP Retry-After 可读取',async()=>{
 const server=createServer((req,res)=>{res.writeHead(429,{'Retry-After':'120'});res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(streamAnswer({key:'test',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'mock',messages:[],onText:()=>{}}),error=>error.status===429&&error.retryAfterMs===120000);}finally{await new Promise(r=>server.close(r));}
});
test('SSE 内的额度错误也保留状态码',async()=>{
 const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"error":{"code":429,"message":"limited"}}\n\n');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(streamAnswer({key:'test',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'mock',messages:[],onText:()=>{}}),error=>error.status===429);}finally{await new Promise(r=>server.close(r));}
});
