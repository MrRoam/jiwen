// 合并和兼容回放共用队列，限制全站 FFmpeg 负载。
export function createWorkQueue(concurrency=1){
  if(!Number.isSafeInteger(concurrency)||concurrency<1)throw new Error('转换并发必须是正整数。');
  const waiting=[];let running=0;
  function drain(){while(running<concurrency&&waiting.length){const {work,resolve,reject}=waiting.shift();running++;Promise.resolve().then(work).then(resolve,reject).finally(()=>{running--;drain();});}}
  return work=>new Promise((resolve,reject)=>{waiting.push({work,resolve,reject});drain();});
}
