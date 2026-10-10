import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createLifecycle,initLifecycle} from '../server/lifecycle.js';
import {createCosts} from '../server/costs.js';

function setup(t){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lessons(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,created_at TEXT);CREATE TABLE sessions(token TEXT,expires INTEGER);CREATE TABLE password_resets(email TEXT,expires_ms INTEGER);CREATE TABLE asr_usage(id TEXT,created_at TEXT);CREATE TABLE llm_requests(id INTEGER,created_ms INTEGER);CREATE TABLE llm_provider_requests(id INTEGER,created_ms INTEGER);CREATE TABLE importance_usage(day TEXT);CREATE TABLE teacher_question_usage(day TEXT);`);
  t.after(()=>db.close());return db;
}
const initial=Date.parse('2026-10-07T00:00:00.000Z'),day=86400000;
test('旧课堂获得完整30天窗口，重复初始化不悄悄延期',t=>{
  const db=setup(t);db.prepare('INSERT INTO lessons VALUES(?,?,?,?)').run('old','u','旧课','2020-01-01');
  initLifecycle(db,()=>initial);assert.equal(db.prepare('SELECT expires_at FROM lessons').get().expires_at,'2026-11-06T00:00:00.000Z');
  initLifecycle(db,()=>initial+day);assert.equal(db.prepare('SELECT expires_at FROM lessons').get().expires_at,'2026-11-06T00:00:00.000Z');
});
test('成功音频延长保存期，到期清理跳过正在使用的课堂',async t=>{
  const db=setup(t);for(const id of ['a','busy'])db.prepare('INSERT INTO lessons VALUES(?,?,?,?)').run(id,'u','课','2026-10-07');
  let timestamp=initial;const deleted=[];
  const lifecycle=createLifecycle(db,{now:()=>timestamp,isBusy:id=>id==='busy',deleteLesson:lesson=>{deleted.push(lesson.id);db.prepare('DELETE FROM lessons WHERE id=?').run(lesson.id);}});
  timestamp+=day;lifecycle.touch('a');timestamp=initial+30*day;
  let result=await lifecycle.run();assert.deepEqual(result.deleted,[]);assert.deepEqual(result.skipped,['busy']);
  timestamp+=day;result=await lifecycle.run();assert.deepEqual(result.deleted,['a']);assert.deepEqual(deleted,['a']);
});
test('实际 schema 的会话、找回验证码和90天调用记录按期限清理',async t=>{
  const db=setup(t);const lifecycle=createLifecycle(db,{now:()=>initial});
  const costs=createCosts(db),route={name:'openrouter',model:'fixture:free',baseUrl:'https://openrouter.ai/api/v1'};
  costs.beginQuestion(route,initial-91*day);costs.beginQuestion(route,initial-day);
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('expired',initial-1);db.prepare('INSERT INTO sessions VALUES(?,?)').run('live',initial+1);
  db.prepare('INSERT INTO password_resets VALUES(?,?)').run('expired',initial-1);
  db.prepare('INSERT INTO asr_usage VALUES(?,?)').run('old',new Date(initial-91*day).toISOString());db.prepare('INSERT INTO asr_usage VALUES(?,?)').run('recent',new Date(initial-day).toISOString());
  db.prepare('INSERT INTO llm_requests VALUES(?,?)').run(1,initial-91*day);
  db.prepare('INSERT INTO llm_provider_requests VALUES(?,?)').run(1,initial-91*day);for(const table of ['importance_usage','teacher_question_usage'])db.prepare(`INSERT INTO ${table} VALUES(?)`).run(new Date(initial-91*day).toISOString().slice(0,10));
  await lifecycle.run();assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM password_resets').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM asr_usage').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM llm_requests').get().n,0);
  for(const table of ['llm_provider_requests','importance_usage','teacher_question_usage'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cost_usage').get().n,1,'保留近90天成本，按日清理过期记录');
});
