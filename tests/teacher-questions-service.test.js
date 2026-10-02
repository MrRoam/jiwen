import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {openDatabase} from '../server/db.js';
import {createTeacherQuestionService,jevQuestionRequest,callQuestionJev} from '../server/teacher-questions.js';

test('Jev 判断结合后文过滤设问和课堂确认，仅保留待回答问题',async()=>{
  const scratch=path.resolve('output/test-tmp');mkdirSync(scratch,{recursive:true});const dir=mkdtempSync(path.join(scratch,'teacher-'));
  const db=openDatabase(dir),calls=[];
  let service;
  try{
    db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u','u','unused','2026-01-01');
    db.prepare('INSERT INTO lessons VALUES(?,?,?,?,0)').run('l','u','课堂','2026-01-01');
    const rows=[
      {id:'a',text:'电阻增大时电流会怎么变化？',start_ms:0,end_ms:3000},
      {id:'b',text:'这个航船的形状你看见了吗？是看不见的。',start_ms:4000,end_ms:8000},
      {id:'c',text:'为什么这里除以二？因为算了两次。',start_ms:9000,end_ms:13000},
      {id:'d',text:'因为算了两次，接着看下一题。',start_ms:14000,end_ms:17000},
    ];
    for(const s of rows)db.prepare('INSERT INTO segments VALUES(?,?,NULL,?,?,?,1)').run(s.id,'l',s.start_ms,s.end_ms,s.text);
    const fetchImpl=async(_url,options)=>{
      const request=JSON.parse(options.body);calls.push(request);
      const answers={};request.state.targets.forEach((target,i)=>{
        answers[`task_${i}`]={type:'noul',noul:0.95};
        answers[`answered_${i}`]={type:'noul',noul:target.text.includes('除以二')?0.97:0.02};
        answers[`check_${i}`]={type:'noul',noul:target.text.includes('看见了吗')?0.99:0.01};
      });
      return {ok:true,json:async()=>({answers})};
    };
    service=createTeacherQuestionService(db,{key:'fixture',url:'http://127.0.0.1:9999',settleMs:0,lookaheadMs:0,intervalMs:60000,fetchImpl});
    for(const s of rows.slice(0,3))service.enqueue({...s,lesson_id:'l',final:1});
    await service.tick();await service.tick();await service.tick();
    assert.deepEqual(service.results('l').map(r=>r.question),['电阻增大时电流会怎么变化？']);
    assert.equal(calls.length,1,'多个候选合并为一次 Jev 请求');
    assert.ok(calls[0].state.targets.every(t=>rows.some(s=>s.text.includes(t.text))));
    assert.ok(calls[0].state.targets.some(t=>t.after.some(text=>text.includes('因为算了两次'))));
    assert.equal(service.results('other').length,0);
    assert.equal(jevQuestionRequest([{id:'x',question:'为什么？',text:'为什么？',before:[],after:[]}]).questions.task_0.type,'noul');
    service.enqueue({...rows[0],lesson_id:'l',final:1});await service.tick();assert.equal(calls.length,1,'重复定稿不重复调用');
    db.prepare('UPDATE segments SET text=? WHERE id=?').run('电阻越大电流越小。','a');
    assert.deepEqual(service.results('l'),[],'转写修订后旧判断立即失效');
  }finally{service?.close();db.close();if(dir.startsWith(scratch+path.sep))rmSync(dir,{recursive:true,force:true});}
});

test('Jev 返回缺失判断项时不标记提问',async()=>{
  await assert.rejects(callQuestionJev({key:'fixture',url:'http://127.0.0.1:9999',targets:[{id:'x',question:'为什么？',text:'为什么？',before:[],after:[]}],fetchImpl:async()=>({ok:true,json:async()=>({answers:{task_0:{type:'noul',noul:1}}})})}),/无效/);
});
