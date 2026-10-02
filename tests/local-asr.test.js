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
