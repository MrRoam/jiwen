import test from 'node:test';
import assert from 'node:assert/strict';
import {createASRStartQueue} from '../server/asr-start-queue.js';

function fixture(options={}){
  let time=0,sequence=0;const timers=new Map();
  const queue=createASRStartQueue({...options,clock:()=>time,setTimer:(callback,delay)=>{const id=++sequence;timers.set(id,{callback,at:time+delay});return id;},clearTimer:id=>timers.delete(id)});
  function advance(target){
    while(timers.size){const [id,next]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(next.at>target)break;time=next.at;timers.delete(id);next.callback();}
    time=target;
  }
  return {queue,advance,time:()=>time,timers};
}

test('50个集中启动按顺序匀速接入，事件循环延迟后不追赶突发，已启动任务继续发送',()=>{
  const f=fixture(),started=[],sent=[];
  const connections=Array.from({length:50},(_,id)=>f.queue.create(()=>{started.push({id,at:f.time()});return {send:bytes=>{sent.push({id,bytes});return true;},finish(){},close(){}};},assert.fail));
  assert.equal(started.length,1);assert.equal(connections[49].send('waiting'),false);
  f.advance(4000);assert.equal(started.length,50);assert.deepEqual(started.map(s=>s.id),Array.from({length:50},(_,i)=>i));
  for(let i=1;i<started.length;i++)assert.ok(started[i].at-started[i-1].at>=1000/15);
  for(const start of started)assert.ok(started.filter(other=>other.at>=start.at&&other.at<start.at+1000).length<=15);
  assert.equal(connections[0].send('live'),true);assert.equal(connections[49].send('live'),true);assert.equal(sent.length,2);
  f.queue.close();assert.equal(f.timers.size,0);
});

test('等待时取消不创建供应商连接，结束请求沿用自己的任务，排队有界且关闭清理定时器',async()=>{
  const f=fixture({maxQueued:2}),started=[],ended=[],errors=[];
  const make=id=>f.queue.create(()=>{started.push(id);return {send:()=>true,finish:()=>ended.push(id),close(){}};},error=>errors.push(error));
  make('first');const cancelled=make('cancelled'),last=make('last');
  make('full');await Promise.resolve();assert.equal(errors.length,1);assert.match(errors[0],/排队已满/);
  cancelled.close();last.finish();f.advance(100);assert.deepEqual(started,['first','last']);assert.deepEqual(ended,['last']);
  make('never');f.queue.close();f.advance(10000);assert.deepEqual(started,['first','last']);assert.equal(f.timers.size,0);
});

test('供应商启动异常报告给当前任务，后续任务可继续启动；非法速率拒绝',()=>{
  const f=fixture(),errors=[];f.queue.create(()=>{throw new Error('启动失败');},error=>errors.push(error));
  let next=false;f.queue.create(()=>{next=true;return {send:()=>true,finish(){},close(){}};},assert.fail);f.advance(100);
  assert.deepEqual(errors,['启动失败']);assert.equal(next,true);f.queue.close();
  for(const rate of [0,-1,NaN,Infinity,21])assert.throws(()=>createASRStartQueue({startsPerSecond:rate}));
});
