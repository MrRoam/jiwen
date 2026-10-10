import {randomUUID} from 'node:crypto';
import {initAudioAllowance,audioQuotaMode} from './audio-allowance.js';

const exhausted='本月转写额度已用完，录音仍会继续保存。';
const globallyExhausted='全站今日转写额度已用完，录音仍会继续保存。';
const trialExhausted='1 小时转写体验已用完。录音仍可保存，已有内容仍可回放和提问。想继续转写，可自行部署即问。';
const bytesPerSecond=32000; // 16 kHz、单声道、16-bit PCM。

function monthWindow(timestamp){
  const date=new Date(timestamp),year=date.getUTCFullYear(),month=date.getUTCMonth();
  return {start:new Date(Date.UTC(year,month,1)).toISOString(),end:new Date(Date.UTC(year,month+1,1)).toISOString()};
}
function dayWindow(timestamp){
  const date=new Date(timestamp),year=date.getUTCFullYear(),month=date.getUTCMonth(),day=date.getUTCDate();
  return {start:new Date(Date.UTC(year,month,day)).toISOString(),end:new Date(Date.UTC(year,month,day+1)).toISOString()};
}

// 使用独立用量表，删除课堂和重启都不能返还已发送的音频。
export function audioBudget(db,{perUser=36000,globalDaily=360000,mode='monthly'}={}){
  audioQuotaMode(mode);
  if(mode==='trial')initAudioAllowance(db,mode);
  if(mode==='monthly'&&(!Number.isSafeInteger(perUser)||perUser<=0))throw new Error('转写额度必须是正整数。');
  if(!Number.isSafeInteger(globalDaily)||globalDaily<=0)throw new Error('全站每日转写额度必须是正整数。');
  db.exec('CREATE INDEX IF NOT EXISTS asr_usage_user_month ON asr_usage(user_id,created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS asr_usage_global_day ON asr_usage(created_at)');
  // 仅保存 UTC 日及总秒数，注销账号不能返还已经发生的全站音频用量。
  db.exec('CREATE TABLE IF NOT EXISTS asr_global_usage(day TEXT PRIMARY KEY,seconds REAL NOT NULL DEFAULT 0)');
  const sum=db.prepare('SELECT COALESCE(SUM(seconds),0) AS seconds FROM asr_usage WHERE user_id=? AND created_at>=? AND created_at<?');
  const existingGlobalSum=db.prepare('SELECT COALESCE(SUM(seconds),0) AS seconds FROM asr_usage WHERE created_at>=? AND created_at<?');
  const seedGlobal=db.prepare('INSERT INTO asr_global_usage(day,seconds) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET seconds=MAX(asr_global_usage.seconds,excluded.seconds)');
  const globalSum=db.prepare('SELECT seconds FROM asr_global_usage WHERE day=?');
  const addGlobal=db.prepare('UPDATE asr_global_usage SET seconds=seconds+? WHERE day=?');
  const insert=db.prepare('INSERT INTO asr_usage(id,user_id,seconds,created_at) VALUES(?,?,0,?)');
  const add=db.prepare('UPDATE asr_usage SET seconds=seconds+? WHERE id=?');
  function ensureDay(timestamp){
    const day=dayWindow(timestamp),key=day.start.slice(0,10);
    // 初次接入旧库及恢复旧备份时取较大的已用量，既不漏算也不因删除个人记录回退。
    seedGlobal.run(key,existingGlobalSum.get(day.start,day.end).seconds);return {...day,key};
  }
  ensureDay(Date.now());
  function globalUsage(timestamp=Date.now()){
    const day=ensureDay(timestamp),globalUsedSeconds=globalSum.get(day.key).seconds;
    return {globalUsedSeconds,globalLimitSeconds:globalDaily,globalRemainingSeconds:Math.max(0,globalDaily-globalUsedSeconds),globalResetsAt:day.end};
  }
  function usage(userId,timestamp=Date.now()){
    const {start,end}=monthWindow(timestamp);
    const allowance=mode==='trial'?db.prepare('SELECT * FROM account_audio_allowance WHERE user_id=?').get(userId):null;
    if(mode==='trial'&&!allowance)throw new Error('暂时无法读取转写体验额度，请联系维护者。');
    const usedSeconds=allowance?allowance.used_seconds:sum.get(userId,start,end).seconds,limitSeconds=allowance?allowance.limit_seconds:perUser;
    return {period:mode==='trial'?'lifetime':'monthly',usedSeconds,limitSeconds,remainingSeconds:Math.max(0,limitSeconds-usedSeconds),resetsAt:mode==='trial'?null:end,...globalUsage(timestamp)};
  }
  function open(userId,sessionId=randomUUID(),onCharged=()=>{}){
    let charged=0;
    const rows=new Map();
    function state(timestamp){
      // 同一连接跨日也必须使用当天的记账行，不能把次日音频继续记在旧日。
      const {start}=dayWindow(timestamp);
      return {start,row:rows.get(start)||{id:`${sessionId}:${start}`,bytes:0,charged:0,createdAt:new Date(timestamp).toISOString()}};
    }
    function record(seconds,start,row){
      const day=ensureDay(Date.parse(start));
      if(!rows.has(start))insert.run(row.id,userId,row.createdAt);
      if(seconds>0){add.run(seconds,row.id);addGlobal.run(seconds,day.key);if(mode==='trial'){
        if(db.prepare('UPDATE account_audio_allowance SET used_seconds=used_seconds+? WHERE user_id=?').run(seconds,userId).changes!==1)throw new Error('暂时无法读取转写体验额度，请联系维护者。');
      }onCharged(seconds,{day:day.key});}
    }
    return {
      send(data,forward,timestamp=Date.now()){
        // 向上取整预留最后一秒，防止整数 duration 回报时突破额度。
        const {start,row}=state(timestamp),nextBytes=row.bytes+data.length,delta=Math.max(0,Math.ceil(nextBytes/bytesPerSecond)-row.charged);
        db.exec('BEGIN IMMEDIATE');
        try{
          const current=usage(userId,timestamp);
          if(delta>current.remainingSeconds){db.exec('ROLLBACK');return {accepted:false,code:mode==='trial'?'trial_exhausted':'quota_exhausted',error:mode==='trial'?trialExhausted:exhausted};}
          if(delta>current.globalRemainingSeconds){db.exec('ROLLBACK');return {accepted:false,code:'global_quota_exhausted',error:globallyExhausted};}
          if(!forward(data)){db.exec('ROLLBACK');return {accepted:false};}
          record(delta,start,row);db.exec('COMMIT');row.bytes=nextBytes;row.charged+=delta;rows.set(start,row);charged+=delta;
          return {accepted:true,chargedSeconds:delta};
        }catch(error){db.exec('ROLLBACK');throw error;}
      },
      onUsage(seconds,timestamp=Date.now()){
        if(!Number.isFinite(seconds)||seconds<0)return 0;
        const delta=Math.max(0,seconds-charged);
        if(delta<=0)return 0;
        const {start,row}=state(timestamp);
        db.exec('BEGIN IMMEDIATE');
        try{record(delta,start,row);db.exec('COMMIT');row.charged+=delta;rows.set(start,row);charged+=delta;return delta;}
        catch(error){db.exec('ROLLBACK');throw error;}
      }
    };
  }
  return {usage,globalUsage,open,personalExhausted:mode==='trial'?trialExhausted:exhausted};
}
