import {randomUUID} from 'node:crypto';

// 本机服务接收 16 kHz 单声道 PCM，按 health 报告的分段时长提交；每路独立序号。
export function localASR({url,onReady,onSentence,onUsage,onError,onFinish}) {
  let pending=Buffer.alloc(0),offset=0,closed=false,finishing=false,queued=0,sequence=0;
  let chunkBytes=320000,streaming=false,engine;
  const streamId=randomUUID();
  let chain=Promise.resolve();
  const controller=new AbortController();
  function release(){fetch(`${url}/streams/${streamId}`,{method:'DELETE',signal:AbortSignal.timeout(3000)}).catch(()=>{});}
  function fail(error){
    if(closed)return;closed=true;controller.abort();pending=Buffer.alloc(0);release();
    const overloaded=['queue_full','stream_capacity','queue_timeout','client_queue_full'].includes(error?.code);
    onError(overloaded?'本地转写处理能力已满，请稍后重试；录音仍会保存。':'本地转写服务不可用或处理超时，请检查本地服务；录音仍会保存。',{event:overloaded?'local-asr-overloaded':'local-asr-error',code:error?.code||'unavailable',engine});
  }
  function enqueue(pcm,final=false){
    const start=offset,seq=sequence++;offset+=pcm.length/32;queued+=pcm.length;
    if(queued>32000*120){fail({code:'client_queue_full'});return;}
    chain=chain.then(async()=>{
      if(closed)return;
      const response=await fetch(`${url}/transcribe`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-ASR-Stream':streamId,'X-ASR-Sequence':String(seq),'X-ASR-Final':final?'1':'0'},body:pcm,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(110000)])});
      if(!response.ok){let code;try{code=(await response.json()).error;}catch{}throw Object.assign(new Error('local ASR failed'),{code:code||((response.status===429)?'queue_full':'unavailable')});}
      const result=await response.json();
      if(!Array.isArray(result.segments))throw new Error('invalid response');
      const absolute=result.timeline==='stream',base=absolute?0:start;
      for(const s of result.segments){if(typeof s.text!=='string'||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>((absolute?start/1000:0)+pcm.length/32000+.1))throw new Error('invalid segment');
        if(s.text.trim())onSentence({text:s.text.trim(),begin_time:Math.round(base+s.start*1000),end_time:Math.round(base+s.end*1000),sentence_end:true,timing:s.timing||result.timing});}
      queued-=pcm.length;onUsage((start+pcm.length/32)/1000);
    }).catch(fail);
  }
  fetch(`${url}/health`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])}).then(async r=>{
    if(!r.ok)throw new Error('unavailable');const health=await r.json();if(health.ready===false)throw new Error('unavailable');
    streaming=health.streaming===true;engine=health.engine;
    if(Number.isFinite(health.chunkSeconds)&&health.chunkSeconds>=.1&&health.chunkSeconds<=30)chunkBytes=Math.round(health.chunkSeconds*32000/2)*2;
    if(!closed)onReady(health);
  }).catch(fail);
  return {send(data){if(closed||finishing)return false;pending=Buffer.concat([pending,data]);while(pending.length>=chunkBytes&&!closed){enqueue(pending.subarray(0,chunkBytes));pending=pending.subarray(chunkBytes);}return !closed;},finish(){if(finishing||closed)return;finishing=true;if(pending.length||streaming)enqueue(pending,true);pending=Buffer.alloc(0);chain.then(()=>{if(!closed)onFinish();});},close(){if(closed)return;closed=true;controller.abort();pending=Buffer.alloc(0);release();}};
}

export async function testLocalASR(url){
  const started=Date.now();
  try{const healthResponse=await fetch(`${url}/health`,{signal:AbortSignal.timeout(5000)});if(!healthResponse.ok)throw new Error();const health=await healthResponse.json();if(health.ready===false)throw new Error();const r=await fetch(`${url}/transcribe`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(32000),signal:AbortSignal.timeout(110000)});if(!r.ok)throw new Error();const result=await r.json();if(!Array.isArray(result.segments))throw new Error();return {ok:true,message:'本地模型已完成静音音频测试；课堂准确率与并发容量需另行评测。',elapsedMs:Date.now()-started,capacity:health,metrics:result.metrics};}
  catch{return {ok:false,message:'本地转写未就绪，请先启动 server/local_asr.py。',elapsedMs:Date.now()-started};}
}
