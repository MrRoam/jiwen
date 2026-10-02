import test from 'node:test';
import assert from 'node:assert/strict';
import {groupTranscript,questionAnchor,nearTranscriptBottom} from '../src/transcript.js';

test('录音 32 分钟、转写 26 分钟时新问题仍能关联可见内容；回放保持用户指定位置',()=>{
  const segments=[{id:'a',text:'电阻具有无源特性',end_ms:1571320}];
  assert.equal(questionAnchor(segments,1961326),1571320);
  assert.equal(questionAnchor(segments,1961326,500000),500000);
  assert.equal(questionAnchor([],1961326),1961326);
});
test('手动滚回底部和底部容差内均恢复跟随，上翻离开底部才退出',()=>{
  assert.equal(nearTranscriptBottom({scrollHeight:1000,clientHeight:300,scrollTop:700}),true);
  assert.equal(nearTranscriptBottom({scrollHeight:1000,clientHeight:300,scrollTop:660}),true);
  assert.equal(nearTranscriptBottom({scrollHeight:1000,clientHeight:300,scrollTop:500}),false);
});

test('短句合并显示，保留原句和提问时间戳；长停顿和不同录音另起段',()=>{
  const segments=[{id:'a',recording_id:'r',start_ms:0,end_ms:3000,text:'第一句。',final:1},{id:'b',recording_id:'r',start_ms:3500,end_ms:6000,text:'第二句。',final:1},{id:'c',recording_id:'r',start_ms:15000,end_ms:16000,text:'另一个话题。',final:1},{id:'d',recording_id:'next',start_ms:17000,end_ms:20000,text:'继续录音。',final:1}];
  const groups=groupTranscript(segments);assert.equal(groups.length,3);assert.deepEqual(groups[0].segments,segments.slice(0,2));assert.equal(groups[0].text,'第一句。第二句。');assert.equal(segments[0].text,'第一句。');
});

test('段落限制为一分钟或 280 字，临时识别更新不重复',()=>{
  const base={recording_id:'r',final:1,start_ms:0,end_ms:5000};
  const segments=[{...base,id:'a',text:'字'.repeat(260)},{...base,id:'b',start_ms:5000,end_ms:8000,text:'字'.repeat(30)},{...base,id:'c',start_ms:9000,end_ms:70000,text:'很长的讲解'}];
  assert.equal(groupTranscript(segments).length,3);
});
