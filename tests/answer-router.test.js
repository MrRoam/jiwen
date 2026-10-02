import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAnswerRouter,routingConfig,NEMOTRON_FREE} from '../server/answer-router.js';
import {requestBudget} from '../server/limits.js';
import {checkOpenRouter} from '../server/openrouter-status.js';
function setup({stream,perUser=20,daily=3,reserve=1,clock=Date.now,enabled=true,primaryKey='or-test'}={}){
 const db=new DatabaseSync(':memory:'),budget=requestBudget(db,{perUser,daily:40,perMinute:40});
 const config={db,reserveRequest:budget,enabled,primary:{name:'openrouter',key:primaryKey,baseUrl:'https://openrouter.ai/api/v1',model:NEMOTRON_FREE},fallback:{name:'qwen',key:'qwen-test',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-flash'},daily,reserve,clock,stream};
 let router=createAnswerRouter(config);
 return {db,budget,config,router,ask:async()=>{const permit=await budget.acquire('user');if(permit.error)throw Error(permit.error);try{return await router.answer({userId:'user',permit,messages:[{role:'user',content:'测试'}],onText:()=>{}});}finally{permit.release();}}};
}
test('主模型优先，进入预留区改用 Qwen；请求记录在重启后仍保留',async()=>{
 const calls=[];const f=setup({stream:async o=>{calls.push(o.model);o.onText('回答');o.onUsage({prompt_tokens:10,completion_tokens:3});}});
 try{await f.ask();await f.ask();await f.ask();assert.deepEqual(calls,[NEMOTRON_FREE,NEMOTRON_FREE,'qwen3.7-flash']);assert.equal(f.budget.usage('user').requests,3);assert.equal(f.budget.usage('user').promptTokens,30);const restarted=createAnswerRouter(f.config);assert.equal(restarted.status().localFreeRequests,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM llm_provider_requests WHERE prompt_tokens=10').get().n,3);}finally{f.db.close();}
});

test('HELP 直接使用现有备用配置，记录调用和 token，普通问答仍走原路由',async()=>{
 const calls=[];const f=setup({stream:async o=>{calls.push(o);o.onText('短答');o.onUsage({prompt_tokens:10,completion_tokens:3});}});
 try{
  const permit=await f.budget.acquire('user');
  try{await f.router.answer({userId:'user',permit,quick:true,maxTokens:256,messages:[],onText:()=>{}});}finally{permit.release();}
  assert.equal(calls[0].model,'qwen3.7-flash');assert.equal(calls[0].maxTokens,256);
  assert.equal(f.db.prepare('SELECT reason FROM llm_provider_requests').get().reason,'help-direct');
  assert.equal(f.budget.usage('user').requests,1);assert.equal(f.budget.usage('user').completionTokens,3);
  await f.ask();assert.equal(calls[1].model,NEMOTRON_FREE);
 }finally{f.db.close();}
});
test('上游限额错误仅回退一次，两个请求分别扣额度及统计，冷却期间直用 Qwen',async()=>{
 const calls=[];const f=setup({stream:async o=>{calls.push(o.model);if(o.model===NEMOTRON_FREE)throw Object.assign(Error('limit'),{status:429});o.onText('备用回答');o.onUsage({prompt_tokens:20,completion_tokens:5});}});
 try{await f.ask();assert.equal(f.budget.usage('user').requests,2);assert.equal(f.budget.usage('user').promptTokens,20);await f.ask();assert.deepEqual(calls,[NEMOTRON_FREE,'qwen3.7-flash','qwen3.7-flash']);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM llm_provider_requests WHERE status='failed'").get().n,1);}finally{f.db.close();}
});
test('已有输出、非额度错误不切换模型；备用仍遵守个人硬上限',async()=>{
 for(const partial of [true,false]){
  const calls=[];const f=setup({stream:async o=>{calls.push(o.model);if(partial)o.onText('部分回答');throw Object.assign(Error('provider failed'),{status:partial?429:401});}});
  try{await assert.rejects(f.ask(),/provider failed/);assert.equal(calls.length,1);}finally{f.db.close();}
 }
 const f=setup({perUser:1,stream:async()=>{throw Object.assign(Error('limit'),{status:429});}});
 try{await assert.rejects(f.ask(),/你的今日/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM llm_provider_requests').get().n,1);}finally{f.db.close();}
});
test('未配置 OpenRouter 密钥仍能使用现有 Qwen；UTC 次日恢复主模型',async()=>{
 let model;const f=setup({primaryKey:'',stream:async o=>{model=o.model;}});try{await f.ask();assert.equal(model,'qwen3.7-flash');assert.equal(f.router.status().primaryConfigured,false);}finally{f.db.close();}
 let time=Date.UTC(2026,8,15,12);const calls=[];const g=setup({daily:2,reserve:1,clock:()=>time,stream:async o=>calls.push(o.model)});
 try{await g.ask();await g.ask();time+=86400000;await g.ask();assert.deepEqual(calls,[NEMOTRON_FREE,'qwen3.7-flash',NEMOTRON_FREE]);}finally{g.db.close();}
});
test('并发路由选择不会突破 OpenRouter 本地预留阈值',async()=>{
 const calls=[];const f=setup({daily:2,reserve:1,stream:async o=>{calls.push(o.model);await new Promise(r=>setTimeout(r,10));}});
 try{await Promise.all([f.ask(),f.ask()]);assert.deepEqual(calls.sort(),[NEMOTRON_FREE,'qwen3.7-flash'].sort());}finally{f.db.close();}
});
test('充值检验区分购入金额、免费层标记和未知，且不输出敏感字段',async()=>{
 assert.equal((await checkOpenRouter('')).keyConfigured,false);
 const mock=(amount,status=200)=>async url=>({status:url.endsWith('/credits')?status:200,ok:!url.endsWith('/credits')||status===200,json:async()=>({data:url.endsWith('/credits')?{total_credits:amount,total_usage:2}:{is_free_tier:false,label:'secret-label',usage_daily:999}})});
 const paid=await checkOpenRouter('secret',{fetchImpl:mock(10)});assert.equal(paid.expandedQuotaVerified,true);assert.equal(paid.dailyFreeRequestsByPurchase,1000);assert.equal(paid.balance,8);assert.ok(!JSON.stringify(paid).includes('secret'));
 const unknown=await checkOpenRouter('secret',{fetchImpl:mock(null,403)});assert.equal(unknown.keyValid,true);assert.equal(unknown.expandedQuotaVerified,false);assert.equal(unknown.dailyFreeRequestsByPurchase,null);
 const small=await checkOpenRouter('secret',{fetchImpl:mock(5)});assert.equal(small.dailyFreeRequestsByPurchase,50);
});
test('配置只把独立 OpenRouter 密钥发往主模型，保持原 Qwen 密钥和模型',()=>{
 const config=routingConfig({LLM_ROUTING:'openrouter-first',OPENROUTER_API_KEY:'or',LLM_API_KEY:'qw',DASHSCOPE_API_KEY:'asr'});assert.equal(config.primary.key,'or');assert.equal(config.primary.model,NEMOTRON_FREE);assert.equal(config.fallback.key,'qw');assert.equal(config.daily-config.reserve,900);assert.throws(()=>routingConfig({OPENROUTER_FREE_DAILY_REQUESTS:'50',OPENROUTER_FREE_RESERVE_REQUESTS:'100'}),/配置不正确/);
});
