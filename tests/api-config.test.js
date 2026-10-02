import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WebSocketServer} from 'ws';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
test('页面 API 配置：无邀请注册、管理员权限、保存即生效、录音期间保护和重启持久化',{timeout:30000},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'jiwen-api-')),port=await freePort(),base=`http://127.0.0.1:${port}`,authorizations=[];
  const mock=createServer(async(req,res)=>{
    authorizations.push(req.headers.authorization);for await(const chunk of req){}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"连接成功"}}]}\n\ndata: [DONE]\n\n');
  });
  const ws=new WebSocketServer({server:mock});ws.on('connection',(socket,req)=>{authorizations.push(req.headers.authorization);socket.on('message',()=>socket.send(JSON.stringify({header:{event:'task-started'}})));});
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  let child,logs='';
  async function start(){
    child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',SECURE_COOKIE:'false',ADMIN_EMAIL:'',DASHSCOPE_API_KEY:'',LLM_API_KEY:'',OPENROUTER_API_KEY:'',ASR_PROVIDER:'remote',LLM_ROUTING:'qwen-only'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/me')).ok)return;}catch{}await delay(50);}assert.fail('启动失败 '+logs);
  }
  const request=(route,{method='GET',body,cookie}={})=>fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  async function register(email){const response=await request('/auth/register',{method:'POST',body:{email,password:'test-password123'}});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
  async function stop(){if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}}
  try{
    await start();assert.equal((await request('/services/config')).status,401);
    const admin=await register('owner@example.test'),other=await register('student@example.test');
    assert.equal((await(await request('/me',{cookie:admin})).json()).user.isAdmin,true);
    assert.equal((await(await request('/me',{cookie:other})).json()).user.isAdmin,false);
    assert.equal((await request('/services/config',{cookie:other})).status,403);
    assert.equal((await request('/services/config',{method:'PUT',cookie:other,body:{LLM_API_KEY:'forbidden'}})).status,403);
    const body={DASHSCOPE_API_KEY:'asr-config-fixture',ASR_WS_URL:`ws://127.0.0.1:${mock.address().port}`,LLM_API_KEY:'llm-config-fixture',LLM_BASE_URL:`http://127.0.0.1:${mock.address().port}/v1`,LLM_MODEL:'fixture-model'};
    const saved=await request('/services/config',{method:'PUT',body,cookie:admin});assert.equal(saved.status,200);const summary=await saved.json();assert.equal(summary.config.llmReady,true);assert.equal(summary.config.asrReady,true);
    assert.ok(!JSON.stringify(summary).includes('config-fixture'));
    for(const service of ['asr','llm']){
      const response=await request('/services/test',{method:'POST',cookie:admin,body:{service}});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
    }
    assert.ok(authorizations.includes('Bearer asr-config-fixture'));assert.ok(authorizations.includes('Bearer llm-config-fixture'));
    const lesson=await(await request('/lessons',{method:'POST',cookie:admin,body:{title:'配置测试'}})).json();
    const recording=await(await request(`/lessons/${lesson.id}/recordings`,{method:'POST',cookie:admin,body:{mime:'audio/webm'}})).json();
    assert.equal((await request('/services/config',{method:'PUT',cookie:admin,body:{LLM_MODEL:'next'}})).status,409);
    assert.equal((await request(`/recordings/${recording.id}/cancel`,{method:'POST',cookie:admin})).status,200);
    const before=readFileSync(path.join(dir,'service-config.json'),'utf8');
    assert.equal((await request('/services/config',{method:'PUT',cookie:admin,body:{LLM_BASE_URL:'https://user:password@example.test'}})).status,400);assert.equal(readFileSync(path.join(dir,'service-config.json'),'utf8'),before);
    await stop();await start();
    const persisted=await(await request('/services/config',{cookie:admin})).json();assert.equal(persisted.LLM_MODEL,'fixture-model');assert.equal(persisted.LLM_API_KEY_CONFIGURED,true);assert.ok(!JSON.stringify(persisted).includes('config-fixture'));
    assert.equal((await request('/services/config/llm',{method:'DELETE',cookie:other})).status,403);
    const cleared=await(await request('/services/config/llm',{method:'DELETE',cookie:admin})).json();assert.equal(cleared.config.llmReady,false);
    assert.ok(!logs.includes('asr-config-fixture'));assert.ok(!logs.includes('llm-config-fixture'));
  }finally{await stop();ws.clients.forEach(socket=>socket.terminate());await new Promise(resolve=>ws.close(resolve));mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
