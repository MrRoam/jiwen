import {createAccountFetch} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('修改问题保留原对话和前文，停止保存部分回答且可继续提问',{timeout:20000},async()=>{
  const calls=[];const provider=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"已收到的内容"}}]}\n\n');if(!JSON.stringify(body).includes('慢回答'))res.end('data: [DONE]\n\n');});
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const scratch=path.resolve('output/test-tmp');mkdirSync(scratch,{recursive:true});const dir=mkdtempSync(path.join(scratch,'chat-'));
  const fetch=createAccountFetch(dir);

  const child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,JIWEN_MODE:'hosted',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,LLM_API_KEY:'test',LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}`,SECURE_COOKIE:'false',DAILY_QUESTIONS:'20',GLOBAL_REQUESTS_PER_MINUTE:'50'},stdio:'ignore'});
  let cookie='';const request=(url,body)=>fetch(`http://127.0.0.1:${port}/api${url}`,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  try{
    for(let i=0;i<100;i++){try{if((await request('/me')).ok)break;}catch{}await delay(50);}
    const auth=await request('/auth/register',{email:'chat@example.test',password:'password123'});cookie=auth.headers.get('set-cookie').split(';')[0];
    const lesson=await(await request('/lessons',{title:'测试课堂'})).json();const c=await(await request(`/lessons/${lesson.id}/conversations`,{title:'首问',anchorMs:0})).json();
    for(const content of ['首问','旧追问'])await(await request(`/conversations/${c.id}/messages`,{content})).text();
    const original=await(await request(`/conversations/${c.id}`)).json();
    assert.equal((await request(`/conversations/${c.id}/fork`,{messageId:original.messages[1].id,title:'非法'})).status,400);
    const branch=await(await request(`/conversations/${c.id}/fork`,{messageId:original.messages[2].id,title:'新追问'})).json();
    const fork=await(await request(`/conversations/${branch.id}`)).json();assert.equal(fork.messages.length,2);assert.equal(fork.snapshot.anchorMs,original.snapshot.anchorMs);assert.deepEqual(fork.snapshot.segments,original.snapshot.segments);
    await(await request(`/conversations/${branch.id}/messages`,{content:'新追问',locale:'en'})).text();assert.ok(!JSON.stringify(calls.at(-1)).includes('旧追问'));assert.ok(JSON.stringify(calls.at(-1)).includes('首问'));
    assert.match(calls.at(-1).messages[0].content,/Answer in English\./);assert.doesNotMatch(calls.at(-1).messages[0].content,/使用中文回答/);
    assert.deepEqual((await(await request(`/conversations/${c.id}`)).json()).messages,original.messages);
    const stream=await request(`/conversations/${branch.id}/messages`,{content:'慢回答'});const reader=stream.body.getReader();let text='';while(!text.includes('delta'))text+=new TextDecoder().decode((await reader.read()).value);
    assert.equal((await request(`/conversations/${branch.id}/stop`,{})).status,200);while(!(await reader.read()).done){}
    const stopped=await(await request(`/conversations/${branch.id}`)).json();assert.equal(stopped.messages.at(-1).status,'stopped');assert.equal(stopped.messages.at(-1).content,'已收到的内容');
    assert.match(calls.at(-1).messages[0].content,/使用中文回答/,'后续未指定语言的请求仍使用中文');
    assert.equal((await request(`/conversations/${branch.id}/fork`,{messageId:stopped.messages.at(-2).id,title:'重问'})).status,200);
  }finally{child.kill();await once(child,'exit');provider.closeAllConnections();await new Promise(r=>provider.close(r));if(dir.startsWith(scratch+path.sep))rmSync(dir,{recursive:true,force:true});}
});
