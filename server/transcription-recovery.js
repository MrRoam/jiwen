import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

const bytesPerMs=32;

function failure(message,code='recovery_failed',status){return Object.assign(new Error(message),{code,status});}
function aborted(signal){if(signal.aborted)throw signal.reason||failure('补转写已取消。','cancelled');}

// stdout 的背压跟随每次识别请求；整堂课不会被解码到内存。
export async function* decodeRecordingPCM(file,{signal}={}){
  const child=spawn(ffmpeg,['-v','error','-i',file,'-vn','-ar','16000','-ac','1','-f','s16le','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let launchError;
  const closed=new Promise(resolve=>{
    child.once('error',error=>{launchError=error;child.stdout.destroy(error);});
    child.once('close',(code,termination)=>resolve({code,termination}));
  });
  // 必须持续排空 stderr，避免 FFmpeg 管道阻塞；不输出录音或识别文本。
  child.stderr.resume();
  const stop=()=>{child.kill();child.stdout.destroy(signal?.reason||failure('补转写已取消。','cancelled'));};
  signal?.addEventListener('abort',stop,{once:true});
  try{
    if(signal)aborted(signal);
    for await(const buffer of child.stdout){if(signal)aborted(signal);yield buffer;}
    const result=await closed;
    if(signal)aborted(signal);
    if(launchError||result.code!==0)throw failure('录音解码失败，已有转写已保留。','decode_failed');
  }finally{
    signal?.removeEventListener('abort',stop);
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await closed;
  }
}

// 一个后台任务 FIFO；实时录音/转写有优先权。持久状态及累计计费由主服务提供。
export function createTranscriptionRecovery({
  db,dataDir,getUrl,canRun=()=>true,isRecordingBusy=()=>false,
  prepare=()=>{},chargeThrough=()=>{},reserveText=()=>({release(){}}),
  onState=()=>{},onComplete=()=>{},decode=decodeRecordingPCM,request=fetch,
  maxTextBytes=2*1024**2,maxQueued=128,maxStates=256,pollMs=1000,requestTimeoutMs=110000,
}={}){
  if(!db||!dataDir||typeof getUrl!=='function')throw new Error('补转写需要数据库、录音目录和本地服务地址。');
  if(!Number.isSafeInteger(maxTextBytes)||maxTextBytes<1)throw new Error('补转写文本上限无效。');
  if(!Number.isSafeInteger(maxQueued)||maxQueued<1||!Number.isSafeInteger(maxStates)||maxStates<maxQueued)throw new Error('补转写队列与状态上限无效。');
  const queue=[],states=new Map(),waiters=[];
  let running=null,closed=false,scheduled=false;
  const find=db.prepare('SELECT recordings.*,lessons.user_id FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE recordings.id=?');
  const oldCount=db.prepare('SELECT COUNT(*) AS n FROM segments WHERE recording_id=?');
  const remove=db.prepare('DELETE FROM segments WHERE recording_id=?');
  const insert=db.prepare('INSERT INTO segments(id,lesson_id,recording_id,start_ms,end_ms,text,final) VALUES(?,?,?,?,?,?,1)');
  function change(id,patch){
    const value={...states.get(id),...patch};states.delete(id);states.set(id,value);onState(id,value);
    // 当前任务与排队任务总量受 maxQueued 限制；终态只缓存有限条，完整状态保存在数据库。
    if(states.size>maxStates)for(const [key,state] of states){
      if(!['queued','running'].includes(state.state))states.delete(key);
      if(states.size<=maxStates)break;
    }
    return {...value};
  }
  function settle(){if(!running&&!queue.length)for(const resolve of waiters.splice(0))resolve();}
  function notify(){
    if(running&&(!canRun()||isRecordingBusy(running.id))&&!running.controller.signal.aborted){running.controller.abort(failure('等待实时录音结束后补转写。','preempted'));}
    if(closed||scheduled)return;
    scheduled=true;
    queueMicrotask(()=>{scheduled=false;void pump().catch(error=>console.error('补转写状态保存失败:',error.name));});
  }
  async function recognize(row,controller){
    const {signal}=controller;
    await prepare(row);aborted(signal);
    const url=getUrl().replace(/\/$/,''),streamId=randomUUID();
    let sequence=0,processedMs=0,stagedBytes=0,pending=Buffer.alloc(0),reservation;
    const segments=[];
    async function json(endpoint,options,timeout=requestTimeoutMs){
      aborted(signal);
      let response;
      try{response=await request(`${url}${endpoint}`,{...options,signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)])});}
      catch(error){aborted(signal);throw failure(error.name==='TimeoutError'?'本地转写处理超时，已有转写已保留。':'本地转写服务不可用，已有转写已保留。','service_failed');}
      if(!response.ok){let code;try{code=(await response.json()).error;}catch{}throw failure(['queue_full','stream_capacity','queue_timeout'].includes(code)?'本地转写处理能力已满，请稍后重试。':'本地转写服务不可用，已有转写已保留。',code||'service_failed');}
      return response.json();
    }
    function checkPriority(){
      if(!canRun()||isRecordingBusy(row.id))controller.abort(failure('等待实时录音结束后补转写。','preempted'));
      aborted(signal);
    }
    function add(result,startMs,endMs){
      if(!Array.isArray(result.segments))throw failure('本地转写返回无效结果，已有转写已保留。','invalid_result');
      const absolute=result.timeline==='stream',base=absolute?0:startMs;
      for(const item of result.segments){
        if(typeof item.text!=='string'||!Number.isFinite(item.start)||!Number.isFinite(item.end)||item.start<0||item.end<item.start||base+item.end*1000>endMs+100)throw failure('本地转写时间轴无效，已有转写已保留。','invalid_result');
        const text=item.text.trim();if(!text)continue;
        let start=Math.min(row.duration_ms,Math.round(base+item.start*1000)),end=Math.min(row.duration_ms,Math.round(base+item.end*1000));
        const previous=segments.at(-1);
        // 重复的流缓存结果只保留一次；不同文字的相交区间拒绝提交，避免产生错序文本。
        if(previous&&start<previous.end_ms-row.offset_ms){
          if(text===previous.text&&start===previous.start_ms-row.offset_ms&&end===previous.end_ms-row.offset_ms)continue;
          throw failure('本地转写返回重叠文字，已有转写已保留。','overlapping_result');
        }
        if(previous&&start===end&&end===previous.end_ms-row.offset_ms){
          if(text===previous.text)continue;
          stagedBytes+=Buffer.byteLength(text);previous.text+=text;
        }else{
          // 包括行与标识开销，和存储预算采用同一保守峰值。
          stagedBytes+=Buffer.byteLength(text)+256;
          segments.push({id:randomUUID(),lesson_id:row.lesson_id,recording_id:row.id,start_ms:row.offset_ms+start,end_ms:row.offset_ms+end,text,final:1});
        }
        if(stagedBytes>maxTextBytes)throw failure('补转写文本超过保存上限，已有转写已保留。','text_limit',409);
      }
    }
    async function send(buffer,final){
      checkPriority();
      const startMs=processedMs,endMs=startMs+buffer.length/bytesPerMs;
      await chargeThrough(row,endMs);aborted(signal);
      const result=await json('/transcribe',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-ASR-Stream':streamId,'X-ASR-Sequence':String(sequence++),'X-ASR-Final':final?'1':'0'},body:buffer});
      checkPriority();add(result,startMs,endMs);processedMs=endMs;
      change(row.id,{state:'running',error:'',processedMs:Math.round(processedMs)});
    }
    try{
      const health=await json('/health',{},5000);
      if(health.ready===false)throw failure('本地转写尚未就绪，已有转写已保留。','service_failed');
      const seconds=Number.isFinite(health.chunkSeconds)&&health.chunkSeconds>=.1&&health.chunkSeconds<=30?health.chunkSeconds:.6;
      const chunkBytes=Math.round(seconds*32000/2)*2;
      for await(const buffer of decode(path.join(dataDir,row.id,'audio.m4a'),{signal})){
        checkPriority();
        if(!Buffer.isBuffer(buffer))throw failure('录音解码结果无效。','decode_failed');
        pending=Buffer.concat([pending,buffer]);
        // 对真实流式解码，pending 最多一段加一个 stdout 缓冲；每次请求完成才读下一批。
        while(pending.length>=chunkBytes){
          if(processedMs+chunkBytes/bytesPerMs>row.duration_ms+2000)throw failure('录音时长与保存记录不匹配，已有转写已保留。','duration_mismatch');
          await send(pending.subarray(0,chunkBytes),false);pending=pending.subarray(chunkBytes);
        }
      }
      if(pending.length%2)throw failure('录音 PCM 尾段不完整，已有转写已保留。','decode_failed');
      if(processedMs+pending.length/bytesPerMs>row.duration_ms+2000)throw failure('录音时长与保存记录不匹配，已有转写已保留。','duration_mismatch');
      // 流式模型在整段恰好对齐时也需要空的 final 请求刷新尾字。
      if(pending.length||health.streaming===true)await send(pending,true);
      if(!processedMs)throw failure('已保存录音没有可识别音频，已有转写已保留。','empty_audio');
      if(!segments.length&&oldCount.get(row.id).n)throw failure('补转写没有返回文字，已有转写已保留。','empty_transcript');
      checkPriority();
      const current=find.get(row.id);
      if(!current||current.status!=='ready'||current.duration_ms!==row.duration_ms||current.offset_ms!==row.offset_ms)throw failure('录音内容已改变，请重新补转写。','recording_changed',409);
      await prepare(current);checkPriority();
      reservation=await reserveText(current,stagedBytes);checkPriority();
      db.exec('BEGIN IMMEDIATE');
      try{
        remove.run(row.id);for(const segment of segments)insert.run(segment.id,segment.lesson_id,segment.recording_id,segment.start_ms,segment.end_ms,segment.text);
        onComplete(current,segments);
        // 完成状态与新文字一起提交，重启不会把已替换成功的录音当成中断任务。
        change(row.id,{state:'completed',error:'',processedMs:Math.round(processedMs)});
        db.exec('COMMIT');
      }
      catch(error){db.exec('ROLLBACK');throw error;}
      return Math.round(processedMs);
    }finally{
      reservation?.release();pending=Buffer.alloc(0);
      try{await request(`${url}/streams/${streamId}`,{method:'DELETE',signal:AbortSignal.timeout(3000)});}catch{}
    }
  }
  async function pump(){
    if(closed||running||!queue.length||!canRun())return;
    const id=queue[0];if(isRecordingBusy(id))return;
    queue.shift();
    const controller=new AbortController();running={id,controller};
    try{
      const row=find.get(id);
      if(!row||row.status!=='ready')throw failure('请先完成录音保存，再补转写。','recording_unavailable',409);
      change(id,{state:'running',error:'',processedMs:0});
      await recognize(row,controller);
    }catch(error){
      const reason=controller.signal.aborted?controller.signal.reason:error;
      if(reason?.code==='preempted'||reason?.code==='shutdown'){
        change(id,{state:'queued',error:reason.message,processedMs:0});if(!queue.includes(id))queue.unshift(id);
      }else change(id,{state:reason?.code==='quota_exhausted'||[403,429,507].includes(reason?.status)||reason?.code==='storage_limit'?'blocked':'failed',error:reason?.message||'补转写失败，已有转写已保留。'});
    }finally{running=null;settle();if(!closed)notify();}
  }
  const timer=setInterval(notify,pollMs);timer.unref();
  return {
    enqueue(id,{force=false}={}){
      if(closed)throw new Error('补转写队列已关闭。');
      const state=states.get(id);
      if(queue.includes(id)||running?.id===id||(!force&&state?.state==='completed'))return {...state};
      if(!force){const row=find.get(id);if(row?.transcription_status==='completed'&&!row.transcription_needed)return {state:'completed',error:row.transcription_error||'',processedMs:row.transcription_processed_ms||0};}
      // 运行中的任务也占一个位置，抢占重新入队时无需突破上限。
      if(queue.length+(running?1:0)>=maxQueued)throw failure('补转写等待任务已满，请稍后重试；录音已保留。','recovery_queue_full',503);
      change(id,{state:'queued',error:'',processedMs:0});queue.push(id);notify();return {...states.get(id)};
    },
    notify,
    status(id){const value=states.get(id);return value?{...value}:null;},
    busy(id){return id===undefined?!!running:running?.id===id;},
    cancel(id){const index=queue.indexOf(id);if(index>=0)queue.splice(index,1);if(running?.id===id)running.controller.abort(failure('补转写已取消，已有转写已保留。','cancelled'));else states.delete(id);settle();notify();},
    idle(){return !running&&!queue.length?Promise.resolve():new Promise(resolve=>waiters.push(resolve));},
    async close(){if(closed)return;closed=true;clearInterval(timer);if(running)running.controller.abort(failure('服务重启后继续补转写。','shutdown'));while(running)await new Promise(resolve=>setTimeout(resolve,10));settle();},
  };
}
