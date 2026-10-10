import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCosts,questionPrice,audioPrice} from '../server/costs.js';
import {createAnswerRouter,NEMOTRON_FREE} from '../server/answer-router.js';
import {requestBudget} from '../server/limits.js';
import {audioBudget} from '../server/audio-budget.js';

const qwen={name:'qwen',model:'qwen3.7-flash',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',key:'fixture'};
const free={name:'openrouter',model:NEMOTRON_FREE,baseUrl:'https://openrouter.ai/api/v1',key:'fixture'};
const audio={model:'fun-asr-realtime',baseUrl:'wss://dashscope.aliyuncs.com/api-ws/v1/inference'};
const time=Date.parse('2026-10-10T03:00:00Z'),day='2026-10-10';
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return {db,costs:createCosts(db)};}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} ≠ ${expected}`);

test('Qwen 按输入档位分别计输入、输出和缓存费用',()=>{
  for(const [input,inputPrice,outputPrice] of [[32000,.2,.8],[32001,.6,2.4],[256000,.6,2.4],[256001,1.2,4.8],[1000000,1.2,4.8]]){
    near(questionPrice(qwen,{prompt_tokens:input,completion_tokens:1000}),(input*inputPrice+1000*outputPrice)/1e6);
  }
  near(questionPrice(qwen,{prompt_tokens:10000,completion_tokens:1000,prompt_tokens_details:{cached_tokens:5000}}),.002);
  near(questionPrice(qwen,{prompt_tokens:10000,completion_tokens:0,prompt_tokens_details:{cached_tokens:20000}}),.0004);
  assert.equal(questionPrice(qwen,{prompt_tokens:1000001,completion_tokens:1}),null);
});

test('仅确认的免费路由计零，未知来源、模型或无效用量均未计价',()=>{
  assert.equal(questionPrice(free),0);
  assert.equal(questionPrice({...free,model:undefined}),null);
  assert.equal(questionPrice({...free,baseUrl:'https://proxy.example/api/v1'}),null);
  assert.equal(questionPrice({...qwen,model:'unknown'},{prompt_tokens:10,completion_tokens:1}),null);
  assert.equal(questionPrice({...qwen,baseUrl:'https://dashscope-intl.aliyuncs.com/api/v1'},{prompt_tokens:10,completion_tokens:1}),null);
  for(const usage of [undefined,{}, {prompt_tokens:-1,completion_tokens:1},{prompt_tokens:1,completion_tokens:NaN}])assert.equal(questionPrice(qwen,usage),null);
  assert.equal(audioPrice({...audio,local:true}),0);
  assert.equal(audioPrice({...audio,baseUrl:'wss://proxy.example/ws'}),null);
  assert.equal(audioPrice({...audio,model:'unknown'}),null);
  near(audioPrice(audio)*3600,1.188);
});

test('每日成本区分云端、本机和旧音频，不把混合额度当云端费用',t=>{
  const {costs}=fixture(t);
  costs.recordAudio('cloud',{day,seconds:3600,...audio});
  costs.recordAudio('local',{day,seconds:1800,local:true});
  const id=costs.beginQuestion(qwen,time);
  let value=costs.snapshot(day,5400,{asr:audio,llm:qwen});
  near(value.totalCny,1.188);assert.equal(value.llm.unpricedCalls,1);assert.equal(value.asr.unpricedSeconds,0);assert.equal(value.complete,false);
  const usage={prompt_tokens:10000,completion_tokens:1000};
  costs.updateQuestion(id,qwen,usage);costs.updateQuestion(id,qwen,usage);
  value=costs.snapshot(day,5400);near(value.totalCny,1.1908);assert.equal(value.llm.calls,1);assert.equal(value.complete,true);
  costs.recordAudio('unknown',{day,seconds:60,model:'other',baseUrl:'wss://example.test'});
  value=costs.snapshot(day,6000);assert.equal(value.asr.unpricedSeconds,600);assert.equal(value.complete,false);near(value.asr.cny,1.188);
  const next=costs.snapshot('2026-10-11',0);assert.equal(next.totalCny,0);assert.equal(next.complete,true);
});

test('音频成本与额度共同回滚，累计供应商回报不重复计费且跨日分开',t=>{
  const {db,costs}=fixture(t);db.exec('CREATE TABLE asr_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,seconds REAL NOT NULL,created_at TEXT NOT NULL)');
  const budget=audioBudget(db,{perUser:100,globalDaily:100});let fail=true;
  const session=budget.open('user','session',(seconds,{day})=>{costs.recordAudio('session',{seconds,day,...audio});if(fail)throw Error('fixture-failure');});
  assert.throws(()=>session.send(Buffer.alloc(32000),()=>true,time),/fixture-failure/);
  assert.equal(costs.snapshot(day,0).totalCny,0);assert.equal(budget.usage('user',time).usedSeconds,0);
  fail=false;session.send(Buffer.alloc(32000),()=>true,time);session.onUsage(2,time);session.onUsage(2,time);
  near(costs.snapshot(day,2).asr.cny,.00066);
  session.send(Buffer.alloc(32000),()=>true,time+86400000);
  near(costs.snapshot('2026-10-11',1).asr.cny,.00033);
});

test('备用调用计自身费用；重复用量、重建路由和删除调用记录不会重计或返还',async t=>{
  const {db,costs}=fixture(t),budget=requestBudget(db,{perUser:10,daily:20,perMinute:20});
  const config={db,costs,reserveRequest:budget,enabled:true,primary:free,fallback:qwen,clock:()=>time,stream:async options=>{
    if(options.model===NEMOTRON_FREE)throw Object.assign(Error('limit'),{status:429});
    options.onText('fixture');options.onUsage({prompt_tokens:10000,completion_tokens:1000});options.onUsage({prompt_tokens:10000,completion_tokens:1000});
  }};
  const router=createAnswerRouter(config),permit=await budget.acquire('user');
  try{await router.answer({userId:'user',permit,messages:[],onText:()=>{}});}finally{permit.release();}
  let value=costs.snapshot(day,0);near(value.totalCny,.0028);assert.equal(value.llm.calls,2);assert.equal(value.llm.unpricedCalls,0);
  createAnswerRouter(config);assert.equal(costs.snapshot(day,0).llm.calls,2);
  db.exec('DELETE FROM llm_provider_requests');createAnswerRouter(config);
  near(createCosts(db).snapshot(day,0).totalCny,.0028);
});

test('旧调用迁移只执行一次，未知付费来源不套用当前单价',t=>{
  const {db,costs}=fixture(t),budget=requestBudget(db,{perUser:10,daily:20,perMinute:20});
  const config={db,reserveRequest:budget,enabled:true,primary:free,fallback:qwen,clock:()=>time};
  createAnswerRouter(config);
  const put=db.prepare("INSERT INTO llm_provider_requests(user_id,provider,model,reason,created_ms,prompt_tokens,completion_tokens) VALUES('fixture',?,?, 'old',?,10,3)");
  put.run('qwen',qwen.model,time);put.run('openrouter',free.model,time);
  createAnswerRouter({...config,costs});createAnswerRouter({...config,costs});
  const value=costs.snapshot(day,0);assert.equal(value.llm.calls,2);assert.equal(value.llm.unpricedCalls,1);assert.equal(value.totalCny,0);assert.equal(value.complete,false);
});
