import {performance} from 'node:perf_hooks';

// 控制新任务启动速率，不限制已启动任务持续发送音频。
export function createASRStartQueue({startsPerSecond=15,maxQueued=128,clock=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(!Number.isFinite(startsPerSecond)||startsPerSecond<=0||startsPerSecond>20)throw new Error('云转写启动速率必须大于0且不超过每秒20次。');
  if(!Number.isSafeInteger(maxQueued)||maxQueued<1)throw new Error('云转写启动队列上限无效。');
  const waiting=[],interval=1000/startsPerSecond;
  let nextAt=0,timer,closed=false;
  function drain(){
    if(closed||timer!==undefined||!waiting.length)return;
    const remaining=nextAt-clock();
    if(remaining>0){timer=setTimer(()=>{timer=undefined;drain();},Math.ceil(remaining));timer?.unref?.();return;}
    const item=waiting.shift();nextAt=clock()+interval;
    try{item.start();}catch(error){item.onError(error);}
    drain();
  }
  function schedule(start,onError){
    if(closed)throw new Error('云转写启动队列已关闭。');
    if(waiting.length>=maxQueued)throw new Error('云转写启动排队已满，录音仍会保存，请稍后重试。');
    const item={start,onError};waiting.push(item);drain();
    return ()=>{const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);};
  }
  return {
    create(factory,onError){
      let provider,cancel=()=>{},ended=false,finishing=false;
      const fail=error=>{if(!ended){ended=true;onError(error.message,{event:'start-queue-error'});}};
      try{cancel=schedule(()=>{if(ended)return;provider=factory();if(finishing)provider.finish();},fail);}
      catch(error){queueMicrotask(()=>fail(error));}
      return {
        send:data=>!ended&&!!provider?.send(data),
        finish(){finishing=true;if(!ended)provider?.finish();},
        close(){ended=true;cancel();provider?.close();},
      };
    },
    close(){closed=true;if(timer!==undefined)clearTimer(timer);timer=undefined;waiting.length=0;},
  };
}
