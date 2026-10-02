import {streamAnswer} from './providers.js';

export const NEMOTRON_FREE='nvidia/nemotron-3-ultra-550b-a55b:free';
export function routingConfig(env=process.env){
  const enabled=env.LLM_ROUTING==='openrouter-first';
  const baseUrl=env.LLM_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1';
  // 更换供应商时不会默认把百炼密钥发送给另一家；显式独立密钥仍可自由配置。
  const reuseKey=env.LLM_USE_ASR_KEY!=='false'&&['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com'].includes(new URL(baseUrl).hostname);
  const fallback={name:'qwen',key:env.LLM_API_KEY||(reuseKey?env.DASHSCOPE_API_KEY:'')||'',baseUrl,model:env.LLM_MODEL||'qwen3.7-flash'};
  const primary={name:'openrouter',key:env.OPENROUTER_API_KEY||'',baseUrl:'https://openrouter.ai/api/v1',model:NEMOTRON_FREE};
  const daily=Number(env.OPENROUTER_FREE_DAILY_REQUESTS||1000),reserve=Number(env.OPENROUTER_FREE_RESERVE_REQUESTS||100);
  if(!Number.isSafeInteger(daily)||daily<1||!Number.isSafeInteger(reserve)||reserve<0||reserve>=daily)throw new Error('OpenRouter 每日请求上限和预留次数配置不正确。');
  return {enabled,primary,fallback,daily,reserve};
}

// 统计实际发往供应商的请求；与账号额度分开，失败和重启也不返还。
export function createAnswerRouter({db,reserveRequest,enabled,primary,fallback,daily=1000,reserve=100,stream=streamAnswer,clock=Date.now}){
  db.exec(`CREATE TABLE IF NOT EXISTS llm_provider_requests(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,reason TEXT NOT NULL,created_ms INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'started',prompt_tokens INTEGER,completion_tokens INTEGER);
    CREATE INDEX IF NOT EXISTS llm_provider_requests_day ON llm_provider_requests(provider,created_ms);
    CREATE TABLE IF NOT EXISTS llm_route_state(provider TEXT PRIMARY KEY,cooldown_until INTEGER NOT NULL);`);
  const day=()=>new Date(clock()).setUTCHours(0,0,0,0);
  const used=()=>db.prepare("SELECT COUNT(*) n FROM llm_provider_requests WHERE provider='openrouter' AND created_ms>=?").get(day()).n;
  function selectAndRecord(userId,quick=false){
    db.exec('BEGIN IMMEDIATE');
    try{
      let route=fallback,reason=enabled?'primary-key-missing':'configured-model';
      if(quick&&fallback.key)reason='help-direct';
      else if(enabled&&primary.key){
        const cooldown=db.prepare("SELECT cooldown_until FROM llm_route_state WHERE provider='openrouter'").get()?.cooldown_until||0;
        if(used()>=daily-reserve)reason='free-daily-reserve';
        else if(cooldown>clock())reason='provider-rate-limit';
        else {route=primary;reason='primary';}
      }
      if(!route.key)throw new Error('所选问答服务未配置密钥，请联系管理员。');
      const id=record(userId,route,reason);db.exec('COMMIT');return {route,id};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function record(userId,route,reason){return db.prepare('INSERT INTO llm_provider_requests(user_id,provider,model,reason,created_ms) VALUES(?,?,?,?,?)').run(userId,route.name,route.model,reason,clock()).lastInsertRowid;}
  async function attempt({route,id},permit,options){
    let visible=false;
    try{
      await stream({...route,...options,onText:text=>{if(text)visible=true;options.onText(text);},onUsage:usage=>{
        permit.onUsage(usage);
        if(Number.isSafeInteger(usage?.prompt_tokens)&&usage.prompt_tokens>=0&&Number.isSafeInteger(usage?.completion_tokens)&&usage.completion_tokens>=0)db.prepare('UPDATE llm_provider_requests SET prompt_tokens=?,completion_tokens=? WHERE id=?').run(usage.prompt_tokens,usage.completion_tokens,id);
      }});
      db.prepare("UPDATE llm_provider_requests SET status='complete' WHERE id=?").run(id);
    }catch(error){db.prepare("UPDATE llm_provider_requests SET status='failed' WHERE id=?").run(id);error.hasVisibleText=visible;throw error;}
  }
  return {
    ready:!!(fallback.key||(enabled&&primary.key)),
    status(){return {enabled,primaryConfigured:!!primary.key,primaryModel:primary.model,fallbackModel:fallback.model,localFreeRequests:used(),assumedDailyLimit:daily,switchAfter:daily-reserve,scope:'本项目记录，非 OpenRouter 全账号实时剩余额度'};},
    async answer({userId,permit,quick=false,...options}){
      options.signal?.throwIfAborted();
      const selected=selectAndRecord(userId,quick);
      try{await attempt(selected,permit,options);return {provider:selected.route.name,model:selected.route.model};}
      catch(error){
        // 只有限额/余额错误触发一次备用；开始输出后绝不拼接另一模型的回答。
        if(!enabled||selected.route!==primary||![402,429].includes(error.status)||error.hasVisibleText||options.signal?.aborted||!fallback.key)throw error;
        const retryMs=error.status===402?300000:Math.max(60000,Math.min(error.retryAfterMs||0,3600000));
        db.prepare("INSERT INTO llm_route_state VALUES('openrouter',?) ON CONFLICT(provider) DO UPDATE SET cooldown_until=excluded.cooldown_until").run(clock()+retryMs);
        permit.release();
        const next=await reserveRequest.acquire(userId,options.signal,{waitMs:quick?0:65000});
        if(next.error)throw new Error(next.error);
        try{options.signal?.throwIfAborted();await attempt({route:fallback,id:record(userId,fallback,'primary-quota-error')},next,options);return {provider:fallback.name,model:fallback.model};}
        finally{next.release();}
      }
    }
  };
}
