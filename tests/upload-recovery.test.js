import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {flushPending,pendingCount,recoverPending} from '../src/recorder.js';

const queue=new Map(),previous=globalThis.indexedDB;
// 只模拟队列使用的事务；上传和保存行为由真实恢复函数执行。
const db={transaction(){const tx={objectStore(){return {
  getAll(){const request={};queueMicrotask(()=>{request.result=[...queue.values()];request.onsuccess();});return request;},
  delete(key){queue.delete(key);queueMicrotask(()=>tx.oncomplete());}
};}};return tx;}};
globalThis.indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess());return request;}};
after(()=>{if(previous===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=previous;});
function chunk(userId,recordingId,seq){const value={key:`${recordingId}:${seq}`,userId,recordingId,seq,duration:(seq+1)*5000,blob:new Blob(['audio'])};queue.set(value.key,value);}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('一条录音补传失败，不阻断其他录音；失败分段及其他账号内容保留',async t=>{
  queue.clear();chunk('mine','a-bad',1);chunk('mine','a-bad',2);chunk('mine','b-good',1);chunk('other','c-other',0);
  const calls=[],states=[];
  t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return url.includes('a-bad')?json({error:'录音分段内容冲突。'},409):json({ok:true});});
  await assert.rejects(flushPending('mine',s=>states.push(s)),/内容冲突/);
  assert.deepEqual(calls,['/api/recordings/a-bad/chunks/1','/api/recordings/b-good/chunks/1']);
  assert.equal(await pendingCount('mine'),2);assert.equal(await pendingCount('other'),1);
  assert.equal(states.at(-1),'2 段等待上传');
});

test('定向保存当前录音，不受其他课堂待上传任务影响',async t=>{
  queue.clear();chunk('mine','a-bad',0);chunk('mine','b-current',0);
  const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return json({ok:true});});
  assert.equal(await flushPending('mine',()=>{},'b-current'),0);
  assert.deepEqual(calls,['/api/recordings/b-current/chunks/0']);assert.equal(await pendingCount('mine'),1);
});

test('并发补传串行执行，不重复发送同一分段',async t=>{
  queue.clear();chunk('mine','serial',0);chunk('mine','serial',1);
  const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(url);await new Promise(resolve=>setImmediate(resolve));return json({ok:true});});
  assert.deepEqual(await Promise.all([flushPending('mine'),flushPending('mine',()=>{},'serial'),flushPending('mine')]),[0,0,0]);
  assert.deepEqual(calls,['/api/recordings/serial/chunks/0','/api/recordings/serial/chunks/1']);
});

test('恢复会保存缓存对应的全部课堂，并提供准确的总分段数',async t=>{
  queue.clear();chunk('mine','a-outside',3);chunk('mine','b-outside',5);
  const finished=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(options.method==='PUT')return json({ok:true});
    if(url.endsWith('/finish')){finished.push({url,body:JSON.parse(options.body)});return json({ok:true});}
    return json({status:'interrupted',chunks:url.includes('a-outside')?4:6,active:false});
  });
  await recoverPending('mine');
  assert.deepEqual(finished,[{url:'/api/recordings/a-outside/finish',body:{chunks:4}},{url:'/api/recordings/b-outside/finish',body:{chunks:6}}]);
  assert.equal(await pendingCount('mine'),0);
});

test('其他页面仍在录音时只补传，不提前结束该录音；其他录音继续恢复',async t=>{
  queue.clear();chunk('mine','a-live',0);chunk('mine','b-stopped',1);
  const finished=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(options.method==='PUT')return json({ok:true});
    if(url.endsWith('/finish')){finished.push(url);return json({ok:true});}
    return json({status:url.includes('a-live')?'recording':'interrupted',chunks:2,active:url.includes('a-live')});
  });
  await assert.rejects(recoverPending('mine'),/仍在其他页面进行/);
  assert.deepEqual(finished,['/api/recordings/b-stopped/finish']);
});

test('旧录音无法合并时保留服务端错误，其他录音仍完成保存',async t=>{
  queue.clear();chunk('mine','a-old',3);chunk('mine','b-normal',0);
  const finished=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(options.method==='PUT')return json({ok:true});
    if(url.endsWith('/finish')){finished.push(url);return url.includes('a-old')?json({error:'原始分段已缺失，补传内容已保留。'},409):json({ok:true});}
    return json({status:'interrupted',chunks:url.includes('a-old')?4:1,active:false});
  });
  await assert.rejects(recoverPending('mine'),/原始分段已缺失/);
  assert.deepEqual(finished,['/api/recordings/a-old/finish','/api/recordings/b-normal/finish']);assert.equal(await pendingCount('mine'),0);
});

test('页面关闭后仍按服务端声明的完整分段数恢复，缺失前缀以外的内容不能冒充完整录音',async t=>{
  queue.clear();const finished=[];
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(url.endsWith('/finish')){finished.push(JSON.parse(options.body));return json({error:'还有录音分段没有上传，请恢复上传后再试。'},409);}
    return json({status:'interrupted',chunks:1,expected_chunks:3,active:false});
  });
  await assert.rejects(recoverPending('mine',[{id:'lost-tail',status:'interrupted'}]),/还有录音分段没有上传/);
  assert.deepEqual(finished,[{chunks:3}]);
});

test('已声明内容但尚无已上传分段时恢复不得取消录音，以便导入备份后再保存',async t=>{
  queue.clear();const calls=[];
  t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return json({status:'interrupted',chunks:0,expected_chunks:2,active:false});});
  await assert.rejects(recoverPending('mine',[{id:'all-in-memory',status:'interrupted'}]),/导入待同步分段备份/);
  assert.deepEqual(calls,['/api/recordings/all-in-memory']);
});
