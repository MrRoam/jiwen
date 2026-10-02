import {seedLegacyUser} from './account-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket,{WebSocketServer} from 'ws';
import ffmpeg from 'ffmpeg-static';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('完整流程：账号隔离、实时转写、独立追问、音频补传与回放、删除权限', {timeout:60000},async()=>{
  const scratch=path.resolve(root,'output/test-tmp');mkdirSync(scratch,{recursive:true});const directory=mkdtempSync(path.join(scratch,'integration-'));
  await seedLegacyUser(directory);
  const llmCalls=[];let turn=0;
  const provider=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;llmCalls.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"测试解释：仅使用当前对话片段。"}}]}\n\ndata: [DONE]\n\n');});
  const providerWS=new WebSocketServer({server:provider});providerWS.on('connection',ws=>{const text=++turn===1?'戴维南定理解释':'诺顿定理解释';const sentence=(begin_time,end_time,value,sentence_end)=>ws.send(JSON.stringify({header:{event:'result-generated'},payload:{output:{sentence:{begin_time,end_time,text:value,sentence_end}},usage:sentence_end?{duration:1}:null}}));ws.on('message',(data,isBinary)=>{if(isBinary)return;const message=JSON.parse(data);if(message.header.action==='run-task')ws.send(JSON.stringify({header:{event:'task-started'}}));if(message.header.action==='finish-task'){if(turn===1){sentence(0,300,'戴维南',false);sentence(100,600,'戴维南定理',false);}sentence(turn===1?80:0,1000,text,true);ws.send(JSON.stringify({header:{event:'task-finished'}}));}});});
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));const pp=provider.address().port,appPort=await port(),base=`http://127.0.0.1:${appPort}`;
  const child=spawn(process.execPath,['server/index.js','--production'],{cwd:root,windowsHide:true,env:{...process.env,DATA_DIR:directory,PORT:String(appPort),HOST:'127.0.0.1',DASHSCOPE_API_KEY:'test-key-not-real',ASR_WS_URL:`ws://127.0.0.1:${pp}`,LLM_API_KEY:'test-key-not-real',LLM_BASE_URL:`http://127.0.0.1:${pp}`,MAX_USERS:'2',DAILY_QUESTIONS:'5',GLOBAL_DAILY_QUESTIONS:'40',GLOBAL_REQUESTS_PER_MINUTE:'10',SECURE_COOKIE:'false'},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  async function request(route,{cookie,method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return response;}
  try{
    let connected=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/me')).ok){connected=true;break;}}catch{}await delay(50);}assert.ok(connected,logs);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{username:'原用户名',password:'legacy-password'}})).status,400);
    const register=async email=>{const r=await request('/api/auth/register',{method:'POST',body:{email,password:'test-password-123'}});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
    assert.equal((await request('/api/auth/register',{method:'POST',body:{email:'invalid',password:'test-password-123'}})).status,400);
    const a=await register('a@example.test'),b=await register('b@example.test');
    assert.equal((await request('/api/auth/register',{method:'POST',body:{email:'c@example.test',password:'test-password-123'}})).status,403);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'A@EXAMPLE.TEST',password:'test-password-123'}})).status,200);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'原用户名',password:'legacy-password'}})).status,400);
    const me=await(await request('/api/me',{cookie:a})).json();assert.equal(me.user.email,'a@example.test');assert.equal(Object.hasOwn(me.user,'username'),false);
    const lesson=await(await request('/api/lessons',{cookie:a,method:'POST',body:{title:'集成测试'}})).json();
    assert.equal((await (await request('/api/lessons',{cookie:a})).json()).length,0,'未开始录音的课堂不进入列表');
    assert.equal((await request(`/api/lessons/${lesson.id}`,{cookie:b})).status,404);
    assert.equal((await request('/api/lessons',{method:'POST',cookie:a,headers:{Origin:'https://foreign.example'},body:{title:'跨站'}})).status,403);
    const rec=await(await request(`/api/lessons/${lesson.id}/recordings`,{method:'POST',cookie:a,body:{mime:'audio/webm;codecs=opus'}})).json();assert.ok(rec.id);
    const transcribe=async offset=>{await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${appPort}/api/asr?recordingId=${rec.id}`,{headers:{Cookie:a,Origin:base}});ws.on('error',reject);ws.on('message',raw=>{const event=JSON.parse(raw);if(event.type==='ready'){ws.send(JSON.stringify({type:'offset',offsetMs:0}));ws.send(JSON.stringify({type:'packet',offsetMs:offset}));ws.send(Buffer.alloc(32000));ws.send(JSON.stringify({type:'finish'}));}if(event.type==='error')reject(new Error(event.error));});ws.on('close',resolve);});await delay(30);};
    const waiting=await(await request(`/api/lessons/${lesson.id}/conversations`,{method:'POST',cookie:a,body:{title:'等待转写',anchorMs:1000}})).json();
    assert.equal(waiting.snapshot.segments.length,0);
    await transcribe(0);
    const firstSegments=(await(await request(`/api/lessons/${lesson.id}`,{cookie:a})).json()).segments;
    assert.equal(firstSegments.length,1,'同一句的中间结果应由最终结果覆盖');
    assert.equal(firstSegments[0].text,'戴维南定理解释');
    assert.equal(firstSegments[0].final,1);
    const hydrated=await(await request(`/api/conversations/${waiting.id}`,{cookie:a})).json();
    assert.equal(hydrated.snapshot.segments[0].text,'戴维南定理解释');
    const c1=await(await request(`/api/lessons/${lesson.id}/conversations`,{method:'POST',cookie:a,body:{title:'第一个问题',anchorMs:1000}})).json();assert.equal(c1.snapshot.segments[0].text,'戴维南定理解释');
    assert.equal((await request(`/api/recordings/${rec.id}/interrupt`,{method:'POST',cookie:a})).status,200);
    await transcribe(600000);
    const c2=await(await request(`/api/lessons/${lesson.id}/conversations`,{method:'POST',cookie:a,body:{title:'第二个问题',anchorMs:601000}})).json();assert.equal(c2.snapshot.segments[0].text,'诺顿定理解释');
    for(const [cid,content]of [[c1.id,'第一个问题'],[c2.id,'第二个问题'],[c1.id,'继续追问']]){const r=await request(`/api/conversations/${cid}/messages`,{method:'POST',cookie:a,body:{content}});assert.equal(r.status,200);assert.ok((await r.text()).includes('done'));}
    const usage=await(await request('/api/usage',{cookie:a})).json();assert.equal(usage.llm.requests,3);
    assert.equal(llmCalls.length,3);assert.ok(JSON.stringify(llmCalls[2]).includes('戴维南'));assert.ok(!JSON.stringify(llmCalls[2]).includes('诺顿'));assert.ok(!JSON.stringify(llmCalls[2]).includes('第二个问题'));
    assert.equal((await request(`/api/conversations/${c1.id}`,{cookie:b})).status,404);
    const snapshot=await(await request(`/api/conversations/${c1.id}`,{cookie:a})).json();assert.equal(snapshot.messages.length,4);assert.deepEqual(snapshot.snapshot,c1.snapshot);
    const input=path.join(directory,'test.webm');const generator=spawn(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libopus',input],{windowsHide:true,stdio:'ignore'});const [code]=await once(generator,'exit');assert.equal(code,0);const file=readFileSync(input),half=Math.floor(file.length/2);
    async function upload(seq,buffer){return fetch(`${base}/api/recordings/${rec.id}/chunks/${seq}`,{method:'PUT',headers:{Cookie:a,'Content-Type':'application/octet-stream','X-Duration-Ms':'1000'},body:buffer});}
    assert.equal((await upload(1,file.subarray(half))).status,409);assert.equal((await upload(0,file.subarray(0,half))).status,200);assert.equal((await upload(0,file.subarray(0,half))).status,200);assert.equal((await upload(0,Buffer.from('bad'))).status,409);assert.equal((await upload(1,file.subarray(half))).status,200);
    const finished=await request(`/api/recordings/${rec.id}/finish`,{method:'POST',cookie:a,body:{chunks:2}});assert.equal(finished.status,200,await finished.text());
    const audio=await request(`/api/recordings/${rec.id}/audio`,{cookie:a,headers:{Range:'bytes=0-99'}});assert.equal(audio.status,206);assert.equal((await audio.arrayBuffer()).byteLength,100);
    const compatible=await request(`/api/recordings/${rec.id}/audio?format=mp3`,{cookie:a,headers:{Range:'bytes=0-99'}});assert.equal(compatible.status,206);assert.match(compatible.headers.get('content-type'),/audio\/mpeg/);assert.equal((await compatible.arrayBuffer()).byteLength,100);
    assert.equal((await request(`/api/recordings/${rec.id}/audio`,{cookie:b})).status,404);
    assert.equal((await request('/api/services/test',{method:'POST',body:{service:'asr'}})).status,401);
    assert.equal((await request('/api/services/test',{method:'POST',cookie:a,body:{service:'invalid'}})).status,400);
    for(const service of ['asr','llm']){const result=await(await request('/api/services/test',{method:'POST',cookie:a,body:{service}})).json();assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes('test-key-not-real'));}
    const quotes=[{id:c1.snapshot.segments[0].id,text:'戴维南'},{id:c2.snapshot.segments[0].id,text:'诺顿'}];
    const multiple=await request(`/api/lessons/${lesson.id}/conversations`,{method:'POST',cookie:a,body:{anchorMs:0,quotes}});assert.equal(multiple.status,200);assert.equal((await multiple.json()).snapshot.quotes.length,2);
    assert.equal((await request(`/api/lessons/${lesson.id}/conversations`,{method:'POST',cookie:a,body:{anchorMs:0,quotes:[{id:'foreign',text:'伪造'}]}})).status,400);
    assert.equal((await request('/api/services/test',{method:'POST',cookie:a,body:{service:'llm'}})).status,200);
    const callsBeforeLimit=llmCalls.length;
    assert.equal((await request('/api/services/test',{method:'POST',cookie:a,body:{service:'llm'}})).status,429);
    assert.equal((await request(`/api/conversations/${c1.id}/messages`,{method:'POST',cookie:a,body:{content:'超额问题'}})).status,429);
    assert.equal(llmCalls.length,callsBeforeLimit,'连接测试与提问共用额度，被拦截请求不触发模型');
    assert.equal((await request(`/api/lessons/${lesson.id}`,{method:'DELETE',cookie:b})).status,404);assert.equal((await request(`/api/lessons/${lesson.id}`,{method:'DELETE',cookie:a})).status,200);assert.equal((await request(`/api/conversations/${c1.id}`,{cookie:a})).status,404);
    await request('/api/logout',{method:'POST',cookie:a});assert.equal((await request('/api/lessons',{cookie:a})).status,401);
  }finally{child.kill();await once(child,'exit').catch(()=>{});providerWS.clients.forEach(ws=>ws.terminate());await new Promise(r=>providerWS.close(r));await new Promise(r=>provider.close(r));if(directory.startsWith(scratch+path.sep))rmSync(directory,{recursive:true,force:true});}
});
