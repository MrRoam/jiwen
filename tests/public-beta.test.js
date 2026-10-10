import {createAccountFetch} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {legalDocument} from '../server/legal.js';
import {createWorkQueue} from '../server/work-queue.js';

test('披露来自实际配置，密钥不影响版本，本地切换和地区变更会更新版本',()=>{
  const env={ASR_PROVIDER:'remote',ASR_WS_URL:'wss://dashscope.aliyuncs.com/api-ws/v1/inference',LLM_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',DASHSCOPE_API_KEY:'DO-NOT-DISCLOSE'};
  const remote=legalDocument(env);
  assert.doesNotMatch(JSON.stringify(remote),/18周岁|成年人|公测/);
  assert.equal(remote.operator,'姚佳旭');assert.equal(remote.contact,'joshyao0601@gmail.com');
  assert.equal(remote.providers.find(p=>p.service==='asr').name,'阿里云百炼');
  assert.ok(!JSON.stringify(remote).includes('DO-NOT-DISCLOSE'));
  assert.equal(remote.version,legalDocument({...env,DASHSCOPE_API_KEY:'another'}).version);
  const local=legalDocument({...env,ASR_PROVIDER:'local'});assert.notEqual(local.version,remote.version);
  assert.match(local.providers.find(p=>p.service==='asr').data,/并非用户/);
  assert.notEqual(remote.version,legalDocument({...env,LLM_BASE_URL:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'}).version);
});

test('全站转换按先进先出执行，失败释放槽',async()=>{
  const queue=createWorkQueue(1),order=[];let release;
  const a=queue(async()=>{order.push('a');await new Promise(r=>release=r);throw new Error('fixture');});
  const caught=a.catch(e=>e.message),b=queue(()=>order.push('b'));
  await new Promise(r=>setImmediate(r));assert.deepEqual(order,['a']);release();
  assert.equal(await caught,'fixture');await b;assert.deepEqual(order,['a','b']);
});

test('邮箱验证注册和录音无需额外确认、容量可见、缺段不误报完整、导出隔离、注销清除全套数据',{timeout:60000},async t=>{
  const parent=path.resolve('output/test-tmp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(path.join(parent,'beta-'));
  const fetch=createAccountFetch(dir);
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',SECURE_COOKIE:'false',ADMIN_EMAIL:'',DASHSCOPE_API_KEY:'',LLM_API_KEY:'',OPENROUTER_API_KEY:'',SMTP_USER:'',SMTP_PASS:'',JEV_ENABLED:'false',ASR_PROVIDER:'remote',LLM_ROUTING:'qwen-only'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  t.after(async()=>{child.kill();if(child.exitCode===null)await once(child,'exit');rmSync(dir,{recursive:true,force:true});rmSync(`${dir}.deletions.jsonl`,{force:true});});
  for(let i=0;i<150;i++){try{if((await fetch(base+'/api/me')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  async function request(route,{cookie,method='GET',body}={}){return fetch(base+'/api'+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
  async function register(email){const r=await request('/auth/register',{method:'POST',body:{email,password:'test-password'}});assert.equal(r.status,200,logs);return {cookie:r.headers.get('set-cookie').split(';')[0],user:await r.json()};}
  const owner=await register('owner@example.test'),a=await register('a@example.test'),b=await register('b@example.test');
  assert.equal((await request('/payment-interest')).status,401,'期待人数需要登录后读取');
  assert.equal((await request('/payment-interest',{method:'POST'})).status,401,'未登录不能表达期待');
  assert.deepEqual(await(await request('/payment-interest',{cookie:a.cookie})).json(),{count:0,interested:false});
  assert.deepEqual(await(await request('/payment-interest',{cookie:a.cookie,method:'POST',body:{userId:b.user.id}})).json(),{count:1,interested:true},'服务端只记录当前账号');
  const repeated=await Promise.all(Array.from({length:5},()=>request('/payment-interest',{cookie:a.cookie,method:'POST'}).then(r=>r.json())));
  assert.ok(repeated.every(value=>value.count===1&&value.interested),'重复点击与请求重试不重复计数');
  assert.deepEqual(await(await request('/payment-interest',{cookie:b.cookie})).json(),{count:1,interested:false},'个人状态按账号隔离');
  assert.deepEqual(await(await request('/payment-interest',{cookie:b.cookie,method:'POST'})).json(),{count:2,interested:true});
  assert.equal((await(await request('/me',{cookie:a.cookie})).json()).user.legalVersion,null,'无需政策确认即可注册');
  const consentDb=new DatabaseSync(path.join(dir,'classroom.sqlite'));
  assert.equal(consentDb.prepare('SELECT COUNT(*) n FROM legal_consents WHERE user_id=?').get(a.user.id).n,0,'不自动写入同意记录');
  consentDb.prepare('INSERT INTO legal_consents VALUES(?,?,?,?)').run(a.user.id,'previous-policy-version',new Date().toISOString(),1);
  consentDb.prepare("UPDATE legal_consents SET version='previous-policy-version' WHERE user_id=?").run(a.user.id);
  consentDb.close();
  assert.equal((await request('/lessons',{method:'POST',body:{title:'未登录'}})).status,401);
  const lessonResponse=await request('/lessons',{cookie:a.cookie,method:'POST',body:{title:'课堂'}});
  assert.equal(lessonResponse.status,200,'创建课堂无需录音许可确认字段');
  const lid=(await lessonResponse.json()).id;
  assert.equal((await request(`/lessons/${lid}/recordings`,{cookie:b.cookie,method:'POST',body:{mime:'audio/webm'}})).status,404,'账号隔离仍由服务端检查');
  assert.equal((await request(`/lessons/${lid}/recordings`,{cookie:a.cookie,method:'POST',body:{mime:'invalid'}})).status,400,'格式校验仍有效');
  const recordingResponse=await request(`/lessons/${lid}/recordings`,{cookie:a.cookie,method:'POST',body:{mime:'audio/webm'}});
  assert.equal(recordingResponse.status,200,'旧政策版本可以直接录音，无需许可确认字段');
  const rec=await recordingResponse.json();assert.ok(rec.id);assert.ok(rec.maxSeconds<=7200);
  assert.equal((await(await request('/me',{cookie:a.cookie})).json()).user.legalVersion,null,'开始录音不会伪造新版政策同意');
  const competing=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,env:{...process.env,DATA_DIR:dir,PORT:'0',HOST:'127.0.0.1'},stdio:'ignore'});
  assert.notEqual((await once(competing,'exit'))[0],0,'第二实例必须在打开数据库前拒绝');
  assert.equal(JSON.parse(readFileSync(path.join(dir,'runtime.json'),'utf8')).pid,child.pid,'第二实例不能删除第一个运行标记');
  assert.equal((await(await request(`/recordings/${rec.id}`,{cookie:a.cookie})).json()).status,'recording');
  const usage=await(await request('/usage',{cookie:a.cookie})).json();assert.equal(usage.storage.limitBytes,500*1024**2);assert.ok(usage.storage.reservedBytes>0);
  assert.equal((await request('/account',{cookie:a.cookie,method:'DELETE',body:{password:'test-password',confirmation:'删除账号'}})).status,409,'活动录音阻止注销');
  const input=path.join(dir,'fixture.webm'),generator=spawn(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libopus',input],{windowsHide:true,stdio:'ignore'});assert.equal((await once(generator,'exit'))[0],0);
  const audio=readFileSync(input),half=Math.floor(audio.length/2);
  async function upload(seq,part){return fetch(`${base}/api/recordings/${rec.id}/chunks/${seq}`,{method:'PUT',headers:{Cookie:a.cookie,'Content-Type':'application/octet-stream','X-Duration-Ms':'1000'},body:part});}
  assert.equal((await upload(0,audio.subarray(0,half))).status,200);
  assert.equal((await request(`/recordings/${rec.id}/interrupt`,{cookie:a.cookie,method:'POST',body:{chunks:2}})).status,200);
  assert.equal((await request(`/recordings/${rec.id}/finish`,{cookie:a.cookie,method:'POST',body:{chunks:1}})).status,409,'已声明的尾段缺失不能保存前缀');
  assert.equal((await upload(1,audio.subarray(half))).status,200);
  assert.equal((await request(`/recordings/${rec.id}/finish`,{cookie:a.cookie,method:'POST',body:{chunks:2}})).status,200);
  const db=new DatabaseSync(path.join(dir,'classroom.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recording_consents WHERE lesson_id=?').get(lid).n,0,'不补造课堂录音许可记录');
  assert.equal(db.prepare('SELECT version FROM legal_consents WHERE user_id=?').get(a.user.id).version,'previous-policy-version');
  db.prepare('INSERT INTO segments VALUES(?,?,?,?,?,?,?)').run('s',lid,rec.id,0,1000,'课堂讲解',1);
  db.prepare('INSERT INTO asr_usage VALUES(?,?,?,?)').run('usage',a.user.id,1,new Date().toISOString());
  db.prepare('INSERT INTO llm_requests(user_id,created_ms) VALUES(?,?)').run(a.user.id,Date.now());
  db.prepare("INSERT INTO llm_provider_requests(user_id,provider,model,reason,created_ms) VALUES(?,'qwen','test','test',?)").run(a.user.id,Date.now());
  db.prepare('INSERT INTO password_resets VALUES(?,?,?,?,?,?)').run(a.user.email,'hash',Date.now()+600000,0,1,Date.now());
  // 已有账号缺少当前版政策记录，仍可问答；访问其他账号课堂仍被拒绝。
  db.prepare("UPDATE legal_consents SET version='previous-policy-version' WHERE user_id=?").run(a.user.id);
  assert.equal((await(await request('/me',{cookie:a.cookie})).json()).user.legalVersion,null);
  assert.equal((await request(`/lessons/${lid}/conversations`,{cookie:b.cookie,method:'POST',body:{anchorMs:1000,title:'越权'}})).status,404);
  const conversationResponse=await request(`/lessons/${lid}/conversations`,{cookie:a.cookie,method:'POST',body:{anchorMs:1000,title:'问题'}});
  assert.equal(conversationResponse.status,200);
  const conv=await conversationResponse.json();
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('msg',conv.id,'user','问题','complete',new Date().toISOString());
  const exported=await(await request('/account/export',{cookie:a.cookie})).json();assert.equal(exported.lessons.length,1);assert.equal(exported.lessons[0].conversations[0].snapshot.segments[0].text,'课堂讲解');assert.ok(exported.recordings[0].audioUrl);assert.ok(!JSON.stringify(exported).includes('password'));
  assert.ok(exported.paymentInterest.created_at,'期待记录包含在个人数据副本');
  assert.equal((await(await request('/account/export',{cookie:b.cookie})).json()).lessons.length,0);
  assert.equal((await request(exported.recordings[0].audioUrl.slice(4),{cookie:b.cookie})).status,404);
  assert.equal((await request('/account',{cookie:owner.cookie,method:'DELETE',body:{password:'test-password',confirmation:'删除账号'}})).status,409);
  assert.equal((await request('/account',{cookie:a.cookie,method:'DELETE',body:{password:'wrong-password',confirmation:'删除账号'}})).status,400);
  assert.equal((await request('/account',{cookie:a.cookie,method:'DELETE',body:{password:'test-password',confirmation:'删除账号'}})).status,200);
  for(const table of ['users','sessions','lessons','asr_usage','llm_requests','llm_provider_requests','legal_consents','payment_interest']){const key=table==='users'?'id':'user_id';assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${key}=?`).get(a.user.id).n,0,table);}
  assert.deepEqual(await(await request('/payment-interest',{cookie:b.cookie})).json(),{count:1,interested:true},'注销后清除期待记录并更新人数');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM password_resets WHERE email=?').get(a.user.email).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE id=?').get('msg').n,0);db.close();
  assert.equal(existsSync(path.join(dir,rec.id)),false);assert.match(readFileSync(`${dir}.deletions.jsonl`,'utf8'),/"type":"account"/);assert.equal((await request('/account/export',{cookie:a.cookie})).status,401);
});
