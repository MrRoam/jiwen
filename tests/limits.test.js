import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {requestBudget} from '../server/limits.js';
import {answerRequest} from '../server/providers.js';

test('个人及全站额度独立计数，重建预算器不重置，UTC 次日恢复',()=>{
 const db=new DatabaseSync(':memory:');const options={perUser:2,daily:3,perMinute:10};let reserve=requestBudget(db,options);const t=Date.UTC(2026,8,8,12);
 assert.equal(reserve('a',t),null);assert.equal(reserve('a',t+1),null);assert.match(reserve('a',t+2),/你的今日/);
 reserve=requestBudget(db,options);assert.match(reserve('a',t+3),/你的今日/);assert.equal(reserve('b',t+4),null);assert.match(reserve('c',t+5),/全站/);assert.equal(reserve('a',t+86400000),null);db.close();
});
test('全站分钟限制不会额外扣除被拦截请求',()=>{
 const db=new DatabaseSync(':memory:'),reserve=requestBudget(db,{perUser:5,daily:40,perMinute:1});
 assert.equal(reserve('a',100000),null);assert.match(reserve('b',100001),/一分钟/);assert.equal(reserve('b',160000),null);assert.equal(db.prepare('SELECT COUNT(*) n FROM llm_requests').get().n,2);db.close();
});
test('免费保护拦截付费模型和 auto 路由，发出零价格限制且不配置付费回退',()=>{
 const before=process.env.LLM_FREE_ONLY;process.env.LLM_FREE_ONLY='true';
 try{const url='https://openrouter.ai/api/v1';for(const model of ['nvidia/nemotron-3-ultra-550b-a55b','openrouter/auto:free'])assert.throws(()=>answerRequest(url,model,[]),/仅允许免费/);
 for(const model of ['openrouter/free','vendor/model:free']){const request=answerRequest(url,model,[]);assert.deepEqual(request.provider,{max_price:{prompt:0,completion:0},allow_fallbacks:false});assert.equal(request.models,undefined);assert.equal(request.max_tokens,1600);}}
 finally{if(before===undefined)delete process.env.LLM_FREE_ONLY;else process.env.LLM_FREE_ONLY=before;}
});

test('并发槽释放、等待取消不扣费，token 用量按请求结算',async()=>{
 const db=new DatabaseSync(':memory:'),reserve=requestBudget(db,{perUser:5,daily:40,perMinute:2});
 try{
 const a=await reserve.acquire('a'),b=await reserve.acquire('a');assert.match((await reserve.acquire('a')).error,/两个/);
 a.onUsage({prompt_tokens:15,completion_tokens:6});a.onUsage({prompt_tokens:15,completion_tokens:6});
 assert.equal(reserve.usage('a').promptTokens,15);assert.equal(reserve.usage('a').requests,2);assert.equal(reserve.usage('a').measuredRequests,1);
 a.release();a.release();b.release();
 const controller=new AbortController(),waiting=reserve.acquire('b',controller.signal);controller.abort();await assert.rejects(waiting,{name:'AbortError'});assert.equal(reserve.usage('b').requests,0);
 db.prepare('UPDATE llm_requests SET created_ms=?').run(Date.now()-61000);const next=await reserve.acquire('b');assert.equal(next.error,undefined);next.release();
 }finally{db.close();}
});

test('短时限速自动排队，窗口空出后发出请求',async()=>{
 const db=new DatabaseSync(':memory:'),reserve=requestBudget(db,{perUser:5,daily:40,perMinute:1});
 try{reserve('a',Date.now()-59900);const result=await reserve.acquire('b');assert.equal(result.error,undefined);assert.equal(reserve.usage('b').requests,1);result.release();}finally{db.close();}
});

test('HELP 的零等待模式立即返回限速，不扣额度且释放并发槽',async()=>{
 const db=new DatabaseSync(':memory:'),reserve=requestBudget(db,{perUser:5,daily:40,perMinute:1});
 try{
  const first=await reserve.acquire('a');first.release();
  for(let i=0;i<3;i++)assert.match((await reserve.acquire('a',undefined,{waitMs:0})).error,/一分钟/);
  assert.equal(reserve.usage('a').requests,1);
  db.prepare('UPDATE llm_requests SET created_ms=?').run(Date.now()-61000);
  const next=await reserve.acquire('a',undefined,{waitMs:0});assert.equal(next.error,undefined);next.release();
 }finally{db.close();}
});
