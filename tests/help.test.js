import {createAccountFetch} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {snapshotHelpContext} from '../server/help.js';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('HELP 保留最近未定稿题目，裁剪字符预算，不读未来片段且快照不随修正变化',()=>{
 const rows=[
  {id:'old',start_ms:10000,end_ms:20000,text:'旧课题',final:1},
  {id:'before',start_ms:500000,end_ms:501000,text:'前文'.repeat(2000),final:1},
  {id:'latest',start_ms:590000,end_ms:600000,text:'为什么温度升高反应会加快？',final:0},
  {id:'future',start_ms:601000,end_ms:602000,text:'后续内容',final:1},
 ];
 const snapshot=snapshotHelpContext(rows,600000);
 assert.deepEqual(snapshot.segments.map(s=>s.id),['before','latest']);
 assert.equal(snapshot.segments.reduce((n,s)=>n+s.text.length,0),3000);
 assert.equal(snapshot.segments.at(-1).final,false);
 rows[2].text='后续修正';assert.equal(snapshot.segments.at(-1).text,'为什么温度升高反应会加快？');
 const long=snapshotHelpContext([{id:'long',start_ms:0,end_ms:1000,text:'字'.repeat(4000)+'最新题目',final:0}],1000);
 assert.equal(long.segments[0].text.length,3000);assert.ok(long.segments[0].text.endsWith('最新题目'));
});

test('HELP 一次请求流式短答、账号隔离、冻结追问、并行普通问答、停止和额度保护',{timeout:30000},async()=>{
 const calls=[];let holdHelp=false;
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: {"choices":[{"delta":{"content":"有效碰撞增多。"}}]}\n\n');
  if(!(holdHelp&&body.max_tokens===256)&&!JSON.stringify(body).includes('慢普通回答'))res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const scratch=path.resolve('output/test-tmp');mkdirSync(scratch,{recursive:true});const dir=mkdtempSync(path.join(scratch,'help-'));
  const fetch=createAccountFetch(dir);
 const accounts=[{email:'help-a@example.test'},{email:'help-b@example.test'}];
 const child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,JIWEN_MODE:'hosted',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,
  LLM_API_KEY:'help-test',LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}`,LLM_ROUTING:'qwen-only',JEV_ENABLED:'false',
  SECURE_COOKIE:'false',DAILY_QUESTIONS:'7',GLOBAL_DAILY_QUESTIONS:'30',GLOBAL_REQUESTS_PER_MINUTE:'50'},stdio:'ignore'});
 let cookieA,cookieB,db;
 const request=(route,body,cookie=cookieA,signal)=>fetch(`http://127.0.0.1:${port}/api${route}`,{method:body===undefined?'GET':'POST',
  headers:{Cookie:cookie||'','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
 const events=text=>text.split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
 const begin=async(response)=>{
  const reader=response.body.getReader();let text='';
  while(!text.includes('"delta"')){const {done,value}=await reader.read();assert.equal(done,false);text+=new TextDecoder().decode(value);}
  return {reader,text,cid:events(text).find(e=>e.type==='started').conversationId};
 };
 const drain=async reader=>{while(!(await reader.read()).done){}};
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await request('/me')).ok){ready=true;break;}}catch{}await delay(50);}assert.ok(ready);
  const register=async account=>{const r=await request('/auth/register',{email:account.email,password:'password123'});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
  cookieA=await register(accounts[0]);cookieB=await register(accounts[1]);
  const lesson=await(await request('/lessons',{title:'HELP 测试'})).json();const route=`/lessons/${lesson.id}/help`;
  assert.equal((await request(route,{anchorMs:600000},'')).status,401);
  assert.equal((await request(route,{anchorMs:600000},cookieB)).status,404);
  assert.equal((await request(route,{anchorMs:-1})).status,400);
  assert.equal((await request(route,{anchorMs:600000})).status,409);assert.equal(calls.length,0);
  db=new DatabaseSync(path.join(dir,'classroom.sqlite'));
  const insert=db.prepare('INSERT INTO segments VALUES(?,?,NULL,?,?,?,?)');
  insert.run('old',lesson.id,10000,15000,'早期课题与旧聊天',1);
  insert.run('background',lesson.id,560000,570000,'粒子需要达到活化能才能发生有效碰撞。',1);
  insert.run('partial',lesson.id,590000,600000,'为什么温度升高反应会加快？',0);
  insert.run('future',lesson.id,610000,615000,'未到锚点的后续课堂',1);
  const original=await(await request(`/lessons/${lesson.id}/conversations`,{anchorMs:15000,title:'旧聊天'})).json();
  await(await request(`/conversations/${original.id}/messages`,{content:'旧聊天中的私有推断'})).text();
  const response=await request(route,{anchorMs:600000});assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reply=events(await response.text()),cid=reply.find(e=>e.type==='started').conversationId;
  assert.ok(reply.some(e=>e.type==='delta'));assert.equal(reply.at(-1).type,'done');
  assert.equal(calls.length,2);assert.equal(calls[1].max_tokens,256);assert.equal(calls[1].enable_thinking,false);
  assert.ok(JSON.stringify(calls[1]).includes('为什么温度升高'));assert.ok(!JSON.stringify(calls[1]).includes('旧聊天'));assert.ok(!JSON.stringify(calls[1]).includes('未到锚点'));
  const saved=await(await request(`/conversations/${cid}`)).json();assert.equal(saved.messages.at(-1).status,'complete');
  assert.equal(saved.snapshot.segments.at(-1).final,false);
  db.prepare('UPDATE segments SET text=?,final=1 WHERE id=?').run('后续修正的新课题','partial');
  await(await request(`/conversations/${cid}/messages`,{content:'解释详细一点'})).text();
  assert.ok(JSON.stringify(calls.at(-1)).includes('为什么温度升高'));assert.ok(!JSON.stringify(calls.at(-1)).includes('后续修正'));assert.ok(!JSON.stringify(calls.at(-1)).includes('旧聊天'));
  const ordinary=await request(`/conversations/${original.id}/messages`,{content:'慢普通回答'});const ordinaryReader=ordinary.body.getReader();await ordinaryReader.read();
  holdHelp=true;const held=await begin(await request(route,{anchorMs:600000}));
  assert.equal((await request(route,{anchorMs:600000})).status,409);
  assert.equal((await request(`/conversations/${held.cid}/stop`,{},cookieB)).status,404);
  assert.equal((await request(`/conversations/${held.cid}/stop`,{})).status,200);await drain(held.reader);
  assert.equal((await(await request(`/conversations/${held.cid}`)).json()).messages.at(-1).status,'stopped');
  assert.equal((await request(`/conversations/${original.id}/fork`,{messageId:saved.messages[0].id,title:'仍在生成'})).status,409,'HELP 停止不影响普通回答');
  await request(`/conversations/${original.id}/stop`,{});await drain(ordinaryReader);
  const controller=new AbortController(),aborted=await begin(await request(route,{anchorMs:600000},cookieA,controller.signal));
  controller.abort();await aborted.reader.cancel().catch(()=>{});
  for(let i=0;i<30;i++){if((await(await request(`/conversations/${aborted.cid}`)).json()).messages.at(-1).status!=='streaming')break;await delay(20);}
  assert.equal((await(await request(`/conversations/${aborted.cid}`)).json()).messages.at(-1).status,'stopped');
  holdHelp=false;const final=await request(route,{anchorMs:600000,locale:'en'});assert.equal(final.status,200);
  const englishEvents=events(await final.text()),englishId=englishEvents.find(e=>e.type==='started').conversationId;
  assert.match(calls.at(-1).messages[0].content,/Answer in English\./);assert.doesNotMatch(calls.at(-1).messages[0].content,/使用中文/);
  const englishChat=await(await request(`/conversations/${englishId}`)).json();
  assert.equal(englishChat.title,'HELP · Latest class question');assert.equal(englishChat.messages[0].content,'Answer the teacher’s latest question directly.');
  assert.equal(englishChat.snapshot.segments.at(-1).text,'后续修正的新课题');
  const before=calls.length;assert.equal((await request(route,{anchorMs:600000})).status,429);assert.equal(calls.length,before);
  assert.equal((await(await request('/usage')).json()).llm.requests,7);
 }finally{
  db?.close();child.kill();await once(child,'exit').catch(()=>{});provider.closeAllConnections();await new Promise(r=>provider.close(r));
  if(dir.startsWith(scratch+path.sep))rmSync(dir,{recursive:true,force:true});
 }
});
