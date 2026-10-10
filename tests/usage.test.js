import test from 'node:test';
import assert from 'node:assert/strict';
import {usagePercentage,usageRemainingText,usageResetText,audioRemainingText} from '../src/usage.js';

test('问答和转写按各自额度计算；越界值限制在 0% 到 100%',()=>{
  assert.equal(usagePercentage(90,120),75);
  assert.equal(usagePercentage(5400,7200),75);
  assert.equal(usagePercentage(120,120),100);
  assert.equal(usagePercentage(130,120),100);
  assert.equal(usagePercentage(-1,120),0);
  assert.equal(usagePercentage(0,0),0);
  for(const [remaining,limit] of [[undefined,120],[null,120],[1,undefined],[1,-1],[NaN,1],[1,Infinity]])assert.equal(usagePercentage(remaining,limit),null);
});

test('显示只含百分比；少量剩余和少量消耗不误报为耗尽或满额',()=>{
  assert.equal(usageRemainingText(100,'zh-CN'),'剩余 100%');
  assert.equal(usageRemainingText(usagePercentage(119,120),'zh-CN'),'剩余 99%');
  assert.equal(usageRemainingText(usagePercentage(1,120),'zh-CN'),'剩余不足 1%');
  assert.equal(usageRemainingText(usagePercentage(1,7200),'en'),'Less than 1% remaining');
  assert.equal(usageRemainingText(0,'zh-CN'),'已用完 · 0%');
  assert.equal(usageRemainingText(null,'en'),'Unable to load');
  assert.equal(usageRemainingText(75,'en'),'75% remaining');
});

test('重置时间使用服务器日期和北京时间；跨日、跨年和英文均正确',()=>{
  assert.equal(usageResetText('2026-10-06T00:00:00.000Z','zh-CN'),'北京时间 2026/10/06 08:00 重置');
  assert.equal(usageResetText('2026-12-31T16:00:00.000Z','zh-CN'),'北京时间 2027/01/01 00:00 重置');
  assert.equal(usageResetText('2026-10-06T00:00:00.000Z','en'),'Resets 10/06/2026, 08:00 (UTC+8)');
  for(const value of [null,undefined,'','invalid'])assert.equal(usageResetText(value,'zh-CN'),null);
});

test('一次性体验以分钟显示，少于一分钟仍有余额，失败不显示满额',()=>{
  assert.equal(audioRemainingText({remainingSeconds:3600,limitSeconds:3600},'zh-CN'),'剩余 60 分钟 / 共 60 分钟');
  assert.equal(audioRemainingText({remainingSeconds:.2,limitSeconds:3600},'zh-CN'),'剩余不足 1 分钟');
  assert.equal(audioRemainingText({remainingSeconds:0,limitSeconds:3600},'en'),'Transcription trial used up');
  assert.equal(audioRemainingText(null,'en'),'Unable to load');
});
