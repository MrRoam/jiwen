import { api } from './api.js';

export function transcriptionPollDelay(recordings,at=Date.now()){
  if(recordings.some(row=>['needed','pending','queued','running'].includes(row.transcription_status)))return 2000;
  const retries=recordings.filter(row=>row.transcription_status==='blocked').map(row=>Date.parse(row.transcription_retry_at)).filter(Number.isFinite);
  if(!retries.length)return null;
  // 到额度恢复后留出后台定时任务的一分钟；长等待不能溢出浏览器计时器。
  return Math.min(2147483647,Math.max(60000,Math.min(...retries)-at+60000));
}
export function transcriptionRecoveryRows(lesson){
  const withText=new Set(lesson.segments.filter(segment=>segment.text?.trim()).map(segment=>segment.recording_id));
  return lesson.recordings.filter(row=>row.status==='ready'&&(['needed','pending','queued','running','failed','blocked'].includes(row.transcription_status)||((!row.transcription_status||row.transcription_status==='idle')&&row.duration_ms>0&&!withText.has(row.id))));
}

let databasePromise;
function storageError(cause){const error=new Error('本机保存失败；未同步音频仍留在当前页面，请勿关闭页面，可重试恢复保存或导出待同步分段。',{cause});error.code='local_storage';return error;}
function database(){
  if(!databasePromise)databasePromise=new Promise((resolve,reject)=>{const request=indexedDB.open('tingjian-recording-queue',1);request.onupgradeneeded=()=>request.result.createObjectStore('chunks',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}).catch(error=>{databasePromise=undefined;throw storageError(error);});
  return databasePromise;
}
async function writeChunks(action){try{const db=await database();await new Promise((resolve,reject)=>{const tx=db.transaction('chunks','readwrite');tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);action(tx.objectStore('chunks'));});}catch(error){throw error.code==='local_storage'?error:storageError(error);}}
const put=value=>writeChunks(store=>store.put(value));
const remove=key=>writeChunks(store=>store.delete(key));
async function entries(){try{const db=await database();return await new Promise((resolve,reject)=>{const tx=db.transaction('chunks'),req=tx.objectStore('chunks').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.onabort=()=>reject(tx.error);});}catch(error){throw error.code==='local_storage'?error:storageError(error);}}
// 写入成功前一直持有 Blob；首次写入失败即停止采集，因此此队列只增长到停止尾段。
const localPending=new Map();
const belongs=(chunk,userId,recordingId)=>chunk.userId===userId&&(!recordingId||chunk.recordingId===recordingId);
const ordered=chunks=>chunks.sort((a,b)=>a.recordingId.localeCompare(b.recordingId)||a.seq-b.seq);
function memoryEntries(userId,recordingId){return ordered([...localPending.values()].filter(chunk=>belongs(chunk,userId,recordingId)));}
async function pendingEntries(userId,recordingId){
  const memory=memoryEntries(userId,recordingId);let persisted,readError;
  try{persisted=await entries();}catch(error){if(!memory.length)throw error;readError=error;persisted=[];}
  const merged=new Map(persisted.filter(chunk=>belongs(chunk,userId,recordingId)).map(chunk=>[chunk.key,chunk]));for(const chunk of memory)merged.set(chunk.key,chunk);
  const result=ordered([...merged.values()]);result.storageReadError=readError;return result;
}
const unavailableCacheMessage='浏览器磁盘缓存暂时无法读取，已仅处理当前页面保留的音频；其他本机缓存状态尚未确认。';

export async function retryLocalPending(userId,onState=()=>{},recordingId){
  let firstError;
  for(const chunk of ordered([...localPending.values()].filter(chunk=>belongs(chunk,userId,recordingId)))){
    try{await put(chunk);if(localPending.get(chunk.key)===chunk)localPending.delete(chunk.key);}catch(error){firstError ||=error;}
  }
  if(firstError)throw firstError;
  const left=await pendingCount(userId);onState(left?`${left} 段等待上传`:'录音已同步');return left;
}
const uploading=new Map();
export async function flushPending(userId,onState=()=>{},recordingId,onLimit){
  // 同一账号串行上传；定向保存不能被其他课堂的失败任务阻断。
  const previous=uploading.get(userId);
  if(previous&&!recordingId&&previous.recordingId===undefined){if(onLimit)previous.limitCallbacks.add(onLimit);return previous;}
  const limitCallbacks=new Set(onLimit?[onLimit]:[]),notifyLimit=(chunk,error)=>{for(const callback of limitCallbacks)callback({recordingId:chunk.recordingId,code:'storage_limit',message:error?.message||'服务器存储预留空间即将用完，正在停止并保存已有录音。',error});};
  const job=(previous||Promise.resolve()).catch(()=>{}).then(async()=>{const chunks=await pendingEntries(userId);
    const failed=new Set();let firstError,cacheWarning=chunks.storageReadError;
    if(cacheWarning)onState(unavailableCacheMessage);
    for(const c of chunks){if((recordingId&&c.recordingId!==recordingId)||failed.has(c.recordingId))continue;
      try{
        let response;try{response=await fetch(`/api/recordings/${c.recordingId}/chunks/${c.seq}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Duration-Ms':String(c.duration),...(c.needsTranscription?{'X-Needs-Transcription':'true'}:{})},body:c.blob});}catch{throw new Error('录音上传中断；未同步音频已保留，请恢复连接后重试。');}
        if(response.status!==404){
          const data=await response.json();
          if(!response.ok){const error=new Error(data.error||'录音上传失败');error.code=data.code;if(error.code==='storage_limit')notifyLimit(c,error);throw error;}
          if(data.stopSoon)notifyLimit(c);
        }
        try{await remove(c.key);}catch(error){
          // 服务器已接收内存分段时可释放此 Blob，但磁盘缓存是否清除仍须明确告知。
          if(!chunks.storageReadError||localPending.get(c.key)!==c)throw error;cacheWarning ||=error;
        }
        if(localPending.get(c.key)===c)localPending.delete(c.key);
      }
      catch(error){failed.add(c.recordingId);firstError ||=error;}
    }
    let remaining;try{remaining=await pendingEntries(userId);}catch(error){if(!cacheWarning)throw error;remaining=memoryEntries(userId);cacheWarning ||=error;}
    cacheWarning ||=remaining.storageReadError;
    onState(cacheWarning?`${unavailableCacheMessage}${remaining.length?` 当前页面还有 ${remaining.length} 段等待上传。`:''}`:remaining.length?`${remaining.length} 段等待上传`:'录音已同步');
    if(firstError)throw firstError;return remaining.filter(c=>!recordingId||c.recordingId===recordingId).length;
  });job.recordingId=recordingId;job.limitCallbacks=limitCallbacks;uploading.set(userId,job);try{return await job;}finally{if(uploading.get(userId)===job)uploading.delete(userId);}
}
export async function pendingCount(userId){return(await pendingEntries(userId)).length;}
export function volatilePendingCount(userId){return [...localPending.values()].filter(chunk=>chunk.userId===userId).length;}

// 调用方须先停止此账号的采集，并在服务器确认删除后清理本机分段。
export async function clearPending(userId,recordingIds){
  const targets=recordingIds===undefined?null:new Set(recordingIds),matches=chunk=>chunk.userId===userId&&(!targets||targets.has(chunk.recordingId));
  if(targets?.size===0)return 0;
  const previous=uploading.get(userId),job=(previous||Promise.resolve()).catch(()=>{}).then(async()=>{
    const memory=memoryEntries(userId).filter(matches);
    try{const all=await pendingEntries(userId);if(all.storageReadError)throw all.storageReadError;const chunks=all.filter(matches);if(chunks.length)await writeChunks(store=>{for(const chunk of chunks)store.delete(chunk.key);});return chunks.length;}
    catch(cause){const error=new Error('当前页面的待同步音频已清除，但浏览器磁盘缓存暂时无法清理；请在浏览器设置中清除此站点的数据。',{cause});error.code='local_cache_cleanup';throw error;}
    finally{for(const chunk of memory)if(localPending.get(chunk.key)===chunk)localPending.delete(chunk.key);}
  });job.recordingId=null;uploading.set(userId,job);try{return await job;}finally{if(uploading.get(userId)===job)uploading.delete(userId);}
}

// 备份为保序分段，不把缺少已上传开头的内容伪装成完整可播放录音。
export async function exportPending(userId,recordingId){
  let chunks;try{chunks=await pendingEntries(userId,recordingId);}catch(error){chunks=ordered([...localPending.values()].filter(chunk=>belongs(chunk,userId,recordingId)));if(!chunks.length)throw error;}
  const records=[];
  for(const chunk of chunks){const bytes=new Uint8Array(await chunk.blob.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));records.push({recordingId:chunk.recordingId,seq:chunk.seq,duration:chunk.duration,mime:chunk.blob.type,data:btoa(binary),...(chunk.needsTranscription?{needsTranscription:true}:{})});}
  return new Blob([JSON.stringify({format:'jiwen-pending-chunks-v1',userId,localCacheReadable:!chunks.storageReadError,chunks:records})],{type:'application/json'});
}

export async function importPending(userId,backup){
  let document;try{document=JSON.parse(await backup.text());}catch{throw new Error('待同步分段备份格式无效。');}
  if(document.format!=='jiwen-pending-chunks-v1'||document.userId!==userId||!Array.isArray(document.chunks))throw new Error('此分段备份不属于当前账号，或格式无效。');
  const restored=new Map();
  for(const item of document.chunks){
    if(typeof item.recordingId!=='string'||!item.recordingId||!Number.isSafeInteger(item.seq)||item.seq<0||item.seq>12000||!Number.isSafeInteger(item.duration)||item.duration<0||typeof item.data!=='string'||typeof item.mime!=='string'||(item.needsTranscription!==undefined&&typeof item.needsTranscription!=='boolean'))throw new Error('待同步分段备份格式无效。');
    let bytes;try{bytes=Uint8Array.from(atob(item.data),char=>char.charCodeAt(0));}catch{throw new Error('待同步分段备份的音频内容无效。');}
    const key=`${item.recordingId}:${item.seq}`;if(restored.has(key))throw new Error('待同步分段备份存在重复序号。');
    restored.set(key,{key,recordingId:item.recordingId,userId,seq:item.seq,duration:item.duration,blob:new Blob([bytes],{type:item.mime}),...(item.needsTranscription?{needsTranscription:true}:{})});
  }
  const current=await pendingEntries(userId);if(current.storageReadError)throw current.storageReadError;const existing=new Map(current.map(chunk=>[chunk.key,chunk]));
  // 不覆盖同序号的其他内容；校验完所有分段再接管，避免导入一半。
  for(const chunk of restored.values())if(existing.has(chunk.key)){const left=new Uint8Array(await existing.get(chunk.key).blob.arrayBuffer()),right=new Uint8Array(await chunk.blob.arrayBuffer());if(left.length!==right.length||left.some((byte,index)=>byte!==right[index]))throw new Error('同一录音序号已有不同内容，原分段已保留。');}
  for(const chunk of restored.values())if(!existing.has(chunk.key)||(chunk.needsTranscription&&!existing.get(chunk.key).needsTranscription))localPending.set(chunk.key,chunk);
  // 即使存储仍不可用，已导入 Blob 也留在当前页面，恢复保存可以直接补传。
  await retryLocalPending(userId);return restored.size;
}

export async function recoverPending(userId,recordings=[],onState=()=>{}){
  const chunks=await pendingEntries(userId),targets=new Map(),transcriptionGaps=new Set(chunks.filter(chunk=>chunk.needsTranscription).map(chunk=>chunk.recordingId));
  let localCacheWarning=!!chunks.storageReadError;
  const report=text=>{if(text.includes(unavailableCacheMessage))localCacheWarning=true;onState(text);};
  for(const r of recordings)if(r.status!=='ready')targets.set(r.id,0);
  for(const c of chunks)targets.set(c.recordingId,Math.max(targets.get(c.recordingId)||0,c.seq+1));
  let firstError;
  for(const [recordingId,expected] of targets){
    try{
      let left;do{left=await flushPending(userId,report,recordingId);}while(left);
      const state=await api(`/recordings/${recordingId}`);
      if(state.active)throw new Error('这段录音仍在其他页面进行，请先停止录音再恢复保存。');
      const expectedChunks=Math.max(expected,state.chunks,state.expected_chunks||0);
      if(state.status==='ready'&&state.chunks>=expectedChunks)continue;
      if(!state.chunks&&expectedChunks)throw new Error('仍有录音分段未上传，请在原录音页面恢复保存或导入待同步分段备份。');
      if(!state.chunks){await api(`/recordings/${recordingId}/cancel`,{method:'POST'});continue;}
      onState('正在处理回放音频');
      await api(`/recordings/${recordingId}/finish`,{method:'POST',body:{chunks:expectedChunks,...(transcriptionGaps.has(recordingId)?{needsTranscription:true}:{})}});
    }catch(error){firstError ||=error;}
  }
  if(firstError)throw firstError;
  if(localCacheWarning)onState(unavailableCacheMessage);
  return {localCacheWarning};
}

export class ClassroomRecorder {
  constructor({lessonId,userId,onSegment,onState,onTime,onStopped,deviceId='',lessonTitle,onLessonCreated,importanceEnabled=false}){Object.assign(this,{lessonId,userId,onSegment,onState,onTime,onStopped,deviceId,lessonTitle,onLessonCreated,importanceEnabled});this.running=false;this.stopping=false;this.seq=0;this.queue=Promise.resolve();this.sentSamples=0;this.asrReady=false;this.asrPending=[];this.asrRetries=0;this.needsTranscription=false;this.onUploadLimit=event=>this.handleUploadLimit(event);}
  async start(){
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('此浏览器不支持录音，请使用新版浏览器并通过 HTTPS 或 localhost 打开。');
    try{
      const constraints={channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false};
      try{this.stream=await navigator.mediaDevices.getUserMedia({audio:{...constraints,...(this.deviceId?{deviceId:{exact:this.deviceId}}:{})},video:false});}catch(error){if(!this.deviceId||!['NotFoundError','OverconstrainedError'].includes(error.name))throw error;this.deviceId='';this.stream=await navigator.mediaDevices.getUserMedia({audio:constraints,video:false});}
      this.lastPCM=performance.now();this.lastSound=performance.now();
      const track=this.stream.getAudioTracks()[0];
      this.onState({capture:'正在收音',inputDevice:track.label||'当前音源'});
      track.onmute=()=>this.onState({capture:'音源已静音，请检查设备或共享状态',inputLevel:0});
      track.onunmute=()=>{this.lastSound=performance.now();this.onState({capture:'已恢复收音'});};
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(m=>MediaRecorder.isTypeSupported(m));if(!mime)throw new Error('当前浏览器没有可用的录音格式。');
      this.context=new AudioContext();this.context.onstatechange=()=>{if(this.running&&this.context.state==='suspended'){this.onState({capture:'音频采集暂停，正在恢复'});this.context.resume().catch(()=>this.onState({capture:'采集暂停，请暂停后重新开始录音'}));}};await this.context.resume();try{await this.context.audioWorklet.addModule(new URL('./pcm-worklet.js',import.meta.url));}catch(error){console.error('audio-worklet-load',error);throw new Error('录音采集模块加载失败，请刷新页面后重试；若仍失败，请检查网络或重新部署完整前端文件。',{cause:error});}
      this.node=new AudioWorkletNode(this.context,'pcm-processor');this.source=this.context.createMediaStreamSource(this.stream);const mute=this.context.createGain();mute.gain.value=0;this.source.connect(this.node).connect(mute).connect(this.context.destination);
      this.node.port.onmessage=e=>{if(!this.running)return;const data=e.data.buffer;const samples=new Int16Array(data);let peak=0;for(const sample of samples)peak=Math.max(peak,Math.abs(sample)/32768);this.lastPCM=performance.now();if(peak>.008)this.lastSound=this.lastPCM;this.onState({inputLevel:peak,capture:this.stream.getAudioTracks()[0].muted?'麦克风已静音，请检查设备':this.lastPCM-this.lastSound>5000?'连续 5 秒未收到明显声音，请检查音源':'正在收音'});const offsetMs=Math.max(0,performance.now()-this.startedAt-(this.context.currentTime-e.data.endTime)*1000-data.byteLength/32);data.offsetMs=offsetMs;this.sentSamples+=data.byteLength/2;if(this.asrReady&&this.ws?.readyState===WebSocket.OPEN){if(this.ws.bufferedAmount<320000){this.ws.send(JSON.stringify({type:'packet',offsetMs}));this.ws.send(data);}else{this.asrReady=false;this.ws.close();this.onState({asr:'转写网络积压，正在重连；录音继续保存'});this.queueASR(data);}}else if(this.rec?.asrReady)this.queueASR(data);this.lastOffset=offsetMs;};
      if(!this.lessonId){const lesson=await api('/lessons',{method:'POST',body:{title:this.lessonTitle,importanceEnabled:this.importanceEnabled}});this.lessonId=lesson.id;this.createdLesson=true;}
      this.rec=await api(`/lessons/${this.lessonId}/recordings`,{method:'POST',body:{mime}});
      this.media=new MediaRecorder(this.stream,{mimeType:mime,audioBitsPerSecond:64000});this.mediaStopped=new Promise(resolve=>this.media.addEventListener('stop',resolve,{once:true}));this.media.onerror=()=>{this.onState({capture:'录音设备发生错误，正在保存已有内容',error:true});this.stop().catch(error=>this.onState({upload:error.message}));};
      this.media.ondataavailable=e=>this.saveChunk(e.data);
      this.startedAudio=this.context.currentTime;this.startedAt=performance.now();this.running=true;this.media.start(5000);
      if(this.createdLesson)await this.onLessonCreated?.(this.lessonId);
      this.onPageHide=()=>navigator.sendBeacon(`/api/recordings/${this.rec.id}/interrupt`,new Blob([JSON.stringify({chunks:this.seq,needsTranscription:true})],{type:'application/json'}));window.addEventListener('pagehide',this.onPageHide);
      this.timer=setInterval(()=>{const elapsed=Math.round(performance.now()-this.startedAt);this.onTime(this.rec.offsetMs+elapsed);if(performance.now()-this.lastPCM>3000)this.onState({capture:'未收到音频数据，请检查设备或重新录音',inputLevel:0});if(elapsed>=this.rec.maxSeconds*1000)this.stop().catch(error=>this.onState({upload:error.message}));},250);
      this.uploadTimer=setInterval(()=>flushPending(this.userId,text=>this.onState({upload:text}),undefined,this.onUploadLimit).catch(error=>this.onState({upload:error.message,error:true})),10000);
      if(this.rec.asrReady)this.connectASR();else{this.markTranscriptionGap();this.onState({asr:'仅录音 · 转写服务未配置'});}
      this.onState({upload:'正在录音，每 5 秒保存一次'});
      try{this.wake=await navigator.wakeLock?.request('screen');}catch{}
      const ended=()=>{if(this.running&&!this.stopping){this.onState({capture:'音源已断开，正在保存已录内容'});this.stop().catch(error=>this.onState({upload:error.message}));}};track.onended=ended;
    }catch(error){this.cleanup();if(this.media?.state==='recording')this.media.stop();if(this.rec?.id&&!this.seq)await api(`/recordings/${this.rec.id}/cancel`,{method:'POST'}).catch(()=>{});if(this.createdLesson&&!this.seq)await api(`/lessons/${this.lessonId}`,{method:'DELETE'}).catch(()=>{});throw error;}
  }
  connectASR(){
    if(!this.running||this.stopping)return;
    if(this.asrQuotaExhausted){this.onState({asr:this.asrError});return;}
    if(this.ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(this.ws.readyState))return;
    clearTimeout(this.asrRetryTimer);this.asrError=null;this.onState({asr:'正在连接实时转写'});const base=this.startedAt===undefined?this.sentSamples/16:Math.max(0,performance.now()-this.startedAt);
    const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/asr?recordingId=${this.rec.id}&offsetMs=${base}`);this.ws=ws;
    ws.onmessage=e=>{if(this.ws!==ws)return;const event=JSON.parse(e.data);if(event.type==='ready'){ws.send(JSON.stringify({type:'offset',offsetMs:this.asrPending[0]?.offsetMs??base}));this.asrReady=true;this.asrRetries=0;for(const chunk of this.asrPending){if(Number.isFinite(chunk.offsetMs))ws.send(JSON.stringify({type:'packet',offsetMs:chunk.offsetMs}));ws.send(chunk);}this.asrPending=[];this.onState({asr:this.asrDropped?'实时转写已恢复，缺失文字会在录音保存后补转写':'实时转写已连接'});this.asrDropped=false;}if(event.type==='segment')this.onSegment(event.segment);if(event.type==='error'){this.asrError=event.error;this.markTranscriptionGap();if(event.code==='quota_exhausted'){this.asrQuotaExhausted=true;this.asrReady=false;this.asrPending=[];if(this.rec)this.rec.asrReady=false;clearTimeout(this.asrRetryTimer);}this.onState({asr:event.error});}};
    ws.onclose=()=>{if(this.ws!==ws)return;this.asrReady=false;this.ws=null;if(this.running&&!this.stopping){this.markTranscriptionGap();if(!this.asrQuotaExhausted){const delay=Math.min(30000,1000*2**Math.min(this.asrRetries++,5));this.onState({asr:`${this.asrError||'转写已断开'}；${Math.round(delay/1000)} 秒后自动重连，录音继续保存`});this.asrRetryTimer=setTimeout(()=>this.connectASR(),delay);}}};
    ws.onerror=()=>{if(this.ws===ws)this.onState({asr:'转写连接失败，等待自动重连'});};
  }
  queueASR(data){if(this.asrQuotaExhausted){this.markTranscriptionGap();return;}this.asrPending.push(data);while(this.asrPending.reduce((n,b)=>n+b.byteLength,0)>160000){this.asrPending.shift();this.asrDropped=true;this.markTranscriptionGap();}}
  markTranscriptionGap(){
    if(this.needsTranscription)return;
    this.needsTranscription=true;
    if(!this.rec?.id)return;
    for(const chunk of localPending.values())if(chunk.userId===this.userId&&chunk.recordingId===this.rec.id)chunk.needsTranscription=true;
    // 独立发送；失败时由分段上传、停止保存及离开页面的请求携带标记兜底。
    api(`/recordings/${this.rec.id}/transcription-gap`,{method:'POST'}).catch(()=>{});
  }
  handleUploadLimit(event){
    if(event.recordingId!==this.rec?.id||!this.running||this.stopping)return;
    this.onState({capture:'服务器存储容量不足，已停止采集',upload:event.message,error:!!event.error});
    // 上传工作不等待 stop；stop 自身还需要等待当前上传结束。
    this.stop().catch(error=>this.onState({upload:error.message,error:true}));
  }
  saveChunk(blob){
    if(!blob.size)return;
    const seq=this.seq,chunk={key:`${this.rec.id}:${seq}`,recordingId:this.rec.id,userId:this.userId,seq,duration:Math.round(performance.now()-this.startedAt),blob,...(this.needsTranscription?{needsTranscription:true}:{})};
    // 序号只在当前页面已接管该分段后推进，失败段与 stop 产生的尾段都可恢复。
    localPending.set(chunk.key,chunk);this.seq++;
    this.queue=this.queue.then(async()=>{
      try{await put(chunk);if(localPending.get(chunk.key)===chunk)localPending.delete(chunk.key);}
      catch(error){
        this.localSaveError ||=error;this.onState({capture:'本机存储异常，已停止采集',upload:error.message,error:true});
        // 不在当前写入链内等待 stop，否则 stop 等待本链会产生死锁。
        this.stop().catch(stopError=>this.onState({upload:stopError.message,error:true}));return;
      }
      if(!this.localSaveError)flushPending(this.userId,text=>this.onState({upload:text}),undefined,this.onUploadLimit).catch(error=>this.onState({upload:error.message,error:true}));
    });
  }
  stop(){if(this.stopPromise)return this.stopPromise;if(!this.running)return Promise.resolve();return this.stopPromise=this.finishStop();}
  async finishStop(){
    this.stopping=true;if(!this.asrReady||this.asrPending.length)this.markTranscriptionGap();this.onState({upload:'正在保存最后一段录音'});clearInterval(this.timer);clearInterval(this.uploadTimer);
    if(this.media.state!=='inactive')this.media.stop();await this.mediaStopped;
    this.node.port.postMessage('flush');await new Promise(resolve=>setTimeout(resolve,60));if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'finish'}));
    await this.queue;this.running=false;this.cleanup(false);await api(`/recordings/${this.rec.id}/interrupt`,{method:'POST',body:{chunks:this.seq,...(this.needsTranscription?{needsTranscription:true}:{})}}).catch(()=>{});
    try{if(this.localSaveError)throw this.localSaveError;let left;do{left=await flushPending(this.userId,()=>{},this.rec.id);}while(left);this.onState({upload:'正在处理回放音频'});await api(`/recordings/${this.rec.id}/finish`,{method:'POST',body:{chunks:this.seq,...(this.needsTranscription?{needsTranscription:true}:{})}});this.onState({upload:'录音已保存，可以回放'});}
    catch(error){this.onState({upload:`${error.message}；请使用“恢复保存”重试`});throw error;}
    finally{this.onStopped?.();if(this.ws)setTimeout(()=>this.ws?.close(),125000);}
  }
  cleanup(closeSocket=true){clearInterval(this.timer);clearInterval(this.uploadTimer);clearTimeout(this.asrRetryTimer);if(this.onPageHide)window.removeEventListener('pagehide',this.onPageHide);this.running=false;this.stream?.getTracks().forEach(t=>t.stop());this.source?.disconnect();this.node?.disconnect();this.context?.close();this.wake?.release();if(closeSocket)this.ws?.close();}
}
