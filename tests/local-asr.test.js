import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {localASR,testLocalASR} from '../server/local-asr.js';

test('本地转写顺序处理整段和尾段，时间戳延续且可测试连接',async()=>{
  const lengths=[];
  const server=createServer(async(req,res)=>{if(req.url==='/health')return res.end('{}');let length=0;for await(const chunk of req)length+=chunk.length;lengths.push(length);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({segments:[{start:0,end:length/32000,text:'本地结果'}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`,segments=[];
  try{await new Promise((resolve,reject)=>{const provider=localASR({url,onReady:()=>{provider.send(Buffer.alloc(320000));provider.send(Buffer.alloc(16000));provider.finish();},onSentence:s=>segments.push(s),onUsage:()=>{},onError:reject,onFinish:()=>{provider.close();resolve();}});});
    assert.deepEqual(lengths,[320000,16000]);assert.equal(segments[1].begin_time,10000);assert.equal(segments[1].end_time,10500);assert.equal((await testLocalASR(url)).ok,true);
  }finally{await new Promise(r=>server.close(r));}
});

test('本地服务异常会报告错误，不伪装为已完成',async()=>{
  const server=createServer((req,res)=>{res.writeHead(503);res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const url=`http://127.0.0.1:${server.address().port}`;assert.equal((await testLocalASR(url)).ok,false);
    await new Promise((resolve,reject)=>localASR({url,onReady:()=>reject(new Error('should not be ready')),onError:()=>resolve(),onFinish:()=>reject(new Error('should not finish'))}));
  }finally{await new Promise(r=>server.close(r));}
});

test('流式本地模型按健康信息分段，各路独立序号并发送空尾段刷新缓存',async()=>{
  const calls=[],sentences=[],usage=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='DELETE'){res.end('{}');return;}
    if(req.url==='/health'){res.end(JSON.stringify({ready:true,streaming:true,chunkSeconds:.6,engine:'paraformer-streaming'}));return;}
    let length=0;for await(const chunk of req)length+=chunk.length;
    calls.push({length,stream:req.headers['x-asr-stream'],sequence:req.headers['x-asr-sequence'],final:req.headers['x-asr-final']});
    const n=Number(req.headers['x-asr-sequence']);
    res.end(JSON.stringify({timeline:'stream',segments:n===0?[]:[{text:n===1?'第二段':'尾字',start:0,end:1.2,timing:'chunk-approximation'}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const url=`http://127.0.0.1:${server.address().port}`;
    await new Promise((resolve,reject)=>{
      const provider=localASR({url,onReady:health=>{assert.equal(health.engine,'paraformer-streaming');provider.send(Buffer.alloc(38400));provider.finish();},onSentence:s=>sentences.push(s),onUsage:n=>usage.push(n),onError:reject,onFinish:()=>{provider.close();resolve();}});
    });
    assert.deepEqual(calls.map(c=>c.length),[19200,19200,0]);
    assert.deepEqual(calls.map(c=>c.sequence),['0','1','2']);
    assert.deepEqual(calls.map(c=>c.final),['0','0','1']);
    assert.equal(new Set(calls.map(c=>c.stream)).size,1);
    assert.deepEqual(usage,[.6,1.2,1.2]);
    assert.equal(sentences[0].begin_time,0);assert.equal(sentences[0].end_time,1200);
    assert.equal(sentences[1].timing,'chunk-approximation');
  }finally{await new Promise(r=>server.close(r));}
});

test('本地服务过载明确报告容量错误，不伪装为完成',async()=>{
  const server=createServer(async(req,res)=>{
    if(req.method==='DELETE'){res.end('{}');return;}
    if(req.url==='/health'){res.end(JSON.stringify({ready:true}));return;}
    for await(const _ of req){}res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'queue_full'}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    await new Promise((resolve,reject)=>{
      const provider=localASR({url:`http://127.0.0.1:${server.address().port}`,onReady:()=>{provider.send(Buffer.alloc(320000));provider.finish();},onSentence:()=>reject(Error('unexpected text')),onUsage:()=>{},onFinish:()=>reject(Error('unexpected finish')),onError:(message,detail)=>{assert.match(message,/处理能力已满/);assert.equal(detail.code,'queue_full');resolve();}});
    });
  }finally{await new Promise(r=>server.close(r));}
});
