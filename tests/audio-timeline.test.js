import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioTimeline} from '../server/audio-timeline.js';

test('PCM 中断三分钟后，转写仍对应录音第十一分钟，不被压缩成第八分钟',()=>{
  const timeline=new AudioTimeline();
  timeline.append(480000*32,0);
  timeline.append(1000*32,660000);
  assert.equal(timeline.at(480000),660000);
  assert.equal(timeline.at(480000,true),480000);
  assert.equal(timeline.at(480500),660500);
  assert.equal(timeline.at(481000,true),661000);
});
test('重连偏移、连续包合并和旧客户端均兼容',()=>{
  const timeline=new AudioTimeline(600000);
  for(let i=0;i<100;i++)timeline.append(6400,600000+i*200);
  assert.equal(timeline.spans.length,1);
  assert.equal(timeline.at(20000,true),620000);
  timeline.append(6400);
  assert.equal(timeline.at(20200,true),620200);
});
