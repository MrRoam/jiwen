// 本机服务接收 16 kHz 单声道 PCM；每 10 秒识别一次，暂停时处理尾段。
export function localASR({url,onReady,onSentence,onUsage,onError,onFinish}) {
  let pending=Buffer.alloc(0),offset=0,closed=false,finishing=false,queued=0;
  let chain=Promise.resolve();
  const controller=new AbortController();
  function fail(){if(closed)return;closed=true;controller.abort();onError('本地转写服务不可用或处理超时，请检查本地服务；录音仍会保存。');}
  function enqueue(pcm){
    const start=offset;offset+=pcm.length/32;queued+=pcm.length;
    if(queued>32000*120){fail();return;}
    chain=chain.then(async()=>{
      if(closed)return;
      const response=await fetch(`${url}/transcribe`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:pcm,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(110000)])});
      if(!response.ok)throw new Error('local ASR failed');
      const result=await response.json();
      if(!Array.isArray(result.segments))throw new Error('invalid response');
      for(const s of result.segments){if(typeof s.text!=='string'||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>pcm.length/32000+.1)throw new Error('invalid segment');
        if(s.text.trim())onSentence({text:s.text.trim(),begin_time:Math.round(start+s.start*1000),end_time:Math.round(start+s.end*1000),sentence_end:true});}
      queued-=pcm.length;onUsage(offset/1000);
    }).catch(fail);
  }
  fetch(`${url}/health`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])}).then(r=>{if(!r.ok)throw new Error('unavailable');if(!closed)onReady();}).catch(fail);
  return {send(data){if(closed||finishing)return false;pending=Buffer.concat([pending,data]);while(pending.length>=320000){enqueue(pending.subarray(0,320000));pending=pending.subarray(320000);}return !closed;},finish(){if(finishing||closed)return;finishing=true;if(pending.length)enqueue(pending);pending=Buffer.alloc(0);chain.then(()=>{if(!closed)onFinish();});},close(){closed=true;controller.abort();pending=Buffer.alloc(0);}};
}

export async function testLocalASR(url){
  const started=Date.now();
  try{const r=await fetch(`${url}/transcribe`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(32000),signal:AbortSignal.timeout(110000)});if(!r.ok)throw new Error();const result=await r.json();if(!Array.isArray(result.segments))throw new Error();return {ok:true,message:'本地模型已完成静音音频测试。',elapsedMs:Date.now()-started};}
  catch{return {ok:false,message:'本地转写未就绪，请先启动 server/local_asr.py。',elapsedMs:Date.now()-started};}
}
