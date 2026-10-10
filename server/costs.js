import {randomUUID} from 'node:crypto';

// 2026-10-10 核对的标准 API 单价；估算不扣厂商赠送额度、优惠或本机资源开销。
export const pricingSources=[
  {label:'Qwen3.7-Flash',url:'https://help.aliyun.com/zh/model-studio/qwen3-7-flash'},
  {label:'Fun-ASR 实时转写',url:'https://help.aliyun.com/zh/model-studio/fun-asr-realtime'},
];
function host(url){try{return new URL(url).hostname;}catch{return '';}}
const tokens=value=>Number.isSafeInteger(value)&&value>=0;
export function questionRates({model,baseUrl}={}){
  if(host(baseUrl)!=='dashscope.aliyuncs.com'||!/^qwen3\.7-flash(?:-2026-07-15)?$/.test(model))return null;
  return [{maxInput:32000,input:0.2,output:0.8,cached:0.04},{maxInput:256000,input:0.6,output:2.4,cached:0.12},{maxInput:1000000,input:1.2,output:4.8,cached:0.24}];
}
export function audioPrice({local=false,model,baseUrl}={}){
  if(local)return 0;
  if(host(baseUrl)!=='dashscope.aliyuncs.com')return null;
  return /^fun-asr(?:-mtl)?-realtime(?:-\d{4}-\d{2}-\d{2})?$/.test(model)?0.00033:null;
}
export function questionPrice({name,model,baseUrl},usage){
  if(name==='openrouter'&&host(baseUrl)==='openrouter.ai'&&typeof model==='string'&&model.endsWith(':free'))return 0;
  const rates=questionRates({model,baseUrl});if(!rates)return null;
  if(!tokens(usage?.prompt_tokens)||!tokens(usage?.completion_tokens))return null;
  const input=usage.prompt_tokens,output=usage.completion_tokens;
  const cached=usage.prompt_tokens_details?.cached_tokens;
  const hit=tokens(cached)?Math.min(cached,input):0;
  const rate=rates.find(tier=>input<=tier.maxInput);if(!rate)return null;
  return ((input-hit)*rate.input+hit*rate.cached+output*rate.output)/1e6;
}

// 与账号及课堂记录分开保存匿名成本；删除账号、重启和关闭控制台都不会返还成本。
export function createCosts(db){
  db.exec(`CREATE TABLE IF NOT EXISTS cost_usage(id TEXT PRIMARY KEY,day TEXT NOT NULL,service TEXT NOT NULL,model TEXT NOT NULL,units REAL NOT NULL DEFAULT 0,cny REAL);
    CREATE INDEX IF NOT EXISTS cost_usage_day ON cost_usage(day,service);`);
  const insert=db.prepare('INSERT INTO cost_usage(id,day,service,model,units,cny) VALUES(?,?,?,?,?,?)');
  const get=db.prepare('SELECT * FROM cost_usage WHERE id=?');
  const update=db.prepare('UPDATE cost_usage SET units=?,cny=? WHERE id=?');
  const sum=db.prepare(`SELECT service,COUNT(*) events,COALESCE(SUM(cny),0) cny,COALESCE(SUM(units),0) units,
    SUM(CASE WHEN cny IS NULL THEN 1 ELSE 0 END) unpricedCalls,
    COALESCE(SUM(CASE WHEN cny IS NULL THEN units ELSE 0 END),0) unpricedUnits FROM cost_usage WHERE day=? GROUP BY service`);
  const day=timestamp=>new Date(timestamp).toISOString().slice(0,10);
  return {
    beginQuestion(route,timestamp=Date.now(),usage){
      const id=randomUUID(),cost=questionPrice(route,usage);
      const units=tokens(usage?.prompt_tokens)&&tokens(usage?.completion_tokens)?usage.prompt_tokens+usage.completion_tokens:0;
      insert.run(id,day(timestamp),'llm',route.model,units,cost);return id;
    },
    updateQuestion(id,route,usage){
      if(!tokens(usage?.prompt_tokens)||!tokens(usage?.completion_tokens))return;
      update.run(usage.prompt_tokens+usage.completion_tokens,questionPrice(route,usage),id);
    },
    recordAudio(sessionId,{seconds,day:date,local=false,model,baseUrl}){
      if(!Number.isFinite(seconds)||seconds<=0)return;
      const id=`asr:${sessionId}:${date}`,previous=get.get(id),units=(previous?.units||0)+seconds;
      const rate=audioPrice({local,model,baseUrl}),cost=rate===null?null:units*rate;
      if(previous)update.run(units,cost,id);else insert.run(id,date,'asr',local?'本机转写':model,units,cost);
    },
    snapshot(date,quotaSeconds,config={}){
      const groups=new Map(sum.all(date).map(row=>[row.service,row]));
      const llm=groups.get('llm')||{cny:0,events:0,unpricedCalls:0};
      const asr=groups.get('asr')||{cny:0,units:0,unpricedUnits:0};
      const historicalSeconds=Math.max(0,quotaSeconds-asr.units);
      const unpricedSeconds=asr.unpricedUnits+historicalSeconds;
      const complete=llm.unpricedCalls===0&&unpricedSeconds<0.001;
      const rate=audioPrice(config.asr||{});
      return {currency:'CNY',totalCny:llm.cny+asr.cny,complete,
        llm:{cny:llm.cny,unpricedCalls:llm.unpricedCalls,calls:llm.events},
        asr:{cny:asr.cny,unpricedSeconds,seconds:asr.units},
        pricing:{asrPerHour:rate===null?null:rate*3600,asrModel:config.asr?.local?'本机转写':config.asr?.model,
          llmModel:config.llm?.model,llmRates:questionRates(config.llm),sources:pricingSources,verifiedAt:'2026-10-10'}};
    },
  };
}
