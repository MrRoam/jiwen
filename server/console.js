import {randomUUID} from 'node:crypto';

// 连接按账号去重；登录凭证失效、断线或心跳超时后移出在线统计。
export function createPresence(){
  const clients=new Map();
  function connect(socket,userId,valid=()=>true){
    const entry={userId,recording:false,alive:true};clients.set(socket,entry);
    socket.on('pong',()=>{entry.alive=true;});
    socket.on('message',raw=>{try{const value=JSON.parse(raw.toString());entry.recording=value.recording===true;}catch{}});
    socket.on('close',()=>clients.delete(socket));
    entry.valid=valid;
  }
  function sweep(){for(const [socket,entry] of clients){if(!entry.alive||!entry.valid()){clients.delete(socket);socket.terminate();continue;}entry.alive=false;socket.ping();}}
  function users(){return new Set([...clients.values()].map(entry=>entry.userId));}
  function recordingUsers(){return new Set([...clients.values()].filter(entry=>entry.recording).map(entry=>entry.userId));}
  function close(){for(const socket of clients.keys())socket.terminate();clients.clear();}
  return {connect,sweep,users,recordingUsers,close};
}

export function createConsole({db,presence,state,audioUsage,storageUsage,questionLimit,asrConcurrency,services,costUsage,now=Date.now}){
  const instanceId=randomUUID(),startedAt=now(),history=[];
  let cachedStorage,storageAt=-Infinity;
  const row=(sql,...args)=>db.prepare(sql).get(...args);
  function live(){
    const current=state(),online=presence.users(),recording=presence.recordingUsers();
    const recorders=new Set([...current.active.values()].filter(item=>recording.has(item.userId)).map(item=>item.userId));
    return {...current,online,recorders};
  }
  function sample(){
    const current=live(),timestamp=Math.floor(now()/60000)*60000;
    const value={at:timestamp,online:current.online.size,recording:current.recorders.size};
    if(history.at(-1)?.at===timestamp)history[history.length-1]=value;else history.push(value);
    while(history[0]?.at<timestamp-59*60000)history.shift();
  }
  function snapshot(){
    sample();const timestamp=now(),current=live(),day=new Date(timestamp).setUTCHours(0,0,0,0),end=day+86400000;
    const asr=audioUsage(),dayKey=new Date(day).toISOString().slice(0,10);
    const llm=row('SELECT COUNT(*) used,COALESCE(SUM(prompt_tokens),0) promptTokens,COALESCE(SUM(completion_tokens),0) completionTokens,COALESCE(SUM(usage_received),0) measuredRequests FROM llm_requests WHERE created_ms>=? AND created_ms<?',day,end);
    const calls=row("SELECT COUNT(*) total,SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed FROM llm_provider_requests WHERE created_ms>=? AND created_ms<?",day,end);
    if(!cachedStorage||timestamp-storageAt>=30000){cachedStorage=storageUsage();storageAt=timestamp;}
    const tasks=[];
    const recordingTasks=new Set([...current.active.keys(),...current.liveASR.keys(),...current.finalizing,...current.playback.keys(),...current.readers.keys()]);
    for(const id of recordingTasks){
      const item=current.active.get(id);
      const owner=row('SELECT u.email FROM recordings r JOIN lessons l ON l.id=r.lesson_id JOIN users u ON u.id=l.user_id WHERE r.id=?',id);
      const type=current.finalizing.has(id)?'saving':item&&current.recorders.has(item.userId)?'recording':current.liveASR.has(id)?'transcribing':item?'recovery':current.playback.has(id)?'converting':'playback';
      if(owner)tasks.push({id,email:owner.email,type,startedAt:item?.started});
    }
    for(const id of current.chatBusy){const owner=row('SELECT u.email FROM conversations c JOIN lessons l ON l.id=c.lesson_id JOIN users u ON u.id=l.user_id WHERE c.id=?',id);if(owner)tasks.push({id,email:owner.email,type:'answering'});}
    for(const token of current.tests){const owner=row('SELECT email FROM users WHERE id=?',token.split(':')[0]);if(owner)tasks.push({id:token,email:owner.email,type:'testing'});}
    if(current.background)tasks.push({id:'background',email:`${current.background} 个后台任务`,type:'background'});
    const blockers=recordingTasks.size+current.chatBusy.size+current.tests.size+current.background;
    return {instanceId,at:timestamp,startedAt,day:dayKey,resetsAt:end,
      costs:costUsage?.(dayKey,asr.globalUsedSeconds),
      live:{online:current.online.size,recording:current.recorders.size,transcribing:current.liveASR.size,answering:current.chatBusy.size,saving:current.finalizing.size,pendingRecordings:current.active.size-current.recorders.size},
      accounts:{total:row('SELECT COUNT(*) n FROM users WHERE email IS NOT NULL').n,newToday:row('SELECT COUNT(*) n FROM users WHERE email IS NOT NULL AND created_at>=? AND created_at<?',new Date(day).toISOString(),new Date(end).toISOString()).n},
      usage:{llm:{...llm,limit:questionLimit,remaining:Math.max(0,questionLimit-llm.used)},asr:{used:asr.globalUsedSeconds,limit:asr.globalLimitSeconds,remaining:asr.globalRemainingSeconds},calls:{total:calls.total,completed:calls.completed||0,failed:calls.failed||0}},
      history:[...history],tasks:tasks.slice(0,100),taskCount:tasks.length,
      system:{services:services(),memoryBytes:process.memoryUsage().rss,asrConcurrency,storage:{usedBytes:cachedStorage.globalUsedBytes,limitBytes:cachedStorage.globalLimitBytes,reservedBytes:cachedStorage.globalReservedBytes,freeBytes:cachedStorage.diskFreeBytes,minFreeBytes:cachedStorage.minFreeBytes,at:storageAt}},
      restart:{supported:process.connected===true&&typeof process.send==='function'&&process.env.JIWEN_SUPERVISED==='true',blockers}};
  }
  return {snapshot,sample};
}
