import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomRecorder,clearPending,exportPending,flushPending,importPending,pendingCount,recoverPending,retryLocalPending,volatilePendingCount} from '../src/recorder.js';

const queue=new Map(),originalDB=globalThis.indexedDB;
let failWrite=()=>false,failDelete=false,unavailableDB=false;
const db={transaction(){
  if(unavailableDB)throw new DOMException('Database unavailable','UnknownError');
  const tx={objectStore(){return {
    getAll(){const request={};queueMicrotask(()=>{request.result=[...queue.values()];request.onsuccess();});return request;},
    put(value){queueMicrotask(()=>{if(failWrite(value)){tx.error=new DOMException('Storage full','QuotaExceededError');tx.onabort?.();}else{queue.set(value.key,value);tx.oncomplete?.();}});},
    delete(key){queueMicrotask(()=>{if(failDelete){tx.error=new DOMException('Storage unavailable','UnknownError');tx.onabort?.();}else{queue.delete(key);tx.oncomplete?.();}});}
  };}};return tx;
}};
globalThis.indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess());return request;}};
after(()=>{if(originalDB===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=originalDB;});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

function environment(t,id){
  const uploaded=[],states=[],requests=[],requestDetails=[];let stopped=0,tracksStopped=0,resolveStopped,expectedChunks=0;
  const recorder=new ClassroomRecorder({userId:`user-${id}`,onState:state=>states.push(state),onStopped:()=>stopped++});
  recorder.running=true;recorder.startedAt=performance.now()-5000;recorder.rec={id};
  recorder.mediaStopped=new Promise(resolve=>{resolveStopped=resolve;});
  recorder.media={state:'recording',stop(){this.state='inactive';recorder.saveChunk(new Blob(['tail'],{type:'audio/webm'}));resolveStopped();}};
  recorder.node={port:{postMessage(){}},disconnect(){}};recorder.stream={getTracks:()=>[{stop:()=>tracksStopped++}]};
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    requests.push(url);requestDetails.push({url,options});
    if(options.method==='PUT'){
      const seq=Number(url.split('/').at(-1)),content=await options.body.text();
      if(seq>uploaded.length)return json({error:'请按顺序补传录音。'},409);
      if(seq<uploaded.length&&uploaded[seq]!==content)return json({error:'录音分段内容冲突。'},409);
      if(seq===uploaded.length)uploaded.push(content);return json({ok:true});
    }
    if(url.endsWith('/interrupt')){expectedChunks=Math.max(expectedChunks,JSON.parse(options.body).chunks);return json({ok:true});}
    if(url.endsWith('/finish')){assert.equal(JSON.parse(options.body).chunks,uploaded.length);return json({ok:true});}
    return json({status:'interrupted',chunks:uploaded.length,expected_chunks:expectedChunks,active:false});
  });
  t.after(async()=>{failWrite=()=>false;failDelete=false;unavailableDB=false;await clearPending(recorder.userId);recorder.cleanup();});
  return {recorder,uploaded,states,requests,requestDetails,get stopped(){return stopped;},get tracksStopped(){return tracksStopped;},get expectedChunks(){return expectedChunks;}};
}

test('中间分段落盘失败立即停止采集，失败段及停止尾段按原序号恢复',async t=>{
  const env=environment(t,'middle'),{recorder,uploaded,states,requests}=env;
  recorder.saveChunk(new Blob(['header']));await recorder.queue;await flushPending(recorder.userId);
  let failed=false;failWrite=chunk=>chunk.seq===1&&!failed&&(failed=true);
  recorder.saveChunk(new Blob(['middle']));await recorder.queue;await assert.rejects(recorder.stopPromise,/本机保存失败/);
  assert.equal(recorder.media.state,'inactive');assert.equal(recorder.running,false);assert.equal(env.stopped,1);assert.equal(env.tracksStopped,1);
  assert.equal(recorder.seq,3);assert.equal(await pendingCount(recorder.userId),2);assert.equal(volatilePendingCount(recorder.userId),1);
  assert.equal(env.expectedChunks,3);
  assert.deepEqual(uploaded,['header']);assert.ok(!requests.some(url=>url.endsWith('/finish')));
  assert.match(states.at(-1).upload,/请勿关闭页面/);assert.ok(states.some(state=>state.capture==='本机存储异常，已停止采集'));
  await recoverPending(recorder.userId);
  assert.deepEqual(uploaded,['header','middle','tail']);assert.equal(await pendingCount(recorder.userId),0);assert.equal(volatilePendingCount(recorder.userId),0);
});

test('存储持续满时失败段和尾段保留在内存，恢复可直接补传且不会误报完整保存',async t=>{
  const env=environment(t,'persistent'),{recorder,uploaded,requests}=env;
  failWrite=()=>true;recorder.saveChunk(new Blob(['first']));await recorder.queue;
  await assert.rejects(recorder.stopPromise,error=>error.code==='local_storage');
  assert.equal(volatilePendingCount(recorder.userId),2);assert.equal(await pendingCount(recorder.userId),2);assert.equal(env.stopped,1);
  await assert.rejects(retryLocalPending(recorder.userId),/本机保存失败/);assert.equal(await pendingCount(recorder.userId),2);
  assert.ok(!requests.some(url=>url.endsWith('/finish')));
  await recoverPending(recorder.userId);
  assert.deepEqual(uploaded,['first','tail']);assert.equal(await pendingCount(recorder.userId),0);
});

test('停止中的存储失败仍回调停止状态，重复 stop 等待同一次保存',async t=>{
  const env=environment(t,'stop-tail'),{recorder,uploaded}=env;
  recorder.saveChunk(new Blob(['first']));await recorder.queue;await flushPending(recorder.userId);
  failWrite=chunk=>chunk.seq===1;
  const first=recorder.stop(),second=recorder.stop();assert.equal(first,second);
  await assert.rejects(first,/本机保存失败/);assert.equal(env.stopped,1);assert.equal(volatilePendingCount(recorder.userId),1);
  await recoverPending(recorder.userId);assert.deepEqual(uploaded,['first','tail']);
});

test('上传错误保留音频并显示真实服务端错误，不冒充本机存储故障',async t=>{
  const {recorder,states}=environment(t,'upload-error');
  t.mock.method(globalThis,'fetch',async()=>json({error:'存储额度已用完，请先导出或删除课堂。'},409));
  recorder.saveChunk(new Blob(['header']));await recorder.queue;await assert.rejects(flushPending(recorder.userId),/存储额度已用完/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(recorder.running,true);assert.equal(recorder.localSaveError,undefined);
  assert.equal(await pendingCount(recorder.userId),1);assert.match(states.at(-1).upload,/存储额度已用完/);
});

test('清除已上传分段时落盘错误仍保留重试内容，之后补传保持幂等',async t=>{
  const {recorder,uploaded}=environment(t,'cleanup-error');
  failWrite=()=>true;recorder.saveChunk(new Blob(['first']));await recorder.queue;await assert.rejects(recorder.stopPromise,/本机保存失败/);
  failDelete=true;await assert.rejects(flushPending(recorder.userId),error=>error.code==='local_storage');
  assert.equal(await pendingCount(recorder.userId),2);assert.deepEqual(uploaded,['first']);
  failDelete=false;await recoverPending(recorder.userId);assert.deepEqual(uploaded,['first','tail']);assert.equal(await pendingCount(recorder.userId),0);
});

test('待同步分段备份包含原序号和完整字节，可在同账号导入并恢复',async t=>{
  const {recorder,uploaded}=environment(t,'backup');
  failWrite=()=>true;recorder.saveChunk(new Blob(['first'],{type:'audio/webm'}));await recorder.queue;await assert.rejects(recorder.stopPromise,/本机保存失败/);
  const backup=await exportPending(recorder.userId,recorder.rec.id),content=JSON.parse(await backup.text());
  assert.deepEqual(content.chunks.map(chunk=>chunk.seq),[0,1]);assert.equal(atob(content.chunks[0].data),'first');
  await assert.rejects(importPending('another-user',backup),/不属于当前账号/);
  await clearPending(recorder.userId);assert.equal(await pendingCount(recorder.userId),0);
  failWrite=()=>false;assert.equal(await importPending(recorder.userId,backup),2);
  assert.equal(await pendingCount(recorder.userId),2);await recoverPending(recorder.userId);assert.deepEqual(uploaded,['first','tail']);
});

test('转写缺口通知失败后，停止尾段及导出导入恢复仍保留补转写标记',async t=>{
  const {recorder,uploaded,requestDetails}=environment(t,'transcription-gap'),serverFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{if(options.method==='POST'&&url.endsWith('/transcription-gap'))throw new Error('offline');return serverFetch(url,options);});
  recorder.markTranscriptionGap();failWrite=()=>true;recorder.saveChunk(new Blob(['first'],{type:'audio/webm'}));await recorder.queue;
  await assert.rejects(recorder.stopPromise,/本机保存失败/);
  const backup=await exportPending(recorder.userId),document=JSON.parse(await backup.text());
  assert.equal(document.chunks.length,2);assert.ok(document.chunks.every(chunk=>chunk.needsTranscription===true));
  const interrupt=requestDetails.find(request=>request.url.endsWith('/interrupt'));
  assert.equal(JSON.parse(interrupt.options.body).needsTranscription,true);
  await clearPending(recorder.userId);failWrite=()=>false;await importPending(recorder.userId,backup);await recoverPending(recorder.userId);
  assert.deepEqual(uploaded,['first','tail']);assert.equal(await pendingCount(recorder.userId),0);
  const uploadRequests=requestDetails.filter(request=>request.options.method==='PUT');assert.ok(uploadRequests.every(request=>request.options.headers['X-Needs-Transcription']==='true'));
  const finish=requestDetails.find(request=>request.url.endsWith('/finish'));assert.equal(JSON.parse(finish.options.body).needsTranscription,true);
});

test('删课只清除指定课堂和账号；注销可清除此账号全部待同步分段',async t=>{
  const {recorder}=environment(t,'delete-scope');
  failWrite=()=>true;recorder.saveChunk(new Blob(['first']));await recorder.queue;await assert.rejects(recorder.stopPromise,/本机保存失败/);
  for(const [userId,recordingId] of [[recorder.userId,'keep-lesson'],['other-user','other-lesson']])queue.set(`${recordingId}:0`,{key:`${recordingId}:0`,userId,recordingId,seq:0,duration:5000,blob:new Blob(['audio'])});
  assert.equal(await clearPending(recorder.userId,[recorder.rec.id]),2);assert.equal(volatilePendingCount(recorder.userId),0);
  assert.equal(await pendingCount(recorder.userId),1);assert.equal(await pendingCount('other-user'),1);
  await clearPending(recorder.userId,[]);assert.equal(await pendingCount(recorder.userId),1);
  await clearPending(recorder.userId);assert.equal(await pendingCount(recorder.userId),0);assert.equal(await pendingCount('other-user'),1);
});

test('本机数据库完全不可用时仍能上传内存音频，完成后保留未知磁盘缓存警告',async t=>{
  const {recorder,uploaded}=environment(t,'unavailable');
  unavailableDB=true;recorder.saveChunk(new Blob(['first']));await recorder.queue;await assert.rejects(recorder.stopPromise,/本机保存失败/);
  assert.equal(await pendingCount(recorder.userId),2);const states=[];
  const result=await recoverPending(recorder.userId,[],state=>states.push(state));
  assert.deepEqual(uploaded,['first','tail']);assert.equal(volatilePendingCount(recorder.userId),0);assert.equal(result.localCacheWarning,true);
  assert.match(states.at(-1),/其他本机缓存状态尚未确认/);assert.ok(!states.includes('录音已同步'));
  await assert.rejects(pendingCount(recorder.userId),error=>error.code==='local_storage');
});

test('库中未知的未上传开头不能被内存后续分段越过，恢复库后整段仍可保存',async t=>{
  const {recorder,uploaded}=environment(t,'unavailable-prefix'),serverFetch=globalThis.fetch;
  let rejectUpload=true;
  t.mock.method(globalThis,'fetch',async(url,options={})=>options.method==='PUT'&&rejectUpload?json({error:'临时不能上传。'},503):serverFetch(url,options));
  recorder.saveChunk(new Blob(['first']));await recorder.queue;await assert.rejects(flushPending(recorder.userId),/临时不能上传/);
  unavailableDB=true;recorder.saveChunk(new Blob(['middle']));await recorder.queue;await assert.rejects(recorder.stopPromise,/本机保存失败/);
  rejectUpload=false;await assert.rejects(recoverPending(recorder.userId),/请按顺序补传录音/);assert.equal(volatilePendingCount(recorder.userId),2);assert.deepEqual(uploaded,[]);
  unavailableDB=false;await recoverPending(recorder.userId);assert.deepEqual(uploaded,['first','middle','tail']);
});

test('服务器确认删除后库不可用也清除指定内存，同时明确提示手工清理磁盘缓存',async t=>{
  const {recorder}=environment(t,'unavailable-delete'),other=environment(t,'unavailable-other').recorder;
  unavailableDB=true;
  for(const current of [recorder,other]){current.saveChunk(new Blob(['first']));await current.queue;await assert.rejects(current.stopPromise,/本机保存失败/);}
  assert.equal(volatilePendingCount(recorder.userId),2);assert.equal(volatilePendingCount(other.userId),2);
  await assert.rejects(clearPending(recorder.userId,[recorder.rec.id]),error=>error.code==='local_cache_cleanup'&&error.message.includes('浏览器设置'));
  assert.equal(volatilePendingCount(recorder.userId),0);assert.equal(volatilePendingCount(other.userId),2);
});

test('分段上传成功但预留空间即将用完时自动停录并保存尾段',async t=>{
  const {recorder,uploaded,states}=environment(t,'stop-soon'),serverFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{const response=await serverFetch(url,options);return options.method==='PUT'?json({ok:true,stopSoon:true}):response;});
  recorder.saveChunk(new Blob(['first']));await recorder.queue;await flushPending(recorder.userId);assert.ok(recorder.stopPromise);await recorder.stopPromise;
  assert.equal(recorder.media.state,'inactive');assert.equal(recorder.running,false);assert.deepEqual(uploaded,['first','tail']);
  assert.ok(states.some(state=>state.capture==='服务器存储容量不足，已停止采集'));assert.equal(await pendingCount(recorder.userId),0);
});

test('服务器返回 storage_limit 时立即停录，真实错误和未上传的尾段都保留',async t=>{
  const {recorder,states}=environment(t,'storage-limit'),serverFetch=globalThis.fetch,errorMessage='账号存储容量不足，请先导出或删除旧课堂。';
  t.mock.method(globalThis,'fetch',async(url,options={})=>options.method==='PUT'?json({error:errorMessage,code:'storage_limit'},409):serverFetch(url,options));
  recorder.saveChunk(new Blob(['first']));await recorder.queue;await assert.rejects(flushPending(recorder.userId),error=>error.code==='storage_limit'&&error.message===errorMessage);
  assert.ok(recorder.stopPromise);await assert.rejects(recorder.stopPromise,error=>error.code==='storage_limit');
  assert.equal(recorder.running,false);assert.equal(await pendingCount(recorder.userId),2);assert.equal(recorder.localSaveError,undefined);
  assert.match(states.at(-1).upload,/账号存储容量不足/);assert.ok(states.some(state=>state.capture==='服务器存储容量不足，已停止采集'));
});

test('普通补传已在进行时后加入的录音容量回调仍能收到 stopSoon',async t=>{
  const {recorder,uploaded}=environment(t,'shared-limit'),serverFetch=globalThis.fetch;let release;
  queue.set(`${recorder.rec.id}:0`,{key:`${recorder.rec.id}:0`,recordingId:recorder.rec.id,userId:recorder.userId,seq:0,duration:5000,blob:new Blob(['first'])});recorder.seq=1;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{const response=await serverFetch(url,options);if(options.method==='PUT'&&url.endsWith('/0')){await new Promise(resolve=>{release=resolve;});return json({ok:true,stopSoon:true});}return response;});
  const generic=flushPending(recorder.userId);await new Promise(resolve=>setImmediate(resolve));
  const subscribed=flushPending(recorder.userId,()=>{},undefined,recorder.onUploadLimit);release();await Promise.all([generic,subscribed]);
  assert.ok(recorder.stopPromise);await recorder.stopPromise;assert.deepEqual(uploaded,['first','tail']);assert.equal(recorder.running,false);
});
