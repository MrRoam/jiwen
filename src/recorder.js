import { api } from './api.js';

let databasePromise;
function database(){return databasePromise ||=new Promise((resolve,reject)=>{const request=indexedDB.open('tingjian-recording-queue',1);request.onupgradeneeded=()=>request.result.createObjectStore('chunks',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function put(value){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('chunks','readwrite');tx.objectStore('chunks').put(value);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
async function remove(key){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('chunks','readwrite');tx.objectStore('chunks').delete(key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
async function entries(){const db=await database();return new Promise((resolve,reject)=>{const req=db.transaction('chunks').objectStore('chunks').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
const uploading=new Map();
export async function flushPending(userId,onState=()=>{}){
  if(uploading.has(userId))return uploading.get(userId);
  const job=(async()=>{const chunks=(await entries()).filter(c=>c.userId===userId).sort((a,b)=>a.recordingId.localeCompare(b.recordingId)||a.seq-b.seq);
    for(const c of chunks){let response;try{response=await fetch(`/api/recordings/${c.recordingId}/chunks/${c.seq}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Duration-Ms':String(c.duration)},body:c.blob});}catch{throw new Error('网络中断，录音分段已暂存在此设备');}if(response.status===404){await remove(c.key);continue;}if(!response.ok){const error=await response.json();throw new Error(error.error||'录音上传失败');}await remove(c.key);}
    const left=(await entries()).filter(c=>c.userId===userId).length;onState(left?`${left} 段等待上传`:'录音已同步');return left;
  })();uploading.set(userId,job);try{return await job;}finally{uploading.delete(userId);}
}
export async function pendingCount(userId){return(await entries()).filter(c=>c.userId===userId).length;}

export class ClassroomRecorder {
  constructor({lessonId,userId,onSegment,onState,onTime,onStopped,deviceId='',lessonTitle,onLessonCreated,importanceEnabled=false}){Object.assign(this,{lessonId,userId,onSegment,onState,onTime,onStopped,deviceId,lessonTitle,onLessonCreated,importanceEnabled});this.running=false;this.stopping=false;this.seq=0;this.queue=Promise.resolve();this.sentSamples=0;this.asrReady=false;this.asrPending=[];this.asrRetries=0;}
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
      this.media.ondataavailable=e=>{if(!e.data.size)return;const seq=this.seq++,duration=Math.round(performance.now()-this.startedAt);this.queue=this.queue.then(()=>put({key:`${this.rec.id}:${seq}`,recordingId:this.rec.id,userId:this.userId,seq,duration,blob:e.data})).then(()=>{flushPending(this.userId,text=>this.onState({upload:text})).catch(()=>this.onState({upload:'网络中断，录音暂存在此设备'}));}).catch(()=>this.onState({upload:'本机保存失败，请立即结束并检查存储空间',error:true}));};
      this.startedAudio=this.context.currentTime;this.startedAt=performance.now();this.running=true;this.media.start(5000);
      if(this.createdLesson)await this.onLessonCreated?.(this.lessonId);
      this.onPageHide=()=>navigator.sendBeacon(`/api/recordings/${this.rec.id}/interrupt`);window.addEventListener('pagehide',this.onPageHide);
      this.timer=setInterval(()=>{const elapsed=Math.round(performance.now()-this.startedAt);this.onTime(this.rec.offsetMs+elapsed);if(performance.now()-this.lastPCM>3000)this.onState({capture:'未收到音频数据，请检查设备或重新录音',inputLevel:0});if(elapsed>=this.rec.maxSeconds*1000)this.stop().catch(error=>this.onState({upload:error.message}));},250);
      this.uploadTimer=setInterval(()=>flushPending(this.userId,text=>this.onState({upload:text})).catch(()=>{}),10000);
      if(this.rec.asrReady)this.connectASR();else this.onState({asr:'仅录音 · 转写服务未配置'});
      this.onState({upload:'正在录音，每 5 秒保存一次'});
      try{this.wake=await navigator.wakeLock?.request('screen');}catch{}
      const ended=()=>{if(this.running&&!this.stopping){this.onState({capture:'音源已断开，正在保存已录内容'});this.stop().catch(error=>this.onState({upload:error.message}));}};track.onended=ended;
    }catch(error){this.cleanup();if(this.media?.state==='recording')this.media.stop();if(this.rec?.id&&!this.seq)await api(`/recordings/${this.rec.id}/cancel`,{method:'POST'}).catch(()=>{});if(this.createdLesson&&!this.seq)await api(`/lessons/${this.lessonId}`,{method:'DELETE'}).catch(()=>{});throw error;}
  }
  connectASR(){
    if(!this.running||this.stopping)return;
    if(this.ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(this.ws.readyState))return;
    clearTimeout(this.asrRetryTimer);this.asrError=null;this.onState({asr:'正在连接实时转写'});const base=this.startedAt===undefined?this.sentSamples/16:Math.max(0,performance.now()-this.startedAt);
    const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/asr?recordingId=${this.rec.id}&offsetMs=${base}`);this.ws=ws;
    ws.onmessage=e=>{if(this.ws!==ws)return;const event=JSON.parse(e.data);if(event.type==='ready'){ws.send(JSON.stringify({type:'offset',offsetMs:this.asrPending[0]?.offsetMs??base}));this.asrReady=true;this.asrRetries=0;for(const chunk of this.asrPending){if(Number.isFinite(chunk.offsetMs))ws.send(JSON.stringify({type:'packet',offsetMs:chunk.offsetMs}));ws.send(chunk);}this.asrPending=[];this.onState({asr:this.asrDropped?'实时转写已恢复，断线期间部分音频未转写':'实时转写已连接'});this.asrDropped=false;}if(event.type==='segment')this.onSegment(event.segment);if(event.type==='error'){this.asrError=event.error;this.onState({asr:event.error});}};
    ws.onclose=()=>{if(this.ws!==ws)return;this.asrReady=false;this.ws=null;if(this.running&&!this.stopping){const delay=Math.min(30000,1000*2**Math.min(this.asrRetries++,5));this.onState({asr:`${this.asrError||'转写已断开'}；${Math.round(delay/1000)} 秒后自动重连，录音继续保存`});this.asrRetryTimer=setTimeout(()=>this.connectASR(),delay);}};
    ws.onerror=()=>{if(this.ws===ws)this.onState({asr:'转写连接失败，等待自动重连'});};
  }
  queueASR(data){this.asrPending.push(data);while(this.asrPending.reduce((n,b)=>n+b.byteLength,0)>160000){this.asrPending.shift();this.asrDropped=true;}}
  async stop(){
    if(this.stopping||!this.running)return;this.stopping=true;this.onState({upload:'正在保存最后一段录音'});clearInterval(this.timer);clearInterval(this.uploadTimer);
    if(this.media.state!=='inactive')this.media.stop();await this.mediaStopped;
    this.node.port.postMessage('flush');await new Promise(resolve=>setTimeout(resolve,60));if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'finish'}));
    await this.queue;this.running=false;this.cleanup(false);await api(`/recordings/${this.rec.id}/interrupt`,{method:'POST'}).catch(()=>{});
    try{let left;do{left=await flushPending(this.userId);}while(left);this.onState({upload:'正在处理回放音频'});await api(`/recordings/${this.rec.id}/finish`,{method:'POST',body:{chunks:this.seq}});this.onState({upload:'录音已保存，可以回放'});}
    catch(error){this.onState({upload:`${error.message}；请使用“恢复保存”重试`});throw error;}
    finally{this.onStopped();setTimeout(()=>this.ws?.close(),125000);}
  }
  cleanup(closeSocket=true){clearInterval(this.timer);clearInterval(this.uploadTimer);clearTimeout(this.asrRetryTimer);if(this.onPageHide)window.removeEventListener('pagehide',this.onPageHide);this.running=false;this.stream?.getTracks().forEach(t=>t.stop());this.source?.disconnect();this.node?.disconnect();this.context?.close();this.wake?.release();if(closeSocket)this.ws?.close();}
}
