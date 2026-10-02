import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export function paraformer({key,url,model,onReady,onSentence,onUsage,onError,onFinish}) {
  const taskId = randomUUID();
  const ws = new WebSocket(url,{ headers:{Authorization:`Bearer ${key}`}, handshakeTimeout:10000, maxPayload:2*1024*1024 });
  let ready=false, finished=false, finishRequested=false, totalBytes=0;
  const timer=setTimeout(()=>fail('转写服务启动超时，请检查网络和配置。'),15000);
  function fail(message,diagnostic) { if(finished)return; finished=true; clearTimeout(timer); onError(message,diagnostic); ws.terminate(); }
  ws.on('open',()=>{
    const parameters={format:'pcm',sample_rate:16000};
    if(model.startsWith('paraformer'))Object.assign(parameters,{language_hints:['zh','en'],disfluency_removal_enabled:false});
    if(model.startsWith('fun-asr-realtime')||model.startsWith('fun-asr-flash-8k-realtime')||model.startsWith('paraformer-realtime-v2'))parameters.heartbeat=true;
    ws.send(JSON.stringify({header:{action:'run-task',task_id:taskId,streaming:'duplex'},payload:{task_group:'audio',task:'asr',function:'recognition',model,parameters,input:{}}}));
  });
  ws.on('message',data=>{
    let event; try { event=JSON.parse(data.toString()); } catch { return fail('转写服务返回了无法解析的数据。'); }
    const type=event.header?.event;
    if(type==='task-started') { clearTimeout(timer); ready=true; onReady(); if(finishRequested)end(); }
    if(type==='result-generated') {
      const s=event.payload?.output?.sentence;
      if(s?.text && !s.heartbeat) onSentence({...s,end_time:s.end_time??Math.round(totalBytes/32)});
      if(event.payload?.usage?.duration) onUsage(event.payload.usage.duration);
    }
    if(type==='task-failed') {const code=String(event.header?.error_code||'unknown').slice(0,80);fail(`转写服务未完成（${code}），请检查百炼额度和模型权限。`,{event:type,code});}
    if(type==='task-finished') { finished=true;clearTimeout(timer);onFinish();ws.close(); }
  });
  ws.on('error',error=>fail('无法连接转写服务，请检查百炼密钥、额度和网络。',{event:'socket-error',code:error.code}));
  ws.on('unexpected-response',(_req,res)=>{res.resume();fail(`转写服务拒绝连接（HTTP ${res.statusCode}），请检查密钥、地域和模型权限。`,{event:'http-rejected',status:res.statusCode});});
  ws.on('close',(code,reason)=>{ if(!finished)fail('转写连接中断，录音仍会保存；恢复连接后继续识别。',{event:'socket-close',code,reason:reason.toString().slice(0,120)}); });
  function end(){finishRequested=true;if(ready&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({header:{action:'finish-task',task_id:taskId,streaming:'duplex'},payload:{input:{}}}));}
  return {send(data){if(!ready||ws.readyState!==WebSocket.OPEN)return false;if(ws.bufferedAmount>32000*10){fail('转写网络积压，已停止本次识别。');return false;}totalBytes+=data.length;ws.send(data);return true;},finish:end,close(){finished=true;clearTimeout(timer);ws.terminate();}};
}

export async function testService({service,key,url,model,onUsage,signal}) {
  const started=Date.now();
  if(!key)return {ok:false,message:'未配置 API 密钥，请在侧栏「API 配置」中保存并测试。',elapsedMs:0};
  try{
    if(service==='asr')await new Promise((resolve,reject)=>{
      let provider;
      const timer=setTimeout(()=>{provider?.close();reject(new Error('转写测试超时，请检查网络和服务地址。'));},18000);
      const end=error=>{clearTimeout(timer);provider?.close();error?reject(new Error(error)):resolve();};
      try{provider=paraformer({key,url,model,onReady:()=>end(),onSentence:()=>{},onUsage:()=>{},onError:end,onFinish:()=>end('转写任务提前结束。')});}catch(error){end(error.message);}
    });
    else {let text='';await streamAnswer({key,baseUrl:url,model,messages:[{role:'user',content:'请只回复“连接成功”。'}],signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),onUsage,onText:value=>text+=value});if(!text.trim())throw new Error('问答服务没有返回内容。');}
    return {ok:true,message:service==='asr'?'转写任务启动成功；开始录音后可验证麦克风和识别结果。':'问答接口已返回测试回答。',elapsedMs:Date.now()-started};
  }catch(error){return {ok:false,message:error.name==='TimeoutError'?'测试超时，请检查网络和服务地址。':error.message,elapsedMs:Date.now()-started};}
}

export function answerRequest(baseUrl,model,messages,{maxTokens=1600}={}) {
  const openRouter=new URL(baseUrl).hostname==='openrouter.ai';
  const freeOnly=openRouter&&process.env.LLM_FREE_ONLY!=='false';
  if(freeOnly&&model!=='openrouter/free'&&(!model.endsWith(':free')||model.startsWith('openrouter/')))throw new Error('当前仅允许免费模型，请配置 openrouter/free 或具体模型的 :free 版本。');
  if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>1600)throw new Error('回答长度配置无效。');
  return {model,messages,stream:true,stream_options:{include_usage:true},max_tokens:maxTokens,enable_thinking:false,...(freeOnly?{provider:{max_price:{prompt:0,completion:0},allow_fallbacks:false}}:{})};
}
function answerError(code){return Number(code)===429?'问答服务暂时达到额度或繁忙限制，请稍后再试。':Number(code)===402?'问答服务余额或费用上限不足，已停止请求，请联系管理员。':Number(code)===404?'当前免费模型暂无可用服务，请稍后再试或联系管理员。':`问答服务返回 ${code}，请检查模型权限、额度和配置。`;}
function providerError(code){return Object.assign(new Error(answerError(code)),{status:Number(code)});}
export async function streamAnswer({key,baseUrl,model,messages,signal,onText,onUsage,maxTokens}) {
  const response=await fetch(`${baseUrl.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(answerRequest(baseUrl,model,messages,{maxTokens})),signal});
  if(!response.ok){const error=providerError(response.status),retry=response.headers.get('retry-after');error.retryAfterMs=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())):0;await response.body?.cancel();throw error;}
  const reader=response.body.getReader();const decoder=new TextDecoder();let pending='';let finished=false;
  function line(value){
    if(!value.startsWith('data:'))return;
    const raw=value.slice(5).trim();if(!raw)return;
    if(raw==='[DONE]'){finished=true;return;}
    let item;try{item=JSON.parse(raw);}catch{throw new Error('问答服务返回了不完整的数据。');}
    if(item.usage)onUsage?.(item.usage);
    if(item.error)throw providerError(item.error.code);
    if(item.choices?.[0]?.finish_reason==='error')throw new Error('问答服务未完成请求，请稍后重试。');
    const text=item.choices?.[0]?.delta?.content;if(text)onText(text);
    if(item.choices?.[0]?.finish_reason)finished=true;
  }
  try{
    while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});const lines=pending.split('\n');pending=lines.pop();lines.forEach(line);}
    pending+=decoder.decode();if(pending.trim())line(pending);
    if(!finished)throw new Error('回答连接提前断开，已保留收到的内容。');
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}
