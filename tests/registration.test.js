import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initAccounts,registerAccount} from '../server/accounts.js';
import {issueRegistrationCode,checkRegistrationCode,cancelRegistrationCode} from '../server/registration-codes.js';
import {issueResetCode,initPasswordResets} from '../server/password-reset.js';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {fakeSmtp,decodeBody} from './smtp-fixture.js';

function database(){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created_at TEXT NOT NULL)');
  initAccounts(db,{quotaMode:'trial'});return db;
}
const email='register@example.test',password='test-password123';

test('未验证不创建账号或发放额度；验证后规范化邮箱、一次性发放额度并消耗验证码',()=>{
  const db=database();
  try{
    assert.equal(registerAccount(db,{email,password},{quotaMode:'trial'}).status,400);
    const issued=issueRegistrationCode(db,email);
    const wrong=issued.code==='000000'?'000001':'000000';
    assert.equal(registerAccount(db,{email,password,code:wrong},{quotaMode:'trial'}).status,403);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_audio_allowance').get().n,0);
    const result=registerAccount(db,{email:' REGISTER@EXAMPLE.TEST ',password,code:issued.code},{quotaMode:'trial'});
    assert.equal(result.user.email,email);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_audio_allowance').get().n,1);
    assert.equal(checkRegistrationCode(db,email,issued.code).status,403);
    assert.equal(issueRegistrationCode(db,email).status,429,'使用后仍保留发送冷却');
  }finally{db.close();}
});

test('验证码绑定邮箱、过期拒绝、输错五次后拒绝正确验证码',()=>{
  const db=database();
  try{
    const issued=issueRegistrationCode(db,email);
    assert.equal(registerAccount(db,{email:'other@example.test',password,code:issued.code}).status,403);
    const wrong=issued.code==='000000'?'000001':'000000';
    for(let i=0;i<5;i++)assert.equal(checkRegistrationCode(db,email,wrong).status,403);
    assert.equal(checkRegistrationCode(db,email,issued.code).status,403);
    db.prepare('UPDATE registration_codes SET attempts=0,expires_ms=0 WHERE email=?').run(email);
    assert.equal(checkRegistrationCode(db,email,issued.code).status,403);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,0);
  }finally{db.close();}
});

test('重发替换旧验证码；固定小时内最多五封，过一小时恢复',t=>{
  const db=database();let now=Date.now();t.mock.method(Date,'now',()=>now);
  try{
    const first=issueRegistrationCode(db,email);
    assert.equal(issueRegistrationCode(db,email).status,429);
    now+=60000;
    const next=issueRegistrationCode(db,email);
    assert.notEqual(next.hash,first.hash);
    assert.equal(checkRegistrationCode(db,email,next.code),null);
    if(first.code!==next.code)assert.equal(checkRegistrationCode(db,email,first.code).status,403);
    for(let i=0;i<3;i++){now+=60000;assert.ok(issueRegistrationCode(db,email).code);}
    now+=60000;assert.equal(issueRegistrationCode(db,email).status,429);
    now+=3600000;assert.ok(issueRegistrationCode(db,email).code);
  }finally{db.close();}
});

test('邮件失败撤销验证码并允许重试，不清除小时限额；重置码不能用于注册',()=>{
  const db=database();
  try{
    initPasswordResets(db);
    const reset=issueResetCode(db,email);
    assert.equal(registerAccount(db,{email,password,code:reset.code}).status,403);
    const issued=issueRegistrationCode(db,email);
    cancelRegistrationCode(db,issued);
    assert.equal(checkRegistrationCode(db,email,issued.code).status,403);
    const retry=issueRegistrationCode(db,email);assert.ok(retry.code);
    cancelRegistrationCode(db,issued);
    assert.equal(checkRegistrationCode(db,email,retry.code),null,'迟到的失败不能撤销新的验证码');
    assert.equal(db.prepare('SELECT hour_count FROM registration_codes WHERE email=?').get(email).hour_count,2);
  }finally{db.close();}
});

async function startApp(t,env={}){
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-registration-'));
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server/index.js','--production'],{windowsHide:true,
    env:{...process.env,JIWEN_MODE:'hosted',DATA_DIR:directory,PORT:String(port),HOST:'127.0.0.1',SECURE_COOKIE:'false',
      SMTP_USER:'',SMTP_PASS:'',ADMIN_EMAIL:'',JEV_ENABLED:'false',ASR_QUOTA_MODE:'trial',...env},
    stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  t.after(async()=>{
    child.kill();if(child.exitCode===null)await once(child,'exit');
    const target=path.resolve(directory);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep));
    rmSync(target,{recursive:true,force:true});rmSync(`${target}.deletions.jsonl`,{force:true});
  });
  const request=(action,body)=>fetch(`http://127.0.0.1:${port}/api/auth/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  for(let i=0;i<100;i++){
    try{if((await fetch(`http://127.0.0.1:${port}/api/me`)).ok)return request;}catch{}
    await new Promise(r=>setTimeout(r,50));
  }
  assert.fail(logs);
}

test('注册端到端：模拟 SMTP 投递、限频、邮箱验证、登录、英文邮件及失败重试',{timeout:30000},async t=>{
  const captured=[];let reject=false;
  const smtp=fakeSmtp(captured,{rejectData:()=>reject});await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>smtp.close(r)));
  const request=await startApp(t,{SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.address().port),SMTP_USER:'sender@test.local',SMTP_PASS:'test-only'});
  assert.equal((await request('register',{email,password})).status,400);
  assert.equal((await request('request-registration',{email:'invalid'})).status,400);
  const sent=await request('request-registration',{email});assert.equal(sent.status,200);
  assert.equal(sent.headers.get('set-cookie'),null);
  const json=await sent.json();assert.deepEqual(Object.keys(json).sort(),['message','ok']);
  assert.equal(captured.length,1);
  const body=decodeBody(captured[0]),code=body.match(/验证码是 (\d{6})/)[1];
  assert.match(body,/你正在注册即问/);
  assert.equal((await request('request-registration',{email})).status,429);
  assert.equal((await request('register',{email,password,code:code==='000000'?'000001':'000000'})).status,403);
  const registered=await request('register',{email:email.toUpperCase(),password,code});
  assert.equal(registered.status,200);assert.ok(registered.headers.get('set-cookie'));
  assert.equal((await request('login',{email,password})).status,200);
  assert.equal((await request('register',{email,password,code})).status,409);
  assert.equal((await request('request-registration',{email})).status,409);
  assert.equal((await request('request-registration',{email:'english@example.test',locale:'en'})).status,200);
  assert.match(decodeBody(captured[1]),/registration code is \d{6}/);
  assert.doesNotMatch(decodeBody(captured[1]),/\p{Script=Han}/u);
  reject=true;
  assert.equal((await request('request-registration',{email:'retry@example.test'})).status,502);
  reject=false;
  assert.equal((await request('request-registration',{email:'retry@example.test'})).status,200);
  const retryCode=decodeBody(captured.at(-1)).match(/验证码是 (\d{6})/)[1];
  assert.equal((await request('register',{email:'retry@example.test',password,code:retryCode})).status,200);
});

test('未配置邮件服务时不能发注册验证码，也不能直接注册',{timeout:30000},async t=>{
  const request=await startApp(t);
  assert.equal((await request('request-registration',{email})).status,503);
  assert.equal((await request('register',{email,password,code:'123456'})).status,403);
  assert.equal((await request('login',{email,password})).status,401);
});
