import {readdirSync,statSync,statfsSync} from 'node:fs';
import path from 'node:path';

const MiB=1024**2,GiB=1024**3;
const sourcePerSecond=16000,outputPerSecond=10000,mp3PerSecond=14000;
const overhead=2*MiB,tailBytes=2*MiB;
const peakPerSecond=sourcePerSecond*2+outputPerSecond+mp3PerSecond;
const rowOverhead=128;

export class StorageLimitError extends Error {
  constructor(message){super(message);this.name='StorageLimitError';this.status=409;this.code='storage_limit';}
}

function treeBytes(directory){
  let bytes=0;
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink())continue;
    try{bytes+=entry.isDirectory()?treeBytes(file):statSync(file).size;}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return bytes;
}

// 账号按音频实际字节+数据库UTF-8内容及每行128字节开销计量。
// 全站按磁盘实际字节计量，数据库/WAL已经在其中，不再加账号逻辑文本。
// 所有准入及预留在同一事件循环同步完成。
export function createStorageBudget(db,{dataDir,accountBytes=500*MiB,globalBytes=100*GiB,minFreeBytes=20*GiB,maxRecordingSeconds=7200,statfs=statfsSync}={}){
  if(!dataDir)throw new Error('存储预算需要 dataDir。');
  for(const [name,value] of Object.entries({accountBytes,globalBytes,maxRecordingSeconds}))if(!(value===null&&name!=='maxRecordingSeconds')&&(!Number.isSafeInteger(value)||value<=0))throw new Error(`${name} 必须是正整数。`);
  if(!Number.isSafeInteger(minFreeBytes)||minFreeBytes<0)throw new Error('minFreeBytes 必须是非负整数。');
  const reservations=new Map(),textReservations=new Map();
  const identifier=name=>`"${name.replaceAll('"','""')}"`;
  function logicalBytes(){
    const users=new Map();
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
      const table=identifier(name),columns=db.prepare(`PRAGMA table_info(${table})`).all(),names=new Set(columns.map(column=>column.name));
      let owner,join='';
      if(name==='users')owner='t.id';
      else if(names.has('user_id'))owner='t.user_id';
      else if(names.has('lesson_id')){owner='l.user_id';join=' JOIN lessons l ON l.id=t.lesson_id';}
      else if(names.has('recording_id')){owner='l.user_id';join=' JOIN recordings r ON r.id=t.recording_id JOIN lessons l ON l.id=r.lesson_id';}
      else if(names.has('conversation_id')){owner='l.user_id';join=' JOIN conversations c ON c.id=t.conversation_id JOIN lessons l ON l.id=c.lesson_id';}
      else if(names.has('segment_id')){owner='l.user_id';join=' JOIN segments s ON s.id=t.segment_id JOIN lessons l ON l.id=s.lesson_id';}
      else continue;
      const size=columns.map(column=>`COALESCE(length(CAST(t.${identifier(column.name)} AS BLOB)),0)`).join('+');
      for(const row of db.prepare(`SELECT ${owner} AS userId,SUM(${rowOverhead}+${size}) AS bytes FROM ${table} t${join} GROUP BY ${owner}`).all())if(row.userId)users.set(row.userId,(users.get(row.userId)||0)+row.bytes);
    }
    return users;
  }
  function scan(){
    const owners=new Map(db.prepare('SELECT recordings.id,lessons.user_id FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id').all().map(row=>[row.id,row.user_id]));
    const users=new Map(),recordings=new Map();let total=0;
    for(const entry of readdirSync(dataDir,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;
      const file=path.join(dataDir,entry.name);let bytes;
      try{bytes=entry.isDirectory()?treeBytes(file):statSync(file).size;}catch(error){if(error.code==='ENOENT')continue;throw error;}
      total+=bytes;
      if(entry.isDirectory()&&owners.has(entry.name)){
        recordings.set(entry.name,bytes);const userId=owners.get(entry.name);users.set(userId,(users.get(userId)||0)+bytes);
      }
    }
    const disk=statfs(dataDir),free=Number(disk.bavail)*Number(disk.bsize);
    if(!Number.isFinite(free)||free<0)throw new Error('无法读取磁盘可用空间。');
    const text=logicalBytes(),audio=new Map(users);
    for(const [userId,bytes] of text)users.set(userId,(users.get(userId)||0)+bytes);
    return {total,users,recordings,free,text,audio};
  }
  function reserved(state,userId,exclude){
    let bytes=0;for(const [rid,permit] of reservations){if(rid===exclude||(userId!==undefined&&permit.userId!==userId))continue;bytes+=Math.max(0,permit.target-(state.recordings.get(rid)||0));}
    // 账号使用逻辑文本字节；全站另为SQLite数据页/WAL扩展按两倍预留。
    for(const permit of textReservations.values())if(userId===undefined||permit.userId===userId)bytes+=permit.bytes*(userId===undefined?2:1);
    return bytes;
  }
  function available(state,userId,exclude){
    return Math.max(0,Math.min(accountBytes===null?Infinity:accountBytes-(state.users.get(userId)||0)-reserved(state,userId,exclude),globalBytes===null?Infinity:globalBytes-state.total-reserved(state,undefined,exclude),state.free-minFreeBytes-reserved(state,undefined,exclude)));
  }
  function begin(recordingId,userId,maxSeconds=maxRecordingSeconds){
    const previous=reservations.get(recordingId);
    if(previous&&previous.userId!==userId)throw new StorageLimitError('录音归属不匹配。');
    if(!Number.isFinite(maxSeconds)||maxSeconds<=0)throw new StorageLimitError('可录音时长不足。');
    if(previous&&Number.isSafeInteger(previous.maxSeconds)&&previous.maxSeconds>0)return {maxSeconds:previous.maxSeconds,reservedBytes:previous.target};
    const state=scan(),row=db.prepare('SELECT duration_ms FROM recordings WHERE id=?').get(recordingId);
    const source=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM chunks WHERE recording_id=?').get(recordingId).bytes;
    const durationMs=row?.duration_ms||0;
    // 中断许可只有恢复空间，没有采集时长；重启采集时重新计算有限的可录时长。
    // 已有原始块与已录时长还需要后续合并/编码空间，不能仅预留新增音频。
    const existingConversion=source+Math.ceil(durationMs/1000)*(outputPerSecond+mp3PerSecond);
    const seconds=Math.min(Math.floor(maxSeconds),maxRecordingSeconds,Math.floor((available(state,userId,recordingId)-existingConversion-overhead-tailBytes)/peakPerSecond));
    if(seconds<1)throw new StorageLimitError('保存空间不足，请先导出或删除旧课堂。');
    const current=state.recordings.get(recordingId)||0,target=current+existingConversion+seconds*peakPerSecond+overhead+tailBytes;
    reservations.set(recordingId,{userId,target,maxSeconds:seconds,stopDurationMs:durationMs+seconds*1000,sourceLimit:source+seconds*sourcePerSecond+tailBytes});
    return {maxSeconds:seconds,reservedBytes:target-current};
  }
  function preflight(recordingId,userId,additionalBytes,{replace=false}={}){
    if(!Number.isSafeInteger(additionalBytes)||additionalBytes<0)throw new Error('待写入字节数无效。');
    const state=scan(),current=state.recordings.get(recordingId)||0,old=reservations.get(recordingId);
    if(old&&old.userId!==userId)throw new StorageLimitError('录音归属不匹配。');
    // 已停止采集的转换可以用实际峰值替换整段录音计划，释放未使用的未来空间。
    // 补回缺失分段仍使用默认模式，保留正在录音的原预留。
    const target=replace?current+additionalBytes:Math.max(old?.target||0,current+additionalBytes);
    if(target-current>available(state,userId,recordingId))throw new StorageLimitError('转换所需空间不足，原始录音已保留，请释放空间后重试。');
    reservations.set(recordingId,replace?{userId,target}:{...old,userId,target});return {reservedBytes:target-current};
  }
  function onChunk(recordingId,userId,bytes,durationMs){
    if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isFinite(durationMs)||durationMs<0)throw new Error('音频分段大小或时长无效。');
    const raw=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM chunks WHERE recording_id=?').get(recordingId).bytes;
    let permit=reservations.get(recordingId);
    if(!permit){
      // 重启或迟到补传也保留合并输入、编码回放的空间，不只检查这一段。
      preflight(recordingId,userId,(raw+bytes)+bytes+Math.ceil(durationMs/1000)*(outputPerSecond+mp3PerSecond)+overhead);
      permit=reservations.get(recordingId);
    }else if(permit.sourceLimit===undefined){
      // 迟到补传的长度并未预先确定，逐段扩大合并峰值；不得侵占别人的预留。
      preflight(recordingId,userId,(raw+bytes)+bytes+Math.ceil(durationMs/1000)*(outputPerSecond+mp3PerSecond)+overhead);
      permit=reservations.get(recordingId);
    }else{
      if(permit.userId!==userId)throw new StorageLimitError('录音归属不匹配。');
      if(permit.sourceLimit!==undefined&&raw+bytes>permit.sourceLimit)throw new StorageLimitError('本次录音预留已用完，已有分段和待上传内容已保留，请停止录音并释放空间。');
      const state=scan(),current=state.recordings.get(recordingId)||0;
      // 已开始录音消费自身预留；新的任务只能使用预留之外的空间。
      if(current+bytes>permit.target||bytes>available(state,userId,recordingId))throw new StorageLimitError('录音保存空间不足，待上传内容已保留。');
    }
    return {maxSeconds:permit.maxSeconds,stopSoon:permit.sourceLimit!==undefined&&(raw+bytes>=permit.sourceLimit-tailBytes||durationMs>=permit.stopDurationMs)};
  }
  function preflightText(userId,bytes){
    if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('文本预留字节数无效。');
    const state=scan();
    if((accountBytes!==null&&bytes>accountBytes-(state.users.get(userId)||0)-reserved(state,userId))||(globalBytes!==null&&bytes*2>globalBytes-state.total-reserved(state))||bytes*2>state.free-minFreeBytes-reserved(state))throw new StorageLimitError('保存空间不足，请先导出或删除旧课堂。');
    return {bytes};
  }
  function reserveText(userId,bytes){
    preflightText(userId,bytes);const token=Symbol('text');textReservations.set(token,{userId,bytes});let released=false;
    return {release(){if(released)return;released=true;textReservations.delete(token);}};
  }
  function interrupt(recordingId,userId,durationMs){
    const old=reservations.get(recordingId);if(!old)return;
    if(old.userId!==userId)throw new StorageLimitError('录音归属不匹配。');
    const state=scan(),current=state.recordings.get(recordingId)||0;
    const row=db.prepare('SELECT duration_ms FROM recordings WHERE id=?').get(recordingId),raw=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM chunks WHERE recording_id=?').get(recordingId).bytes;
    const duration=Math.max(row?.duration_ms||0,Number.isFinite(durationMs)&&durationMs>=0?durationMs:0);
    const desired=current+raw+tailBytes*2+Math.ceil((duration+30000)/1000)*(outputPerSecond+mp3PerSecond)+overhead;
    // 中断只缩小已有许可，不新占用别人的预算；迟到的长音频随后重新准入。
    const target=Math.max(current,Math.min(old.target,desired));reservations.set(recordingId,{userId,target});
    return {reservedBytes:Math.max(0,target-current)};
  }
  function usage(userId){const state=scan(),usedBytes=state.users.get(userId)||0,reservedBytes=reserved(state,userId);return {usedBytes,audioBytes:state.audio.get(userId)||0,textBytes:state.text.get(userId)||0,limitBytes:accountBytes,reservedBytes,remainingBytes:accountBytes===null?null:Math.max(0,accountBytes-usedBytes-reservedBytes),globalUsedBytes:state.total,globalLimitBytes:globalBytes,globalReservedBytes:reserved(state),diskFreeBytes:state.free,minFreeBytes,maxRecordingSeconds};}
  function release(recordingId){reservations.delete(recordingId);}
  return {begin,onChunk,preflight,preflightText,reserveText,interrupt,finish:release,release,usage};
}
