import {registerTestAccount as registerAccount} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initAccounts} from '../server/accounts.js';
import {audioBudget} from '../server/audio-budget.js';
import {audioQuotaMode} from '../server/audio-allowance.js';
import {createLifecycle} from '../server/lifecycle.js';
import {deleteAccountRows} from '../server/account-data.js';

const timestamp=Date.parse('2026-10-10T00:00:00Z'),pcm=seconds=>Buffer.alloc(seconds*32000);
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE asr_usage(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),seconds REAL NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE lessons(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));`);
  initAccounts(db,{quotaMode:'trial'});
  const user=registerAccount(db,{email:'trial@example.test',password:'test-password123'},{quotaMode:'trial'}).user;
  return {db,user,budget:audioBudget(db,{mode:'trial',globalDaily:10000})};
}

test('新账号固定一次性3600秒，读取不重新赠送，注册失败回滚账号和赠送',t=>{
  const {db,user,budget}=fixture(t),usage=budget.usage(user.id,timestamp);
  assert.equal(usage.limitSeconds,3600);assert.equal(usage.remainingSeconds,3600);assert.equal(usage.period,'lifetime');assert.equal(usage.resetsAt,null);
  budget.open(user.id).send(pcm(1),()=>true,timestamp);
  assert.equal(budget.usage(user.id,timestamp).remainingSeconds,3599);
  assert.equal(registerAccount(db,{email:user.email,password:'test-password123'},{quotaMode:'trial'}).status,409);
  db.exec("CREATE TRIGGER refuse_grant BEFORE INSERT ON account_audio_allowance BEGIN SELECT RAISE(ABORT,'failed grant'); END");
  assert.throws(()=>registerAccount(db,{email:'failed@example.test',password:'test-password123'},{quotaMode:'trial'}),/failed grant/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email='failed@example.test'").get().n,0);
  db.prepare('DELETE FROM account_audio_allowance WHERE user_id=?').run(user.id);
  assert.throws(()=>budget.usage(user.id),/无法读取/);
});

test('已有账号仅首次切换获得新额度；跨月、重启、模式往返保留已用量',t=>{
  const {db,user,budget}=fixture(t);
  db.prepare('INSERT INTO asr_usage VALUES(?,?,?,?)').run('history',user.id,5000,new Date(timestamp).toISOString());
  budget.open(user.id,'fresh').send(pcm(2),()=>true,timestamp);
  initAccounts(db,{quotaMode:'trial'});
  const monthly=audioBudget(db,{mode:'monthly',perUser:9999});assert.equal(monthly.usage(user.id,timestamp).limitSeconds,9999);
  const resumed=audioBudget(db,{mode:'trial',perUser:1});
  assert.equal(resumed.usage(user.id,timestamp+100*86400000).usedSeconds,2);
  assert.equal(resumed.usage(user.id,timestamp+100*86400000).remainingSeconds,3598);
  assert.throws(()=>audioQuotaMode('week'),/ASR_QUOTA_MODE/);
});

test('并发连接共享最后一秒，未发送不扣，个人用尽优先于全站恢复',async t=>{
  const {db,user,budget}=fixture(t);
  db.prepare('UPDATE account_audio_allowance SET used_seconds=3599 WHERE user_id=?').run(user.id);
  const other=audioBudget(db,{mode:'trial',globalDaily:10000});let sent=0;
  assert.equal(budget.open(user.id,'not-sent').send(pcm(1),()=>false,timestamp).accepted,false);
  const results=await Promise.all([budget,other].map((value,i)=>Promise.resolve().then(()=>value.open(user.id,`parallel-${i}`).send(pcm(1),()=>{sent++;return true;},timestamp))));
  assert.equal(sent,1);assert.equal(results.filter(r=>r.accepted).length,1);
  const blocked=budget.open(user.id).send(pcm(1),()=>true,timestamp+86400000);
  assert.equal(blocked.code,'trial_exhausted');assert.match(blocked.error,/1 小时转写体验已用完/);
  assert.equal(budget.globalUsage(timestamp).globalUsedSeconds,1);
});

test('事务失败回滚累计额度和明细，供应商新增用量不会丢失或重复',t=>{
  const {user,budget}=fixture(t);let fail=true;
  const session=budget.open(user.id,'atomic',()=>{if(fail)throw new Error('failed write');});
  assert.throws(()=>session.send(pcm(1),()=>true,timestamp),/failed write/);
  assert.equal(budget.usage(user.id,timestamp).usedSeconds,0);
  fail=false;session.send(pcm(1),()=>true,timestamp);session.onUsage(3601,timestamp);session.onUsage(3601,timestamp);
  assert.equal(budget.usage(user.id,timestamp).usedSeconds,3601);assert.equal(budget.usage(user.id,timestamp).remainingSeconds,0);
});

test('删除课堂、90天明细清理不返还体验额度，注销级联清理赠送表',async t=>{
  const {db,user,budget}=fixture(t);
  budget.open(user.id).send(pcm(1),()=>true,timestamp);
  db.prepare('INSERT INTO lessons VALUES(?,?)').run('lesson',user.id);
  db.exec("DELETE FROM lessons WHERE id='lesson'");
  await createLifecycle(db,{now:()=>timestamp+100*86400000}).run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM asr_usage').get().n,0);
  assert.equal(budget.usage(user.id).usedSeconds,1);
  deleteAccountRows(db,user);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_audio_allowance').get().n,0);
});
