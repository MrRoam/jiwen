import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldShowGuide,rememberGuide,guidePosition} from '../src/onboarding.js';

function storage(){const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};}

test('新账号没有课堂时显示导引，已有课堂和未登录时不打扰',()=>{
  const local=storage();
  assert.equal(shouldShowGuide('new-user',0,local),true);
  assert.equal(shouldShowGuide('returning-user',1,local),false);
  assert.equal(shouldShowGuide(null,0,local),false);
});

test('完成或跳过后记住选择，各账号独立',()=>{
  const local=storage();
  rememberGuide('alice',local);
  assert.equal(shouldShowGuide('alice',0,local),false);
  assert.equal(shouldShowGuide('bob',0,local),true);
});

test('存储不可用不阻断导引和关闭',()=>{
  const local={getItem(){throw new Error('unavailable');},setItem(){throw new Error('unavailable');}};
  assert.equal(shouldShowGuide('alice',0,local),true);
  assert.doesNotThrow(()=>rememberGuide('alice',local));
});

test('桌面浮层紧邻目标，靠右侧的目标使用左侧空间',()=>{
  const viewport={width:1280,height:720},bubble={width:320,height:236};
  const left=guidePosition({left:300,top:650,right:400,bottom:690,width:100,height:40},viewport,bubble);
  assert.equal(left.placement,'right');
  assert.equal(left.left,416);
  assert.ok(left.top+236<=708);
  const right=guidePosition({left:1170,top:20,right:1260,bottom:60,width:90,height:40},viewport,bubble);
  assert.equal(right.placement,'left');
  assert.equal(right.left,834);
  assert.ok(right.top>=12);
});

test('手机浮层位于目标上方或下方，并保留边距',()=>{
  const viewport={width:390,height:844},bubble={width:320,height:260};
  const bottom=guidePosition({left:16,top:740,right:374,bottom:804,width:358,height:64},viewport,bubble);
  assert.equal(bottom.placement,'above');
  assert.ok(bottom.top+260<740);
  const top=guidePosition({left:80,top:20,right:180,bottom:52,width:100,height:32},viewport,bubble);
  assert.equal(top.placement,'below');
  assert.ok(top.left>=12);
  assert.ok(top.left+top.width<=378);
});

test('窄屏及键盘缩小视口时，浮层留在可见范围',()=>{
  for(const viewport of [{width:280,height:230},{width:390,height:300,left:0,top:120}]){
    const layout=guidePosition({left:10,top:200,right:270,bottom:240,width:260,height:40},viewport,{width:320,height:300});
    assert.ok(layout.left>=(viewport.left??0)+12);
    assert.ok(layout.left+layout.width<=(viewport.left??0)+viewport.width-12);
    assert.ok(layout.top>=(viewport.top??0)+12);
    assert.ok(layout.top+Math.min(300,layout.maxHeight)<=(viewport.top??0)+viewport.height-12);
  }
});
