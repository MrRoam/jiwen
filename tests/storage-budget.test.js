import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../server/db.js';
import {createStorageBudget} from '../server/storage-budget.js';

function actualBytes(directory){return readdirSync(directory,{withFileTypes:true}).reduce((sum,entry)=>sum+(entry.isDirectory()?actualBytes(path.join(directory,entry.name)):statSync(path.join(directory,entry.name)).size),0);}

function setup(t,options={}){
  const directory=mkdtempSync(path.join(tmpdir(),'jiwen-space-')),db=openDatabase(directory);
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u','user','unused','2026-10-07');
  db.prepare('INSERT INTO lessons(id,user_id,title,created_at) VALUES(?,?,?,?)').run('l','u','测试','2026-10-07');
  const record=id=>{db.prepare('INSERT INTO recordings(id,lesson_id,offset_ms,mime,created_at) VALUES(?,?,?,?,?)').run(id,'l',0,'audio/webm','2026-10-07');mkdirSync(path.join(directory,id));};
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  const budget=createStorageBudget(db,{dataDir:directory,accountBytes:12*1024**2,globalBytes:128*1024**2,minFreeBytes:0,statfs:()=>({bavail:1024**3,bsize:1}),...options});
  return {directory,db,record,budget};
}

test('同步预留不会向两次录音重复分配相同空间',t=>{
  const {budget,record}=setup(t);record('a');record('b');
  assert.equal(budget.begin('a','u',100).maxSeconds,100);
  assert.throws(()=>budget.begin('b','u',100),/空间不足/);
  budget.release('a');assert.equal(budget.begin('b','u',100).maxSeconds,100);
});
test('实际文件包括原始块、回放、兼容文件、临时文件和全站孤儿及数据库',t=>{
  const {budget,record,directory}=setup(t);record('a');
  for(const name of ['0.chunk','audio.m4a','audio.mp3','input.tmp'])writeFileSync(path.join(directory,'a',name),Buffer.alloc(100));
  writeFileSync(path.join(directory,'orphan.tmp'),Buffer.alloc(1000));
  const state=budget.usage('u');assert.equal(state.audioBytes,400);assert.equal(state.usedBytes,400+state.textBytes);assert.ok(state.textBytes>0);assert.ok(state.globalUsedBytes>=1400);assert.equal(state.globalReservedBytes,0);
});
test('录音消费自身预留并保留尾段，不受其他任务准入失败影响',t=>{
  const {budget,record,directory,db}=setup(t);record('a');record('b');budget.begin('a','u',100);
  assert.throws(()=>budget.begin('b','u',100),/空间不足/);
  const result=budget.onChunk('a','u',1600000,100000);assert.equal(result.stopSoon,true);
  writeFileSync(path.join(directory,'a','0.chunk'),Buffer.alloc(1600000));db.prepare('INSERT INTO chunks VALUES(?,?,?,?)').run('a',0,1600000,'hash');
  assert.doesNotThrow(()=>budget.onChunk('a','u',1000,100001));
  const state=budget.usage('u');assert.equal(state.audioBytes,1600000);assert.equal(state.usedBytes,state.audioBytes+state.textBytes);assert.ok(state.reservedBytes>0);budget.finish('a');assert.equal(budget.usage('u').reservedBytes,0);
});
test('磁盘保留余量影响新录音，恢复补传与转换也必须预留峰值',t=>{
  const {budget,record}=setup(t,{minFreeBytes:40*1024**2,statfs:()=>({bavail:45*1024**2,bsize:1})});record('a');
  const capacity=budget.begin('a','u',7200);assert.ok(capacity.maxSeconds>0&&capacity.maxSeconds<100);
  budget.release('a');assert.throws(()=>budget.preflight('a','u',6*1024**2),/转换所需空间不足/);
  assert.doesNotThrow(()=>budget.onChunk('a','u',1000,1000));assert.ok(budget.usage('u').reservedBytes>1000);
});
test('账号计入UTF-8课堂文字及冻结快照，全站不重复加逻辑文本',t=>{
  const {budget,record,directory,db}=setup(t);record('a');
  const before=budget.usage('u'),snapshot='中'.repeat(3*1024**2);
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run('c','l','对话',0,snapshot,'2026-10-07');
  const after=budget.usage('u');assert.equal(after.audioBytes,0);assert.ok(after.textBytes-before.textBytes>=Buffer.byteLength(snapshot));
  assert.equal(after.usedBytes,after.textBytes);assert.equal(after.globalUsedBytes,actualBytes(directory));assert.throws(()=>budget.begin('a','u',100),/空间不足/);
});
test('不定长迟到补传逐段重算转换峰值，不能挤占另一账号录音预留',t=>{
  const {budget,record,directory,db}=setup(t,{globalBytes:12*1024**2});record('a');
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('other','other','unused','2026-10-07');db.prepare('INSERT INTO lessons(id,user_id,title,created_at) VALUES(?,?,?,?)').run('other','other','另课','2026-10-07');
  db.prepare('INSERT INTO recordings(id,lesson_id,offset_ms,mime,created_at) VALUES(?,?,?,?,?)').run('b','other',0,'audio/webm','2026-10-07');mkdirSync(path.join(directory,'b'));
  budget.begin('b','other',60);budget.onChunk('a','u',1000,1000);writeFileSync(path.join(directory,'a','0.chunk'),Buffer.alloc(1000));db.prepare('INSERT INTO chunks VALUES(?,?,?,?)').run('a',0,1000,'hash');
  assert.throws(()=>budget.onChunk('a','u',1024**2,200000),/转换所需空间不足/);assert.doesNotThrow(()=>budget.onChunk('b','other',1000,1000));
});
test('已停止录音按实际转换峰值收缩预留，保留文本后也能保存',t=>{
  const {budget,record,db}=setup(t);record('a');budget.begin('a','u',100);
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run('c','l','对话',0,'x'.repeat(3*1024**2),'2026-10-07');
  assert.throws(()=>budget.preflight('a','u',1024**2),/转换所需空间不足/);
  assert.doesNotThrow(()=>budget.preflight('a','u',1024**2,{replace:true}));assert.equal(budget.usage('u').reservedBytes,1024**2);
});
test('并行文本请求按账号和全站同步预留，结束释放一次',t=>{
  const {budget}=setup(t,{accountBytes:1024**2,globalBytes:4*1024**2});
  const permit=budget.reserveText('u',800000);assert.throws(()=>budget.reserveText('u',300000),/空间不足/);
  const state=budget.usage('u');assert.equal(state.reservedBytes,800000);assert.equal(state.globalReservedBytes,1600000);
  permit.release();permit.release();assert.equal(budget.usage('u').reservedBytes,0);assert.doesNotThrow(()=>budget.preflightText('u',300000));
});
test('不同账号的文本预留覆盖数据库及WAL峰值并保护录音许可',t=>{
  const {budget,record}=setup(t,{globalBytes:12*1024**2});record('a');budget.begin('a','u',100);
  assert.throws(()=>budget.reserveText('other',2*1024**2),/空间不足/);
  assert.doesNotThrow(()=>budget.onChunk('a','u',1000,1000));
  budget.release('a');const permit=budget.reserveText('other',4*1024**2);assert.throws(()=>budget.reserveText('u',3*1024**2),/空间不足/);permit.release();
});
test('短录音中断收缩未来空间，仍为尾段及转换保留空间并容纳新录音',t=>{
  const {budget,record}=setup(t,{accountBytes:30*1024**2});record('a');record('b');
  budget.begin('a','u',400);const before=budget.usage('u').reservedBytes;budget.interrupt('a','u',1000);
  assert.ok(budget.usage('u').reservedBytes<before);assert.ok(budget.usage('u').reservedBytes>4*1024**2);
  assert.doesNotThrow(()=>budget.begin('b','u',100));assert.doesNotThrow(()=>budget.onChunk('a','u',1000,1000));
});
test('中断后恢复重新计算有限采集时长，停止阈值使用累计时长',t=>{
  const {budget,record,db,directory}=setup(t,{accountBytes:40*1024**2});record('a');budget.begin('a','u',400);
  db.prepare('UPDATE recordings SET duration_ms=? WHERE id=?').run(100000,'a');writeFileSync(path.join(directory,'a','0.chunk'),Buffer.alloc(1000));db.prepare('INSERT INTO chunks VALUES(?,?,?,?)').run('a',0,1000,'hash');
  budget.interrupt('a','u',100000);const restored=budget.begin('a','u',50);
  assert.equal(restored.maxSeconds,50);assert.ok(Number.isFinite(restored.maxSeconds));
  assert.equal(budget.onChunk('a','u',1000,105000).stopSoon,false);assert.equal(budget.onChunk('a','u',1000,150000).stopSoon,true);
});
