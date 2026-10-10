import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {audioBudget} from '../server/audio-budget.js';

function fixture(t,limit=2,globalDaily=21600){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE asr_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,seconds REAL NOT NULL,created_at TEXT NOT NULL)');
  t.after(()=>db.close());return {db,budget:audioBudget(db,{perUser:limit,globalDaily})};
}
const pcm=seconds=>Buffer.alloc(seconds*32000);
const time=Date.parse('2026-10-05T02:00:00Z');

test('补转写累计额度与用量在同一事务，失败回滚后重试不产生半份记账',t=>{
  const {db,budget}=fixture(t);
  db.exec('CREATE TABLE credits(id TEXT PRIMARY KEY,seconds INTEGER NOT NULL); INSERT INTO credits VALUES(\'recording\',0)');
  let fail=true;
  const session=budget.open('a','atomic-credit',seconds=>{db.prepare('UPDATE credits SET seconds=seconds+? WHERE id=?').run(seconds,'recording');if(fail)throw new Error('simulated-write-failure');});
  assert.throws(()=>session.send(pcm(1),()=>true,time),/simulated-write-failure/);
  assert.equal(budget.usage('a',time).usedSeconds,0);assert.equal(db.prepare('SELECT seconds FROM credits').get().seconds,0);
  fail=false;assert.equal(session.send(pcm(1),()=>true,time).accepted,true);
  assert.equal(budget.usage('a',time).usedSeconds,1);assert.equal(db.prepare('SELECT seconds FROM credits').get().seconds,1);
});

test('实际转发才扣转写额度，不足整包不会触发供应商，账号独立',t=>{
  const {budget}=fixture(t),session=budget.open('a','one');let calls=0;
  const forward=()=>{calls++;return true;};
  assert.equal(session.send(pcm(1),forward,time).accepted,true);
  assert.equal(session.send(pcm(2),forward,time).accepted,false);
  assert.equal(calls,1);assert.equal(budget.usage('a',time).usedSeconds,1);
  assert.equal(budget.open('b').send(pcm(2),forward,time).accepted,true);
  assert.equal(budget.usage('b',time).remainingSeconds,0);
  assert.equal(session.send(pcm(1),forward,time).accepted,true);
  assert.match(session.send(pcm(1),forward,time).error,/转写额度已用完/);
});

test('未就绪及发送异常不扣款，已发送音频断线后不返还',t=>{
  const {budget}=fixture(t),session=budget.open('a','first');
  assert.equal(session.send(pcm(1),()=>false,time).accepted,false);
  assert.equal(budget.usage('a',time).usedSeconds,0);
  assert.throws(()=>session.send(pcm(1),()=>{throw new Error('socket failure');},time),/socket failure/);
  assert.equal(budget.usage('a',time).usedSeconds,0);
  assert.equal(session.send(pcm(1),()=>true,time).accepted,true);
  assert.equal(budget.usage('a',time).usedSeconds,1);
});

test('重建预算器与重连累计使用，删除课堂不删除用量',t=>{
  const {db,budget}=fixture(t);
  db.exec('CREATE TABLE lessons(id TEXT PRIMARY KEY); INSERT INTO lessons VALUES (\'lesson\')');
  budget.open('a','first').send(pcm(1),()=>true,time);
  db.exec("DELETE FROM lessons WHERE id='lesson'");
  const restarted=audioBudget(db,{perUser:2});
  restarted.open('a','second').send(pcm(1),()=>true,time);
  assert.equal(restarted.usage('a',time).remainingSeconds,0);
  assert.equal(restarted.open('a','third').send(pcm(1),()=>true,time).accepted,false);
});

test('一个连接跨 UTC 月，新音频使用新月额度，边界小包不会遗漏',t=>{
  const {budget}=fixture(t,1),session=budget.open('a','cross-month');
  const october=Date.parse('2026-10-31T23:59:59.900Z'),november=Date.parse('2026-11-01T00:00:00.100Z');
  assert.equal(session.send(pcm(.2),()=>true,october).accepted,true);
  assert.equal(session.send(pcm(.2),()=>true,november).accepted,true);
  assert.equal(budget.usage('a',october).usedSeconds,1);
  assert.equal(budget.usage('a',november).usedSeconds,1);
  assert.equal(budget.usage('a',november).resetsAt,'2026-12-01T00:00:00.000Z');
  assert.equal(session.send(pcm(.8),()=>true,november).accepted,true);
  assert.equal(session.send(pcm(.2),()=>true,november).accepted,false);
});

test('供应商用量累计回报不重复计数，完整预留秒内的小包可继续发送',t=>{
  const {budget}=fixture(t,1),session=budget.open('a','reported');
  for(let i=0;i<5;i++)assert.equal(session.send(pcm(.2),()=>true,time).accepted,true);
  session.onUsage(1,time);session.onUsage(1,time);session.onUsage(.5,time);session.onUsage(NaN,time);
  assert.equal(budget.usage('a',time).usedSeconds,1);
  assert.equal(session.send(pcm(.2),()=>true,time).accepted,false);
  session.onUsage(2,time);assert.equal(budget.usage('a',time).usedSeconds,2);
});

test('全站日额度跨账号共同扣减，拒绝整包不发送也不扣任何额度',t=>{
  const {budget}=fixture(t,10,3),a=budget.open('a','global-a'),b=budget.open('b','global-b');let sent=0;
  const forward=()=>{sent++;return true;};
  assert.equal(a.send(pcm(2),forward,time).accepted,true);
  const blocked=b.send(pcm(2),forward,time);assert.equal(blocked.accepted,false);assert.match(blocked.error,/全站今日转写额度已用完/);
  assert.equal(sent,1);assert.equal(budget.usage('a',time).usedSeconds,2);assert.equal(budget.usage('b',time).usedSeconds,0);
  assert.equal(budget.usage('b',time).globalUsedSeconds,2);assert.equal(budget.usage('b',time).globalRemainingSeconds,1);
  assert.equal(b.send(pcm(1),forward,time).accepted,true);assert.equal(budget.usage('a',time).globalRemainingSeconds,0);
  assert.equal(a.send(pcm(1),forward,time).accepted,false);assert.equal(sent,2);
});

test('不同账号同轮并发发送只能共享全站剩余额度，独立预算器也读取实时累计',async t=>{
  const {db,budget}=fixture(t,10,2),otherBudget=audioBudget(db,{perUser:10,globalDaily:2});let sent=0;
  const sessions=[budget.open('a','parallel-a'),otherBudget.open('b','parallel-b'),budget.open('c','parallel-c')];
  const results=await Promise.all(sessions.map(session=>Promise.resolve().then(()=>session.send(pcm(1),()=>{sent++;return true;},time))));
  assert.equal(results.filter(result=>result.accepted).length,2);assert.equal(sent,2);
  assert.equal(budget.usage('a',time).globalUsedSeconds,2);assert.equal(otherBudget.usage('c',time).globalRemainingSeconds,0);
  assert.equal(budget.usage('c',time).usedSeconds,0);assert.match(results[2].error,/全站今日/);
});

test('同一连接跨 UTC 日拆分用量，月额度仍累计，次日重新获得全站日额度',t=>{
  const {db,budget}=fixture(t,10,1),session=budget.open('a','cross-day');
  const today=Date.parse('2026-10-05T23:59:59.900Z'),tomorrow=Date.parse('2026-10-06T00:00:00.100Z');
  assert.equal(session.send(pcm(.2),()=>true,today).accepted,true);
  assert.equal(budget.usage('a',today).globalRemainingSeconds,0);
  assert.equal(session.send(pcm(.2),()=>true,tomorrow).accepted,true);
  assert.equal(budget.usage('a',tomorrow).usedSeconds,2);assert.equal(budget.usage('a',tomorrow).globalUsedSeconds,1);
  assert.equal(budget.usage('a',today).globalUsedSeconds,1);assert.equal(budget.usage('a',tomorrow).globalResetsAt,'2026-10-07T00:00:00.000Z');
  assert.equal(session.send(pcm(.8),()=>true,tomorrow).accepted,true);
  assert.match(session.send(pcm(.2),()=>true,tomorrow).error,/全站今日/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM asr_usage').get().count,2);
});

test('重建预算器及重连不会返还全站当日额度，次日只统计当天的真实记录',t=>{
  const {db,budget}=fixture(t,10,2);
  budget.open('a','before-restart').send(pcm(1),()=>true,time);
  const restarted=audioBudget(db,{perUser:10,globalDaily:2});
  assert.equal(restarted.usage('b',time).globalUsedSeconds,1);
  assert.equal(restarted.open('b','after-restart').send(pcm(1),()=>true,time).accepted,true);
  assert.equal(restarted.open('c','after-limit').send(pcm(1),()=>true,time).accepted,false);
  const tomorrow=time+24*3600*1000;
  assert.equal(restarted.usage('a',tomorrow).globalUsedSeconds,0);assert.equal(restarted.usage('a',tomorrow).usedSeconds,1);
  assert.equal(restarted.open('c','next-day').send(pcm(2),()=>true,tomorrow).accepted,true);
  assert.equal(restarted.usage('a',tomorrow).globalUsedSeconds,2);
});

test('未就绪和发送异常不扣全站额度，已预留一秒的小包按实际同日用量累计',t=>{
  const {budget}=fixture(t,10,1),session=budget.open('a','global-rounding');
  assert.equal(session.send(pcm(1),()=>false,time).accepted,false);
  assert.throws(()=>session.send(pcm(1),()=>{throw new Error('provider unavailable');},time),/provider unavailable/);
  assert.equal(budget.usage('a',time).globalUsedSeconds,0);
  for(let i=0;i<5;i++)assert.equal(session.send(pcm(.2),()=>true,time).accepted,true);
  assert.equal(budget.usage('a',time).globalUsedSeconds,1);
  assert.match(budget.open('b','global-rounded-other').send(pcm(.2),()=>true,time).error,/全站今日/);
  assert.equal(session.send(pcm(.2),()=>true,time).accepted,false);
});

test('全站默认每天100音频小时，非法全站额度明确拒绝',t=>{
  const {db}=fixture(t),budget=audioBudget(db);
  assert.equal(budget.usage('a',time).globalLimitSeconds,360000);
  assert.equal(budget.usage('a',time).globalRemainingSeconds,360000);
  for(const globalDaily of [0,-1,1.5,NaN,Infinity])assert.throws(()=>audioBudget(db,{globalDaily}),/全站每日转写额度必须是正整数/);
});

test('注销清理个人用量不会返还全站日额度，匿名汇总不含账号标识',t=>{
  const {db,budget}=fixture(t,10,2);
  budget.open('a','deleted-account').send(pcm(1),()=>true,time);
  db.prepare('DELETE FROM asr_usage WHERE user_id=?').run('a');
  const restarted=audioBudget(db,{perUser:10,globalDaily:2});
  assert.equal(restarted.usage('a',time).usedSeconds,0);assert.equal(restarted.usage('b',time).globalUsedSeconds,1);
  assert.equal(restarted.open('b','remaining-account').send(pcm(1),()=>true,time).accepted,true);
  assert.match(restarted.open('c','after-delete-limit').send(pcm(1),()=>true,time).error,/全站今日/);
  assert.deepEqual(db.prepare('PRAGMA table_info(asr_global_usage)').all().map(column=>column.name),['day','seconds']);
});

test('旧库当天用量首次迁移取现有匿名汇总与个人累计的较大值，重建不重复累加',t=>{
  const {db}=fixture(t,10,5);t.mock.method(Date,'now',()=>time);
  db.exec('DROP TABLE asr_global_usage');
  db.prepare('INSERT INTO asr_usage VALUES(?,?,?,?)').run('legacy','a',3,new Date(time).toISOString());
  const migrated=audioBudget(db,{perUser:10,globalDaily:5});
  assert.equal(migrated.usage('b',time).globalUsedSeconds,3);
  assert.equal(audioBudget(db,{perUser:10,globalDaily:5}).usage('b',time).globalUsedSeconds,3);
  db.prepare('UPDATE asr_global_usage SET seconds=4 WHERE day=?').run('2026-10-05');
  const restored=audioBudget(db,{perUser:10,globalDaily:5});assert.equal(restored.usage('b',time).globalUsedSeconds,4);
  assert.equal(restored.open('b','after-migrate').send(pcm(1),()=>true,time).accepted,true);
  assert.equal(restored.usage('b',time).globalUsedSeconds,5);assert.equal(restored.usage('b',time).usedSeconds,1);
});

test('供应商新增用量同时记入匿名日汇总，跨日报告不会重复计算已预留的秒数',t=>{
  const {budget}=fixture(t,10,10),session=budget.open('a','global-reported');
  session.send(pcm(1),()=>true,time);session.onUsage(2,time);session.onUsage(2,time);session.onUsage(1.5,time);
  assert.equal(budget.usage('a',time).globalUsedSeconds,2);
  const tomorrow=time+24*3600*1000;
  session.send(pcm(.2),()=>true,tomorrow);session.onUsage(3,tomorrow);
  assert.equal(budget.usage('a',tomorrow).globalUsedSeconds,1);session.onUsage(4,tomorrow);
  assert.equal(budget.usage('a',tomorrow).globalUsedSeconds,2);assert.equal(budget.usage('a',time).globalUsedSeconds,2);
  assert.equal(budget.usage('a',tomorrow).usedSeconds,4);
});
