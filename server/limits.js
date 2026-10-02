import {setTimeout as delay} from 'node:timers/promises';
// 删除课堂、重启服务都不会返还已发出的调用。
export function requestBudget(db,{perUser=5,daily=40,perMinute=10}={}){
 db.exec('CREATE TABLE IF NOT EXISTS llm_requests(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,created_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS llm_requests_time ON llm_requests(created_ms)');
 const columns=new Set(db.prepare('PRAGMA table_info(llm_requests)').all().map(c=>c.name));
 for(const name of ['prompt_tokens','completion_tokens','usage_received'])if(!columns.has(name))db.exec(`ALTER TABLE llm_requests ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
 const count=(sql,...args)=>db.prepare(sql).get(...args).n;
 function reserve(userId,timestamp=Date.now()){
  const day=new Date(timestamp).setUTCHours(0,0,0,0);db.exec('BEGIN IMMEDIATE');
  try{
   let error=null;
   if(count('SELECT COUNT(*) n FROM llm_requests WHERE created_ms>=?',day)>=daily)error='今日全站问答额度已用完，请在下一次北京时间 08:00 后再试。';
   else if(count('SELECT COUNT(*) n FROM llm_requests WHERE user_id=? AND created_ms>=?',userId,day)>=perUser)error='你的今日问答额度已用完，请在下一次北京时间 08:00 后再试。';
   else if(count('SELECT COUNT(*) n FROM llm_requests WHERE created_ms>?',timestamp-60000)>=perMinute)error='当前提问较多，请一分钟后再试。';
   if(!error)reserve.lastId=db.prepare('INSERT INTO llm_requests(user_id,created_ms) VALUES(?,?)').run(userId,timestamp).lastInsertRowid;
   db.exec('COMMIT');return error;
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 const active=new Map();
 reserve.acquire=async(userId,signal,{waitMs=65000}={})=>{
  if((active.get(userId)||0)>=2)return {error:'已有两个问题正在处理，请等待回答完成。',release(){}};
  active.set(userId,(active.get(userId)||0)+1);let released=false;
  const release=()=>{if(!released){released=true;const n=active.get(userId)-1;if(n)active.set(userId,n);else active.delete(userId);}};
  const deadline=Date.now()+waitMs;
  try{
   while(true){
    signal?.throwIfAborted();const error=reserve(userId);
    if(!error){const requestId=reserve.lastId;return {release,onUsage:usage=>{
      const prompt=usage?.prompt_tokens,completion=usage?.completion_tokens;
      if(Number.isSafeInteger(prompt)&&prompt>=0&&Number.isSafeInteger(completion)&&completion>=0)db.prepare('UPDATE llm_requests SET prompt_tokens=?,completion_tokens=?,usage_received=1 WHERE id=?').run(prompt,completion,requestId);
    }};}
    if(!error.includes('一分钟')||Date.now()>=deadline){release();return {error,release};}
    await delay(250,undefined,{signal});
   }
  }catch(error){release();throw error;}
 };
 reserve.usage=(userId)=>{
  const day=new Date().setUTCHours(0,0,0,0);
  const row=db.prepare('SELECT COUNT(*) requests,COALESCE(SUM(prompt_tokens),0) promptTokens,COALESCE(SUM(completion_tokens),0) completionTokens,COALESCE(SUM(usage_received),0) measuredRequests FROM llm_requests WHERE user_id=? AND created_ms>=?').get(userId,day);
  return {...row,limit:perUser,remaining:Math.max(0,perUser-row.requests),resetsAt:new Date(day+86400000).toISOString()};
 };
 return reserve;
}
