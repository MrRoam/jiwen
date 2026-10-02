import test from 'node:test';
import assert from 'node:assert/strict';
import {questionCandidates} from '../src/teacher-question.js';

test('只提取原文候选，不用问号或关键词直接决定显示',()=>{
  assert.deepEqual(questionCandidates('先观察电路。电阻增大时电流会怎么变化？'),['电阻增大时电流会怎么变化？']);
  assert.deepEqual(questionCandidates('请大家计算这个三角形的面积。'),['请大家计算这个三角形的面积。']);
  assert.deepEqual(questionCandidates('电阻增大时电流会怎么变化？会变小。'),['电阻增大时电流会怎么变化？']);
  assert.deepEqual(questionCandidates('到桅杆尖头的一艘航船一样。这个航船的形状你看见了吗？是看不见的，但你站在海岸上，能够遥远的看到远处来了一艘航船，因为它的尖头已经被人发现了。那么还像是'),['这个航船的形状你看见了吗？']);
  assert.deepEqual(questionCandidates('电阻越大，电流越小。'),[]);
});
